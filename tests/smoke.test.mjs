import test from 'node:test';
import assert from 'node:assert/strict';
const app = process.env.APP_URL ?? 'http://localhost:3000';
test('application is reachable', async () => {
  assert.equal((await fetch(`${app}/health`)).status, 200);
});
test('seeded orders can be inspected', async () => {
  const response = await fetch(`${app}/orders`);
  assert.equal(response.status, 200);
  const rows = await response.json();
  assert.ok(rows.some(row => row.id === 'ORD-1001'));
  assert.ok(rows.some(row => row.id === 'ORD-1002'));
});
