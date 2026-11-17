import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, supplier, newOrder, sendEvent, retry, order, supplierOrders, setMode, reaches, confirmed, workerRan } from './helpers.mjs';

const faulted = new Set();
async function fault(ref, mode) {
  faulted.add(ref);
  await setMode(ref, mode);
}
test.after(async () => {
  // Leave no fault behind, so nothing keeps failing for these orders later.
  for (const ref of faulted) await setMode(ref, 'normal');
  await pool.end();
});

test('reply lost after acceptance: pending, never failed, then confirmed with the original id by itself', async () => {
  const id = await newOrder('SUP');
  await fault(id, 'accept_then_disconnect_once');
  const response = await sendEvent(`evt-${id}`, id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fulfillment_status, 'pending');
  const atSupplier = await supplierOrders(id);
  assert.equal(atSupplier.length, 1, 'the supplier accepted the first request before hanging up');
  const row = await order(id);
  // The worker may have finished it already; until then the outcome is recorded as unknown.
  if (row.fulfillment_status === 'pending') {
    assert.equal(row.supplier_order_id, null);
    assert.match(row.last_error, /outcome unknown/);
  } else {
    assert.equal(row.fulfillment_status, 'confirmed');
  }
  const done = await confirmed(id);
  assert.equal(done.supplier_order_id, atSupplier[0].supplier_order_id);
  assert.equal((await supplierOrders(id)).length, 1);
});

test('supplier unavailable: pending with the 503 recorded, confirmed by itself once it is back', async () => {
  const id = await newOrder('SUP');
  await fault(id, 'unavailable');
  const response = await sendEvent(`evt-${id}`, id);
  assert.equal((await response.json()).fulfillment_status, 'pending');
  const row = await order(id);
  assert.match(row.last_error, /503/);
  assert.ok(row.attempts >= 1);
  assert.equal((await supplierOrders(id)).length, 0);
  await setMode(id, 'normal');
  const done = await confirmed(id);
  const atSupplier = await supplierOrders(id);
  assert.equal(atSupplier.length, 1);
  assert.equal(done.supplier_order_id, atSupplier[0].supplier_order_id);
});

test('definite rejection: rejected without a supplier id, never retried, and later notices keep it rejected', async () => {
  const id = await newOrder('SUP');
  await fault(id, 'reject');
  assert.equal((await sendEvent(`evt-${id}`, id)).status, 200);
  await reaches(id, 'rejected');
  assert.equal((await (await sendEvent(`evt-${id}`, id)).json()).fulfillment_status, 'rejected');
  assert.equal((await (await sendEvent(`evt-${id}-other`, id)).json()).fulfillment_status, 'rejected');
  await workerRan();
  const row = await order(id);
  assert.equal(row.fulfillment_status, 'rejected');
  assert.equal(row.supplier_order_id, null);
  assert.match(row.last_error, /422/);
  assert.equal(row.attempts, 1, 'neither the worker nor a later notice tried again');
  assert.equal((await supplierOrders(id)).length, 0);
});

test('overlapping requests for one order (replays, new events, retries): one supplier order', async () => {
  // Several orders, each hit by one burst, so a race still shows if one burst happens to run in sequence.
  for (let round = 0; round < 5; round++) {
    const id = await newOrder('SUP');
    const responses = await Promise.all([
      sendEvent(`evt-${id}-a`, id), sendEvent(`evt-${id}-a`, id), sendEvent(`evt-${id}-b`, id), retry(id), retry(id)
    ]);
    for (const response of responses) assert.equal(response.status, 200);
    const done = await confirmed(id);
    const atSupplier = await supplierOrders(id);
    assert.equal(atSupplier.length, 1, `${id} has ${atSupplier.length} supplier orders`);
    assert.equal(done.supplier_order_id, atSupplier[0].supplier_order_id);
  }
});

test('the supplier holds the order under its stable key vendhub-order-<id>', async () => {
  const id = await newOrder('SUP');
  await sendEvent(`evt-${id}`, id);
  const done = await confirmed(id);
  // Business API replay: the same key and payload return the original order and create nothing.
  const replay = await fetch(`${supplier}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `vendhub-order-${id}` },
    body: JSON.stringify({ order_ref: id, sku: 'COFFEE-CASE', quantity: 1 })
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).supplier_order_id, done.supplier_order_id);
  assert.equal((await supplierOrders(id)).length, 1);
});
