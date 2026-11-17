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

async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Which statuses each kind of request may (re)start. A repeated payment notice
// is not new information, so it never reopens a final outcome; an operator
// retry may. 'failed' only exists in rows left by the old code, whose random
// supplier key was never stored, so only an operator should restart those.
const startableByEvent = ['not_submitted', 'pending'];
const startableByOperator = ['not_submitted', 'pending', 'rejected', 'failed'];

// Durably records that the order must be submitted, and makes it due now.
// The supplier request key is derived from the order and written only once.
async function requestSubmission(db: pg.Pool | pg.PoolClient, id: string, startable: string[]) {
  await db.query(
    `UPDATE orders SET fulfillment_status = 'pending',
       supplier_request_key = COALESCE(supplier_request_key, 'vendhub-order-' || id),
       next_attempt_at = now(), updated_at = now()
     WHERE id = $1 AND fulfillment_status = ANY($2)`,
    [id, startable]
  );
}

async function orderStatus(id: string) {
  const { rows } = await pool.query('SELECT id AS order_id, fulfillment_status, supplier_order_id FROM orders WHERE id = $1', [id]);
  return rows[0];
}

// One immediate attempt so a healthy request completes quickly. The recorded
// 'pending' state, not this attempt, is the source of truth.
async function attemptNow(id: string) {
  if ((await orderStatus(id)).fulfillment_status === 'pending') await submitOrder(id).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/orders') {
      return json(res, 200, (await pool.query('SELECT * FROM orders ORDER BY id')).rows);
    }
    if (req.method === 'POST' && url.pathname === '/payment-events') {
      let input: any;
      try { input = (await body(req)) ?? {}; } catch { return json(res, 400, { error: 'Expected a JSON body of at most 16 KB' }); }
      if (typeof input.event_id !== 'string' || !input.event_id.trim() || typeof input.order_id !== 'string' || input.type !== 'payment.succeeded') {
        return json(res, 400, { error: 'Expected event_id, order_id and type payment.succeeded' });
      }
      if (!(await pool.query('SELECT 1 FROM orders WHERE id = $1', [input.order_id])).rowCount) return json(res, 404, { error: 'Unknown order' });
      // The notice and the submission request are recorded together, or not at all.
      const isNew = await inTransaction(async client => {
        const inserted = await client.query('INSERT INTO payment_events(event_id, order_id) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', [input.event_id, input.order_id]);
        await requestSubmission(client, input.order_id, startableByEvent);
        return inserted.rowCount === 1;
      });
      await attemptNow(input.order_id);
      const status = await orderStatus(input.order_id);
      return json(res, 200, isNew ? { accepted: true, ...status } : { duplicate: true, ...status });
    }
    const retry = url.pathname.match(/^\/orders\/([^/]+)\/retry$/);
    if (req.method === 'POST' && retry) {
      const id = decodeURIComponent(retry[1]);
      if (!(await pool.query('SELECT 1 FROM orders WHERE id = $1', [id])).rowCount) return json(res, 404, { error: 'Unknown order' });
      await requestSubmission(pool, id, startableByOperator);
      await attemptNow(id);
      return json(res, 200, { accepted: true, ...(await orderStatus(id)) });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 500, { error: String(error) }); }
});
server.listen(port, '0.0.0.0', () => console.log(`Application listening on ${port}`));
process.on('SIGTERM', () => { server.close(); void pool.end().then(() => process.exit(0)); });
