import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export const app = process.env.APP_URL ?? 'http://localhost:3000';
export const supplier = process.env.SUPPLIER_URL ?? 'http://localhost:4001';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://exercise:exercise@localhost:55432/exercise' });

// Every test works on its own new order, so runs are repeatable and seeds stay untouched.
const tag = randomUUID().slice(0, 8);
let count = 0;
export const unique = prefix => `${prefix}-${tag}-${++count}`;
export async function newOrder(prefix) {
  const id = unique(prefix);
  await pool.query("INSERT INTO orders (id, sku, quantity) VALUES ($1, 'COFFEE-CASE', 1)", [id]);
  return id;
}

export const post = (path, payload) => fetch(`${app}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
});
export const sendEvent = (eventId, orderId) => post('/payment-events', { event_id: eventId, order_id: orderId, type: 'payment.succeeded' });
export const retry = orderId => post(`/orders/${encodeURIComponent(orderId)}/retry`);
export const order = async id => (await pool.query('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
export const supplierOrders = async ref => (await fetch(`${supplier}/orders?order_ref=${encodeURIComponent(ref)}`)).json();

// Test setup only: choose the supplier fixture's fault mode for one order.
export async function setMode(ref, mode) {
  const response = await fetch(`${supplier}/_test/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order_ref: ref, mode })
  });
  assert.ok(response.ok, `setting supplier mode ${mode} for ${ref} failed with ${response.status}`);
}

export async function reaches(id, status, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await order(id);
    if (row.fulfillment_status === status) return row;
    if (Date.now() > deadline) assert.fail(`${id} not ${status} within ${ms} ms: status ${row.fulfillment_status}, last error ${row.last_error}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
export const confirmed = (id, ms) => reaches(id, 'confirmed', ms);

// Test setup in our own database: the state a payment request leaves behind, as if
// the app had died before trying. Only the worker can finish such an order.
export async function markPending(id) {
  await pool.query("UPDATE orders SET fulfillment_status = 'pending', supplier_request_key = 'vendhub-order-' || id, next_attempt_at = now() WHERE id = $1", [id]);
}

// Evidence that the worker has been running: nothing else can confirm such an order.
export async function workerRan() {
  const id = await newOrder('WRK');
  await markPending(id);
  await confirmed(id);
}
