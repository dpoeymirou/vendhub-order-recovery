import test from 'node:test';
import assert from 'node:assert/strict';
import { pool, newOrder, order, supplierOrders, markPending, confirmed, workerRan } from './helpers.mjs';

test.after(() => pool.end());

// Puts a due pending order under a row lock held by `holder`, like a second app in the
// middle of a supplier call. Uses a fresh order if the worker happened to take it first.
async function lockedPendingOrder(holder) {
  for (let tries = 0; tries < 5; tries++) {
    const id = await newOrder('WRK');
    await markPending(id);
    await holder.query('BEGIN');
    const { rows } = await holder.query(
      "SELECT attempts FROM orders WHERE id = $1 AND fulfillment_status = 'pending' FOR NO KEY UPDATE NOWAIT", [id]
    ).catch(() => ({ rows: [] }));
    if (rows[0]?.attempts === 0) return id;
    await holder.query('ROLLBACK');
  }
  assert.fail('could not lock a fresh pending order before the worker took it');
}

test('the worker finishes a pending order that no request ever tried', async () => {
  const id = await newOrder('WRK');
  await markPending(id);
  const done = await confirmed(id);
  const atSupplier = await supplierOrders(id);
  assert.equal(atSupplier.length, 1);
  assert.equal(done.supplier_order_id, atSupplier[0].supplier_order_id);
});

test('an order locked by another attempt is skipped, then finished once released', async () => {
  const holder = await pool.connect();
  let id;
  try {
    id = await lockedPendingOrder(holder);
    // The worker confirms a later order while this earlier one is held: it skipped it.
    await workerRan();
    assert.equal((await supplierOrders(id)).length, 0);
    assert.equal((await order(id)).fulfillment_status, 'pending');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  const done = await confirmed(id);
  const atSupplier = await supplierOrders(id);
  assert.equal(atSupplier.length, 1);
  assert.equal(done.supplier_order_id, atSupplier[0].supplier_order_id);
});

test('an order nobody asked to submit stays not_submitted while the worker runs', async () => {
  const id = await newOrder('WRK');
  await workerRan();
  const row = await order(id);
  assert.equal(row.fulfillment_status, 'not_submitted');
  assert.equal(row.supplier_request_key, null);
  assert.equal((await supplierOrders(id)).length, 0);
});
