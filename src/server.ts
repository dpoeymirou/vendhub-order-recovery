import http from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://exercise:exercise@localhost:55432/exercise' });
const supplierUrl = process.env.SUPPLIER_URL ?? 'http://localhost:4001';
const port = Number(process.env.PORT ?? 3000);

function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function body(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16384) throw new Error('Request too large');
  }
  return JSON.parse(raw || '{}');
}

// Existing implementation. Investigate and replace or refactor as needed.
async function submitOrder(id: string) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  const order = rows[0];
  if (!order) throw new Error('Unknown order');
  if (order.fulfillment_status === 'confirmed') return;
  try {
    const response = await fetch(`${supplierUrl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ order_ref: order.id, sku: order.sku, quantity: order.quantity }),
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) throw new Error(`Supplier returned ${response.status}`);
    const result = await response.json() as { supplier_order_id: string };
    // Keep this evaluation checkpoint immediately after supplier success and
    // before local confirmation. It simulates an unexpected process exit.
    if (process.env.CRASH_AFTER_SUPPLIER_SUCCESS === '1') process.exit(91);
    await pool.query(
      "UPDATE orders SET fulfillment_status = 'confirmed', supplier_order_id = $2, last_error = NULL, updated_at = now() WHERE id = $1",
      [id, result.supplier_order_id]
    );
  } catch (error) {
    await pool.query(
      "UPDATE orders SET fulfillment_status = 'failed', last_error = $2, updated_at = now() WHERE id = $1",
      [id, String(error)]
    );
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/orders') {
      return json(res, 200, (await pool.query('SELECT * FROM orders ORDER BY id')).rows);
    }
    if (req.method === 'POST' && url.pathname === '/payment-events') {
      const input = await body(req);
      if (typeof input.event_id !== 'string' || !input.event_id.trim() || typeof input.order_id !== 'string' || input.type !== 'payment.succeeded') {
        return json(res, 400, { error: 'Expected event_id, order_id and type payment.succeeded' });
      }
      if (!(await pool.query('SELECT 1 FROM orders WHERE id = $1', [input.order_id])).rowCount) return json(res, 404, { error: 'Unknown order' });
      const inserted = await pool.query('INSERT INTO payment_events(event_id, order_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id', [input.event_id, input.order_id]);
      if (!inserted.rowCount) return json(res, 200, { duplicate: true });
      await submitOrder(input.order_id);
      return json(res, 200, { accepted: true });
    }
    const retry = url.pathname.match(/^\/orders\/([^/]+)\/retry$/);
    if (req.method === 'POST' && retry) {
      const id = decodeURIComponent(retry[1]);
      if (!(await pool.query('SELECT 1 FROM orders WHERE id = $1', [id])).rowCount) return json(res, 404, { error: 'Unknown order' });
      await submitOrder(id);
      return json(res, 200, { accepted: true });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 500, { error: String(error) }); }
});
server.listen(port, '0.0.0.0', () => console.log(`Application listening on ${port}`));
process.on('SIGTERM', () => { server.close(); void pool.end().then(() => process.exit(0)); });
