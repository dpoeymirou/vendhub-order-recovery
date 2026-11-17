import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const app = process.env.APP_URL ?? 'http://localhost:3000';
const supplier = process.env.SUPPLIER_URL ?? 'http://localhost:4001';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://exercise:exercise@localhost:55432/exercise' });
test.after(() => pool.end());

// Every test works on its own new order, so runs are repeatable and seeds stay untouched.
const tag = randomUUID().slice(0, 8);
let count = 0;
async function newOrder() {
  const id = `REQ-${tag}-${++count}`;
  await pool.query("INSERT INTO orders (id, sku, quantity) VALUES ($1, 'COFFEE-CASE', 1)", [id]);
  return id;
}
const post = (path, payload) => fetch(`${app}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
});
const sendEvent = (eventId, orderId) => post('/payment-events', { event_id: eventId, order_id: orderId, type: 'payment.succeeded' });
const order = async id => (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
const supplierOrders = async ref => (await fetch(`${supplier}/orders?order_ref=${encodeURIComponent(ref)}`)).json();
async function confirmed(id, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await order(id);
    if (row.fulfillment_status === 'confirmed') return row;
    if (Date.now() > deadline) assert.fail(`${id} not confirmed within ${ms} ms, status ${row.fulfillment_status}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test('unknown order: 404 and nothing recorded', async () => {
  const eventId = `evt-${tag}-unknown`;
  assert.equal((await sendEvent(eventId, `NOPE-${tag}`)).status, 404);
  assert.equal((await pool.query('SELECT 1 FROM payment_events WHERE event_id = $1', [eventId])).rowCount, 0);
  assert.equal((await post(`/orders/NOPE-${tag}/retry`)).status, 404);
});

test('malformed or invalid body: 400 and the order is not requested', async () => {
  const id = await newOrder();
  assert.equal((await post('/payment-events', '{not json')).status, 400);
  assert.equal((await post('/payment-events', 'null')).status, 400);
  assert.equal((await post('/payment-events', { event_id: `evt-${tag}-bad`, order_id: id, type: 'payment.failed' })).status, 400);
  const row = await order(id);
  assert.equal(row.fulfillment_status, 'not_submitted');
  assert.equal(row.supplier_request_key, null);
});

test('new event: stable key stored, order confirmed with the supplier id, one supplier order', async () => {
  const id = await newOrder();
  const response = await sendEvent(`evt-${tag}-new`, id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  const row = await confirmed(id);
  assert.equal(row.supplier_request_key, `vendhub-order-${id}`);
  const atSupplier = await supplierOrders(id);
  assert.equal(atSupplier.length, 1);
  assert.equal(row.supplier_order_id, atSupplier[0].supplier_order_id);
});

test('replayed event: reported as duplicate, no second supplier order', async () => {
  const id = await newOrder();
  await sendEvent(`evt-${tag}-replay`, id);
  await confirmed(id);
  const response = await sendEvent(`evt-${tag}-replay`, id);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.duplicate, true);
  assert.equal(payload.fulfillment_status, 'confirmed');
  assert.equal((await supplierOrders(id)).length, 1);
});

test('operator retry starts an order that was never requested', async () => {
  const id = await newOrder();
  const response = await post(`/orders/${id}/retry`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  const row = await confirmed(id);
  assert.equal(row.supplier_request_key, `vendhub-order-${id}`);
  assert.equal((await supplierOrders(id)).length, 1);
});

test('retry on a confirmed order changes nothing', async () => {
  const id = await newOrder();
  await sendEvent(`evt-${tag}-done`, id);
  const before = await confirmed(id);
  assert.equal((await post(`/orders/${id}/retry`)).status, 200);
  const after = await order(id);
  assert.equal(after.fulfillment_status, 'confirmed');
  assert.equal(after.supplier_order_id, before.supplier_order_id);
  assert.equal((await supplierOrders(id)).length, 1);
});

test('rejected order: a payment notice leaves it rejected, an operator retry restarts it', async () => {
  const id = await newOrder();
  // Setup in our own database: an order the supplier definitively rejected earlier.
  await pool.query("UPDATE orders SET fulfillment_status = 'rejected', supplier_request_key = 'vendhub-order-' || id, last_error = 'test setup' WHERE id = $1", [id]);
  const response = await sendEvent(`evt-${tag}-rejected`, id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fulfillment_status, 'rejected');
  assert.equal((await order(id)).fulfillment_status, 'rejected');
  assert.equal((await supplierOrders(id)).length, 0);
  assert.equal((await post(`/orders/${id}/retry`)).status, 200);
  await confirmed(id);
  assert.equal((await supplierOrders(id)).length, 1);
});
