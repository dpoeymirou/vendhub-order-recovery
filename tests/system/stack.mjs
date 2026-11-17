import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Drives the Compose stack from the host. Needs only Docker and Node built-ins, no npm install.
const run = promisify(execFile);
const projectDir = fileURLToPath(new URL('../..', import.meta.url));
export const app1 = 'http://localhost:3000';
export const app2 = 'http://localhost:3002';
const supplier = 'http://localhost:4001';

export async function compose(args, env = {}) {
  const { stdout } = await run('docker', ['compose', ...args], {
    cwd: projectDir,
    env: { ...process.env, CRASH_AFTER_SUPPLIER_SUCCESS: '0', ...env },
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout.trim();
}
const sql = query => compose(['exec', '-T', 'db', 'psql', '-U', 'exercise', '-d', 'exercise', '-Atc', query]);

// Every test works on its own new order, so runs are repeatable and seeds stay untouched.
const tag = randomUUID().slice(0, 8);
let count = 0;
export async function newOrders(n) {
  const ids = Array.from({ length: n }, () => `SYS-${tag}-${++count}`);
  await sql(`INSERT INTO orders (id, sku, quantity) VALUES ${ids.map(id => `('${id}', 'COFFEE-CASE', 1)`).join(', ')}`);
  return ids;
}
export const newOrder = async () => (await newOrders(1))[0];

const post = (base, path, payload) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload ?? {}),
  signal: AbortSignal.timeout(5000)
});
export const sendEvent = (base, eventId, orderId) => post(base, '/payment-events', { event_id: eventId, order_id: orderId, type: 'payment.succeeded' });
export const retry = (base, orderId) => post(base, `/orders/${orderId}/retry`);
export async function orderVia(base, id) {
  const rows = await (await fetch(`${base}/orders`, { signal: AbortSignal.timeout(5000) })).json();
  return rows.find(row => row.id === id);
}
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

// Polls with a deadline. Errors count as "not yet", because the app may be restarting.
export async function until(check, what, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Timed out after ${ms} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
export const confirmedVia = (base, id, ms) => until(async () => {
  const row = await orderVia(base, id);
  return row?.fulfillment_status === 'confirmed' && row;
}, `${id} to be confirmed via ${base}`, ms);

// Recreates the first app instance with the crash switch on or off, and waits until healthy.
export const restartApp1 = ({ crash = false } = {}) =>
  compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', '-t', '1', 'app'], { CRASH_AFTER_SUPPLIER_SUCCESS: crash ? '1' : '0' });
export const killApp1 = () => compose(['kill', 'app']);
export const startApp1 = () => compose(['up', '-d', '--no-deps', '--wait', 'app']);
export async function app1ExitCode() {
  const [state, code] = (await compose(['ps', '-a', '--format', '{{.State}} {{.ExitCode}}', 'app'])).split(/\s+/);
  return state === 'exited' ? Number(code) : null;
}

// How many supplier calls both app instances logged for one order.
export async function supplierCalls(id) {
  const logs = await compose(['logs', '--no-log-prefix', 'app', 'app2']);
  return logs.split('\n').filter(line => line.includes(`Supplier attempt for ${id}:`)).length;
}

// Crash tests need a quiet database: an app with the crash switch on would otherwise stop
// on another order's success the moment it starts.
export const noPendingWork = () =>
  until(async () => (await sql("SELECT count(*) FROM orders WHERE fulfillment_status = 'pending'")) === '0', 'no pending orders', 20000);
