import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const run = promisify(execFile);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://exercise:exercise@localhost:55432/exercise' });
const setup = () => run(process.execPath, ['scripts/setup.mjs'], { env: process.env });
const tag = randomUUID().slice(0, 8);
const mine = [`MIG-${tag}-1`, `MIG-${tag}-2`];
test.after(async () => {
  await pool.query('DELETE FROM orders WHERE id = ANY($1)', [mine]); // only this test's own rows
  await pool.end();
});

test('setup is safe to run several times at once and keeps existing rows', async () => {
  await pool.query("INSERT INTO orders (id, sku, quantity, fulfillment_status, supplier_order_id) VALUES ($1, 'COFFEE-CASE', 2, 'confirmed', 'SUP-keep')", [mine[0]]);
  await Promise.all([setup(), setup(), setup()]);
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [mine[0]]);
  assert.equal(rows[0].fulfillment_status, 'confirmed');
  assert.equal(rows[0].supplier_order_id, 'SUP-keep');
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].supplier_request_key, null);
  assert.equal(rows[0].next_attempt_at, null);
});

test('confirmed without a supplier order id is rejected by the database', async () => {
  await assert.rejects(
    pool.query("INSERT INTO orders (id, sku, quantity, fulfillment_status) VALUES ($1, 'COFFEE-CASE', 1, 'confirmed')", [mine[1]]),
    { code: '23514' }
  );
});

test('one supplier request key cannot belong to two orders', async () => {
  const key = `vendhub-order-${tag}`;
  await pool.query("UPDATE orders SET supplier_request_key = $2 WHERE id = $1", [mine[0], key]);
  await pool.query("INSERT INTO orders (id, sku, quantity) VALUES ($1, 'COFFEE-CASE', 1)", [mine[1]]);
  await assert.rejects(pool.query('UPDATE orders SET supplier_request_key = $2 WHERE id = $1', [mine[1], key]), { code: '23505' });
});
