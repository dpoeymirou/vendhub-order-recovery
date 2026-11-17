import test from 'node:test';
import assert from 'node:assert/strict';
import { app, pool, unique, newOrder, post, sendEvent, retry, order, supplierOrders, confirmed } from './helpers.mjs';

test.after(() => pool.end());

test('unknown order: 404 and nothing recorded', async () => {
  const eventId = unique('evt');
  const missing = unique('NOPE');
  assert.equal((await sendEvent(eventId, missing)).status, 404);
  assert.equal((await pool.query('SELECT 1 FROM payment_events WHERE event_id = $1', [eventId])).rowCount, 0);
  assert.equal((await retry(missing)).status, 404);
});

test('malformed or invalid body: 400 and the order is not requested', async () => {
  const id = await newOrder('REQ');
  assert.equal((await post('/payment-events', '{not json')).status, 400);
  assert.equal((await post('/payment-events', 'null')).status, 400);
  assert.equal((await post('/payment-events', { event_id: unique('evt'), order_id: id, type: 'payment.failed' })).status, 400);
  const row = await order(id);
  assert.equal(row.fulfillment_status, 'not_submitted');
  assert.equal(row.supplier_request_key, null);
});

test('new event: stable key stored, order confirmed with the supplier id, one supplier order', async () => {
  const id = await newOrder('REQ');
  const response = await sendEvent(`evt-${id}`, id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  const row = await confirmed(id);
  assert.equal(row.supplier_request_key, `vendhub-order-${id}`);
  const atSupplier = await supplierOrders(id);
  assert.equal(atSupplier.length, 1);
  assert.equal(row.supplier_order_id, atSupplier[0].supplier_order_id);
});

test('replayed event: reported as duplicate, no second supplier order', async () => {
  const id = await newOrder('REQ');
  await sendEvent(`evt-${id}`, id);
  await confirmed(id);
  const response = await sendEvent(`evt-${id}`, id);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.duplicate, true);
  assert.equal(payload.fulfillment_status, 'confirmed');
  assert.equal((await supplierOrders(id)).length, 1);
});

test('GET /orders keeps the basic fields and shows the submission state', async () => {
  const id = await newOrder('REQ');
  await sendEvent(`evt-${id}`, id);
  await confirmed(id);
  const row = (await (await fetch(`${app}/orders`)).json()).find(candidate => candidate.id === id);
  for (const field of ['id', 'sku', 'quantity', 'payment_status', 'fulfillment_status', 'supplier_order_id', 'last_error',
    'supplier_request_key', 'attempts', 'next_attempt_at']) {
    assert.ok(field in row, `GET /orders is missing ${field}`);
  }
  assert.equal(row.fulfillment_status, 'confirmed');
  assert.equal(row.supplier_request_key, `vendhub-order-${id}`);
  assert.equal(row.supplier_order_id, (await supplierOrders(id))[0].supplier_order_id);
});

test('operator retry starts an order that was never requested', async () => {
  const id = await newOrder('REQ');
  const response = await retry(id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  const row = await confirmed(id);
  assert.equal(row.supplier_request_key, `vendhub-order-${id}`);
  assert.equal((await supplierOrders(id)).length, 1);
});

test('retry on a confirmed order changes nothing', async () => {
  const id = await newOrder('REQ');
  await sendEvent(`evt-${id}`, id);
  const before = await confirmed(id);
  assert.equal((await retry(id)).status, 200);
  const after = await order(id);
  assert.equal(after.fulfillment_status, 'confirmed');
  assert.equal(after.supplier_order_id, before.supplier_order_id);
  assert.equal((await supplierOrders(id)).length, 1);
});

test('rejected order: a payment notice leaves it rejected, an operator retry restarts it', async () => {
  const id = await newOrder('REQ');
  // Setup in our own database: an order the supplier definitively rejected earlier.
  await pool.query("UPDATE orders SET fulfillment_status = 'rejected', supplier_request_key = 'vendhub-order-' || id, last_error = 'test setup' WHERE id = $1", [id]);
  const response = await sendEvent(`evt-${id}`, id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fulfillment_status, 'rejected');
  assert.equal((await order(id)).fulfillment_status, 'rejected');
  assert.equal((await supplierOrders(id)).length, 0);
  assert.equal((await retry(id)).status, 200);
  await confirmed(id);
  assert.equal((await supplierOrders(id)).length, 1);
});
