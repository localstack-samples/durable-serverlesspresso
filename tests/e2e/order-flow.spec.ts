// Happy-path smoke test of the frontend against LocalStack: an attendee orders, the barista
// accepts and completes, and both screens follow along over AppSync Events.
// The attendee and barista use separate browser contexts, like two devices. The app keeps
// shared state in localStorage, so two tabs of one profile interfere with each other.
import '../src/env';
import { test, expect } from '@playwright/test';
import { waitForOrder } from '../src/api';

test('attendee orders a coffee and the barista completes it', async ({ browser }) => {
  const baristaContext = await browser.newContext();
  const attendeeContext = await browser.newContext();

  const barista = await baristaContext.newPage();
  await barista.goto('/barista');
  await expect(barista.getByText('Barista Dashboard')).toBeVisible();

  const attendee = await attendeeContext.newPage();
  await attendee.goto('/attendee');
  await expect(attendee.getByRole('button', { name: /Select Drink|Place Order/ }),
    'The attendee view shows the latest pending order of the event. Run scripts/reset-demo.sh first.').toBeVisible();

  await attendee.getByRole('button', { name: /Cappuccino/ }).click();
  await attendee.getByRole('button', { name: '12 oz' }).click();
  const placed = attendee.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/orders'));
  await attendee.getByRole('button', { name: /Place Order/ }).click();
  const { orderId } = await (await placed).json();
  const shortId = orderId.slice(-8);

  // ORDER_QUEUED arrives over AppSync Events on both screens.
  await expect(attendee.getByText('IN QUEUE')).toBeVisible();
  const ticket = barista.locator('div', { hasText: new RegExp(`Order #${shortId}`, 'i') })
    .filter({ has: barista.getByRole('button', { name: 'Accept' }) }).last();
  await barista.bringToFront();
  await expect(ticket).toBeVisible();
  // The workflow publishes ORDER_QUEUED before it registers the acceptance callback, and the
  // callback handler drops actions that arrive earlier. A person is never that fast; the test is.
  await waitForOrder(orderId, (o) => o.currentPhase === 'WAITING_ACCEPTANCE', 'the acceptance callback');
  await ticket.getByRole('button', { name: 'Accept' }).click();

  // Accept goes API Gateway -> EventBridge -> callback handler -> durable callback.
  await attendee.bringToFront();
  await expect(attendee.getByText('PREPARING')).toBeVisible();

  await barista.bringToFront();
  const inProgress = barista.locator('div', { hasText: new RegExp(`Order #${shortId}`, 'i') })
    .filter({ has: barista.getByRole('button', { name: /Complete/ }) }).last();
  await expect(inProgress).toBeVisible();
  await waitForOrder(orderId, (o) => o.currentPhase === 'WAITING_COMPLETION', 'the completion callback');
  await inProgress.getByRole('button', { name: /Complete/ }).click();

  await attendee.bringToFront();
  await expect(attendee.getByText(/ready|completed/i).first()).toBeVisible();
  await waitForOrder(orderId, (o) => o.status === 'COMPLETED', 'COMPLETED in DynamoDB');

  await baristaContext.close();
  await attendeeContext.close();
});
