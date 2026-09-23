// End-to-end tests for the coffee-orders durable function, driven through the REST API like
// the frontend. Test names carry the workflow step, so `npm test -- -t accept` runs one part.
import { call, placeOrder, waitForOrder, setStoreOpen, uid, EVENT_ID } from '../src/api';
import { executionForOrder, waitForStatus, succeededSteps, history, configuredTimeouts, stopAllRunning } from '../src/durable';
import { RealtimeSubscriber } from '../src/realtime';
import { stack } from '../src/stack';

let realtime: RealtimeSubscriber;
const result = (res: { Result?: string }) => JSON.parse(res.Result ?? '{}');

beforeAll(async () => {
  const { appSyncHttpHost, appSyncApiKey } = await stack();
  realtime = await new RealtimeSubscriber(appSyncHttpHost, appSyncApiKey).connect();
  await realtime.subscribe('/coffee-ordering/barista/queue');
});
afterAll(async () => {
  realtime?.close();
  await stopAllRunning();
  await setStoreOpen(true);
});
beforeEach(async () => {
  await setStoreOpen(true);
});

/** Places an order and waits until the workflow is parked at the barista acceptance callback. */
async function queuedOrder(attendeeId = uid('attendee')) {
  const placed = await placeOrder(attendeeId);
  const item = await waitForOrder(placed.orderId, (o) => o.currentPhase === 'WAITING_ACCEPTANCE', 'WAITING_ACCEPTANCE');
  return { ...placed, attendeeId, item };
}

