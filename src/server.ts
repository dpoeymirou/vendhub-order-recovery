import http from 'node:http';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://exercise:exercise@localhost:55432/exercise',
  // A vanished app host must not hold row locks for long: Postgres ends any
  // transaction left idle for 10 s. A supplier call is bounded at 2 s.
  options: '-c idle_in_transaction_session_timeout=10s'
});
// A dropped idle connection (for example a database restart) must not crash the app.
pool.on('error', error => console.error(`Idle database connection lost: ${error.message}`));
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

type SupplierOutcome =
  | { kind: 'accepted'; supplierOrderId: string }
  | { kind: 'rejected'; error: string }
  | { kind: 'retry'; error: string };

// Calls the supplier with the order's stored request key and sorts the answer the
// way SUPPLIER_API.md defines it. Supplier problems are returned, never thrown.
async function callSupplier(order: { id: string; sku: string; quantity: number; supplier_request_key: string }): Promise<SupplierOutcome> {
  try {
    const response = await fetch(`${supplierUrl}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': order.supplier_request_key },
      body: JSON.stringify({ order_ref: order.id, sku: order.sku, quantity: order.quantity }),
      signal: AbortSignal.timeout(2000)
    });
    const text = await response.text();
    if (response.status === 201 || response.status === 200) {
      // 200 is a replay of our key: the supplier returns the order it already has. The contract
      // names supplier_order_id only for 201; we assume the replay uses the same field.
      const supplierOrderId = JSON.parse(text).supplier_order_id;
      if (typeof supplierOrderId === 'string' && supplierOrderId) return { kind: 'accepted', supplierOrderId };
      return { kind: 'retry', error: `Supplier answered ${response.status} without an order id, outcome unknown` };
    }
    if (response.status === 422) return { kind: 'rejected', error: `Supplier rejected the order (422): ${text.slice(0, 200)}` };
    // 503 means nothing was created; no other answer is defined as final by the contract.
    return { kind: 'retry', error: `Supplier answered ${response.status}: ${text.slice(0, 200)}` };
  } catch (error) {
    // Timeout or dropped connection: the supplier may or may not have the order.
    const cause = (error as { cause?: Error }).cause?.message;
    return { kind: 'retry', error: `No complete answer from supplier, outcome unknown: ${String(error)}${cause ? ` (${cause})` : ''}` };
  }
}

// Writes the outcome of one supplier call, inside the attempt's locked transaction.
// Every write is conditional, so a late or overlapping attempt can never undo a final state.
async function recordOutcome(db: pg.PoolClient, id: string, outcome: SupplierOutcome) {
  if (outcome.kind === 'accepted') {
    // The supplier holds an order under our key. That is the truth, even if an
    // earlier request for this order was rejected.
    await db.query(
      `UPDATE orders SET fulfillment_status = 'confirmed', supplier_order_id = $2, last_error = NULL,
         attempts = attempts + 1, next_attempt_at = NULL, updated_at = now()
       WHERE id = $1 AND fulfillment_status <> 'confirmed'`,
      [id, outcome.supplierOrderId]
    );
  } else if (outcome.kind === 'rejected') {
    await db.query(
      `UPDATE orders SET fulfillment_status = 'rejected', last_error = $2,
         attempts = attempts + 1, next_attempt_at = NULL, updated_at = now()
       WHERE id = $1 AND fulfillment_status = 'pending'`,
      [id, outcome.error]
    );
  } else {
    // Stay pending and wait 0.5 s longer after each unresolved attempt, at most 2 s.
    await db.query(
      `UPDATE orders SET last_error = $2, attempts = attempts + 1,
         next_attempt_at = now() + LEAST(attempts + 1, 4) * interval '500 milliseconds', updated_at = now()
       WHERE id = $1 AND fulfillment_status = 'pending'`,
      [id, outcome.error]
    );
  }
}

// One supplier attempt for a due pending order: the given one, or the next one due.
// Its row lock is held until the outcome is written, so another process skips the
// order instead of calling the supplier for it at the same time. If this process
// dies, Postgres releases the lock and the order is simply still pending.
// Repeating an attempt is safe: with the same key the supplier returns the original order.
async function attemptNext(onlyId: string | null = null): Promise<boolean> {
  return inTransaction(async client => {
    const { rows } = await client.query(
      `SELECT * FROM orders
       WHERE fulfillment_status = 'pending' AND next_attempt_at <= now() AND ($1::text IS NULL OR id = $1)
       ORDER BY next_attempt_at LIMIT 1
       FOR NO KEY UPDATE SKIP LOCKED`,
      [onlyId]
    );
    const order = rows[0];
    if (!order) return false;
    const outcome = await callSupplier(order);
    // Keep this evaluation checkpoint immediately after supplier success and
    // before local confirmation. It simulates an unexpected process exit.
    if (outcome.kind === 'accepted' && process.env.CRASH_AFTER_SUPPLIER_SUCCESS === '1') process.exit(91);
    await recordOutcome(client, order.id, outcome);
    console.log(`Supplier attempt for ${order.id}: ${outcome.kind === 'accepted' ? `accepted ${outcome.supplierOrderId}` : `${outcome.kind}, ${outcome.error}`}`);
    return true;
  });
}

async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // A connection lost while in use must not crash the app; the next query fails instead.
  const onError = (error: Error) => console.error(`Database connection lost: ${error.message}`);
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.off('error', onError);
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
  await attemptNext(id).catch(error => console.error(`Attempt for ${id} not recorded: ${String(error)}`));
}

// Background worker, one per app process. It is only a trigger: everything it
// needs is in the database, so any process can finish any order after a restart.
let stopping = false;
async function workLoop() {
  while (!stopping) {
    let found = false;
    try {
      found = await attemptNext();
    } catch (error) {
      console.error(`Worker attempt failed: ${String(error)}`);
    }
    if (!found) await new Promise(resolve => setTimeout(resolve, 500));
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
      let input: any;
      try { input = (await body(req)) ?? {}; } catch { return json(res, 400, { error: 'Expected a JSON body of at most 16 KB' }); }
      if (typeof input.event_id !== 'string' || !input.event_id.trim() || typeof input.order_id !== 'string' || input.type !== 'payment.succeeded') {
        return json(res, 400, { error: 'Expected event_id, order_id and type payment.succeeded' });
      }
      if (!(await pool.query('SELECT 1 FROM orders WHERE id = $1', [input.order_id])).rowCount) return json(res, 404, { error: 'Unknown order' });
      // The notice and the submission request are recorded together, or not at all.
      // The order row is updated first, so concurrent notices for one order wait on
      // that row instead of risking a lock-order deadlock with the event insert.
      const isNew = await inTransaction(async client => {
        await requestSubmission(client, input.order_id, startableByEvent);
        const inserted = await client.query('INSERT INTO payment_events(event_id, order_id) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', [input.event_id, input.order_id]);
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
const worker = workLoop();
// On a stop signal, finish the current attempt, then close. A hard stop is safe too.
process.on('SIGTERM', () => {
  stopping = true;
  server.close();
  void worker.then(() => pool.end()).then(() => process.exit(0));
});
