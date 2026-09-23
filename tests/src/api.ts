import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, stack } from './stack';
import { poll } from './durable';

export const EVENT_ID = 'coffee-shop';

/** Calls the REST API the same way the frontend's api.ts does. */
export async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const { apiUrl } = await stack();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export async function placeOrder(attendeeId: string, drinkType = 'Latte', size = 'Medium', eventId = EVENT_ID) {
  const res = await call('POST', '/orders', { attendeeId, eventId, orderDetails: { drinkType, size } });
  return { status: res.status, orderId: res.body.orderId as string, body: res.body };
}

export async function order(orderId: string) {
  const { ordersTable } = await stack();
  const res = await ddb.send(new GetCommand({ TableName: ordersTable, Key: { orderId } }));
  return res.Item;
}

export async function waitForOrder(orderId: string, match: (o: Record<string, any>) => boolean, what: string, timeoutMs = 30000) {
  return poll(async () => {
    const item = await order(orderId);
    return item && match(item) ? item : undefined;
  }, what, timeoutMs);
}

/** Sets the store state in the config table directly, so tests don't depend on each other. */
export async function setStoreOpen(storeOpen: boolean) {
  const { configTable } = await stack();
  await ddb.send(new UpdateCommand({
    TableName: configTable,
    Key: { eventId: EVENT_ID },
    UpdateExpression: 'SET storeOpen = :o',
    ExpressionAttributeValues: { ':o': storeOpen },
  }));
}

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