describe('Coffee order durable workflow', () => {
  test('[config] GET /config/{eventId} returns the seeded event', async () => {
    const res = await call('GET', `/config/${EVENT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ eventId: EVENT_ID, storeOpen: true, maxOrdersPerAttendee: 3 });
  });

  test('[place-order] POST /orders starts the durable function and returns 202', async () => {
    const { status, orderId, body } = await placeOrder(uid('attendee'));
    expect(status).toBe(202);
    expect(body).toMatchObject({ status: 'PENDING' });
    const execution = await executionForOrder(orderId);
    expect(execution.Status).toBe('RUNNING');
  });

  test('[validation] parallel validation passes and the order is queued for a barista', async () => {
    const { orderId, item } = await queuedOrder();
    expect(item).toMatchObject({ status: 'QUEUED', currentPhase: 'WAITING_ACCEPTANCE' });
    expect(item.activeCallbackId).toBe(item.callbackIds.acceptance);

    const { DurableExecutionArn } = await executionForOrder(orderId);
    expect(await succeededSteps(DurableExecutionArn!)).toEqual(expect.arrayContaining([
      'generate-timestamp', 'initialize-order', 'fetch-event-config', 'fetch-attendee-orders',
      'publish-order-placed', 'update-status-queued',
    ]));
    const events = await history(DurableExecutionArn!);
    expect(events.some((e) => e.EventType === 'ContextSucceeded' && e.Name === 'parallel-validation')).toBe(true);
  });

  test('[validation] a closed store cancels the order', async () => {
    await setStoreOpen(false);
    const { orderId } = await placeOrder(uid('attendee'));
    const item = await waitForOrder(orderId, (o) => o.status === 'CANCELLED', 'CANCELLED');
    expect(item).toMatchObject({ cancelledBy: 'system', cancellationReason: 'Store is currently closed' });
  });

  test('[validation] an unknown event cancels the order', async () => {
    const { orderId } = await placeOrder(uid('attendee'), 'Latte', 'Medium', 'no-such-event');
    const item = await waitForOrder(orderId, (o) => o.status === 'CANCELLED', 'CANCELLED');
    expect(item.cancelledBy).toBe('system');
    // The reason is "Store is currently closed", not "Event no-such-event does not exist", on AWS too:
    // BatchResult.getResults() skips branches that returned undefined, so results[0] is the order list.
  });

  test('[validation] the third open order of an attendee exceeds the daily limit of 3', async () => {
    // initialize-order writes the new order before the limit check, so it counts itself.
    const attendee = uid('attendee');
    for (let i = 0; i < 2; i++) await queuedOrder(attendee);
    const { orderId } = await placeOrder(attendee);
    const item = await waitForOrder(orderId, (o) => o.status === 'CANCELLED', 'CANCELLED');
    expect(item.cancellationReason).toBe('Daily limit of 3 orders exceeded (current: 3)');
  });

  test('[accept] POST /barista/accept resumes the workflow through EventBridge and the callback handler', async () => {
    const { orderId } = await queuedOrder();
    const res = await call('POST', `/barista/accept/${orderId}`, { baristaId: 'barista-1' });
    expect(res.status).toBe(200);

    const item = await waitForOrder(orderId, (o) => o.currentPhase === 'WAITING_COMPLETION', 'WAITING_COMPLETION');
    expect(item).toMatchObject({ status: 'ACCEPTED', baristaId: 'barista-1' });
    expect(item.callbackIds.completion).not.toBe(item.callbackIds.acceptance);
  });

  test('[complete] POST /barista/complete finishes the execution', async () => {
    const { orderId, attendeeId } = await queuedOrder();
    await call('POST', `/barista/accept/${orderId}`, { baristaId: 'barista-1' });
    await waitForOrder(orderId, (o) => o.currentPhase === 'WAITING_COMPLETION', 'WAITING_COMPLETION');
    await call('POST', `/barista/complete/${orderId}`, { baristaId: 'barista-1' });

    const item = await waitForOrder(orderId, (o) => o.status === 'COMPLETED', 'COMPLETED');
    expect(item.currentPhase).toBe('COMPLETED');
    const { DurableExecutionArn } = await executionForOrder(orderId);
    const done = await waitForStatus(DurableExecutionArn!, 'SUCCEEDED');
    expect(result(done)).toMatchObject({ orderId, status: 'COMPLETED', attendeeId, baristaId: 'barista-1' });

    const count = await call('GET', `/orders/count?attendeeId=${attendeeId}&eventId=${EVENT_ID}`);
    expect(count.body).toEqual({ count: 1 });
  });

  test('[cancel] POST /orders/{id}/cancel while waiting for a barista cancels the order', async () => {
    const { orderId } = await queuedOrder();
    await call('POST', `/orders/${orderId}/cancel`, { reason: 'Changed my mind', cancelledBy: 'attendee' });
    const item = await waitForOrder(orderId, (o) => o.status === 'CANCELLED', 'CANCELLED');
    expect(item).toMatchObject({ cancelledBy: 'attendee', cancellationReason: 'Changed my mind' });
    const { DurableExecutionArn } = await executionForOrder(orderId);
    expect(result(await waitForStatus(DurableExecutionArn!, 'SUCCEEDED'))).toMatchObject({ status: 'CANCELLED' });
  });

  test('[cancel] a barista can cancel an accepted order', async () => {
    const { orderId } = await queuedOrder();
    await call('POST', `/barista/accept/${orderId}`, { baristaId: 'barista-1' });
    await waitForOrder(orderId, (o) => o.currentPhase === 'WAITING_COMPLETION', 'WAITING_COMPLETION');
    await call('POST', `/orders/${orderId}/cancel`, { reason: 'Out of milk', cancelledBy: 'barista' });
    const item = await waitForOrder(orderId, (o) => o.status === 'CANCELLED', 'CANCELLED');
    expect(item).toMatchObject({ cancelledBy: 'barista', cancellationReason: 'Out of milk' });
  });

  test('[timeout] an order nobody accepts is cancelled by the system', async () => {
    const { acceptance } = await configuredTimeouts();
    if (acceptance > 60) {
      console.warn(`Skipping: acceptance timeout is ${acceptance}s. Deploy with --test-timeouts to run it.`);
      return;
    }
    const { orderId } = await queuedOrder();
    const item = await waitForOrder(orderId, (o) => o.status === 'CANCELLED', 'CANCELLED', (acceptance + 30) * 1000);
    expect(item).toMatchObject({ cancelledBy: 'system' });
    expect(item.cancellationReason).toMatch(/^Acceptance timeout/);
  });

  test('[timeout] an accepted order that is never completed is cancelled by the system', async () => {
    const { completion } = await configuredTimeouts();
    if (completion > 60) {
      console.warn(`Skipping: completion timeout is ${completion}s. Deploy with --test-timeouts to run it.`);
      return;
    }
    const { orderId } = await queuedOrder();
    await call('POST', `/barista/accept/${orderId}`, { baristaId: 'barista-1' });
    await waitForOrder(orderId, (o) => o.currentPhase === 'WAITING_COMPLETION', 'WAITING_COMPLETION');
    const item = await waitForOrder(orderId, (o) => o.status === 'CANCELLED', 'CANCELLED', (completion + 30) * 1000);
    expect(item.cancellationReason).toMatch(/^Completion timeout/);
  });

  test('[api] GET /orders?status=QUEUED lists queued orders', async () => {
    const { orderId } = await queuedOrder();
    const res = await call('GET', '/orders?status=QUEUED');
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o: any) => o.orderId)).toContain(orderId);
  });

  test('[api] GET /execution/history returns the history of a completed order', async () => {
    const { orderId } = await queuedOrder();
    await call('POST', `/barista/accept/${orderId}`, { baristaId: 'barista-1' });
    await waitForOrder(orderId, (o) => o.currentPhase === 'WAITING_COMPLETION', 'WAITING_COMPLETION');
    await call('POST', `/barista/complete/${orderId}`, { baristaId: 'barista-1' });
    await waitForOrder(orderId, (o) => o.status === 'COMPLETED', 'COMPLETED');

    const res = await call('GET', `/execution/history?orderId=${orderId}`);
    expect(res.status).toBe(200);
    const types = res.body.history.Events.map((e: any) => e.EventType);
    expect(types).toEqual(expect.arrayContaining(['ExecutionStarted', 'CallbackSucceeded', 'ExecutionSucceeded']));
  });

  test('[realtime] status changes reach the AppSync Events channels the frontend subscribes to', async () => {
    const placed = await placeOrder(uid('attendee'));
    const orderChannel = `/coffee-ordering/orders/${placed.orderId}`;
    await realtime.subscribe(orderChannel);

    await realtime.waitFor('/coffee-ordering/barista/queue', 'ORDER_QUEUED', placed.orderId);
    await waitForOrder(placed.orderId, (o) => o.currentPhase === 'WAITING_ACCEPTANCE', 'WAITING_ACCEPTANCE');
    await call('POST', `/barista/accept/${placed.orderId}`, { baristaId: 'barista-1' });
    await realtime.waitFor(orderChannel, 'ORDER_ACCEPTED', placed.orderId);
  });
});
