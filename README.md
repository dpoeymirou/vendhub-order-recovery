# VendHub: supplier order workflow, repaired

Every requested paid order now ends with **one supplier order** and a truthful local status, through repeated and overlapping requests, two app processes, timeouts, crashes and restarts.

## Root cause (starter `src/server.ts`)
- **Duplicates:** each attempt sent a new random `Idempotency-Key`, so the supplier saw every retry as a new order. Status was read and then acted on without a lock, so overlapping requests both submitted.
- **Missing orders:** the work lived only inside the HTTP request, and the event was stored as "seen" before submitting. After a 503 or a crash, a re-sent event answered `duplicate` and nothing retried; a crash after supplier success left the order `not_submitted`.
- **Wrong status:** unknown outcomes (timeouts, disconnects), 503 and 422 were all saved as `failed`, a dead end.

All three were reproduced before the fix, e.g. a lost reply plus a manual retry gave two supplier orders and saved the second ID.

## Approach
1. **The database is the to-do list.** The payment route saves the event (deduplicated by `event_id`) and marks the order `pending` in one transaction; the retry route marks it `pending` in one statement. The key `vendhub-order-<order id>` is written once and never changed.
2. **One attempt holds one row lock.** An attempt claims a due `pending` order with `FOR NO KEY UPDATE SKIP LOCKED`, calls the supplier (2 s timeout), writes the outcome and commits. Other processes skip a locked row; if the process dies, Postgres releases the lock.
3. **Outcomes follow the contract:** 201/200 with an ID → `confirmed`; 422 → `rejected`; 503, timeout, disconnect or any other answer → still `pending`, retried with the same key after 0.5 to 2 s.
4. **A worker in every process** polls every 500 ms; each request also makes one immediate attempt through the same claim. The crash checkpoint stays between supplier success and the confirmation write.
5. **Database rules:** `confirmed` needs a supplier order ID, `pending` needs a key, a key belongs to one order. The schema setup is additive, safe to rerun, and serialised with an advisory lock.

A payment event starts or resumes an order; an operator retry may also restart a `rejected` one (same key, so it cannot duplicate).

## Guarantees
| Guarantee | Rests on |
|---|---|
| At most one supplier order per order | the stable key and the supplier's replay guarantee, also for concurrent requests; the lock only avoids redundant calls |
| `confirmed` only with the ID the supplier returned | one writer, fed only by a 200/201 with an ID; a CHECK constraint |
| Requested, non-rejected orders finish without new input once faults clear | state in Postgres; the worker in any process; locks released when a process dies |
| `rejected` is distinct from unresolved work | only 422 rejects; anything else stays `pending` with `attempts` and `last_error` |
| Untouched orders are never sent | only `pending` rows are claimed, and only an event or a retry creates them |

**Assumptions beyond `SUPPLIER_API.md`:** the 200 replay body carries `supplier_order_id` like the 201 body (if not, orders stay `pending`, never wrongly confirmed), and the supplier normally answers within 2 s (slower answers count as unknown).

## Tests
- **In the app container**, `npm test` (23 tests): schema and constraints, request path and retry rules, recovery from a lost reply and an outage, rejection, overlapping requests, the stable key at the supplier, and the worker (locked orders skipped, untouched and seed orders never sent).
- **From the host**, `npm run test:system` (6 tests, about 40 s, needs only Docker and Node): two instances under overlapping requests (one supplier call and one order each), a lost reply across instances, a crash on one instance finished by the other, crash and restart without a new event, a restart during an outage, and a hard kill at a random moment in a stream of 50 notices.
- The request-path, supplier-outcome, worker and system tests were run against the code before their change, and most failed there (e.g. 5 supplier calls for one order without the lock; no recovery without the worker); the rest cover behaviour the old code already had. Supplier test controls only set up faults; supplier state is read only through its `GET /orders?order_ref=`.

## Run
```bash
docker compose up --build --wait            # db, supplier, app on :3000; schema setup runs on start
docker compose exec app npm test            # in-container suite
npm run test:system                         # from the host; not at the same time as the line above
docker compose up -d --build --wait app2    # second instance on :3002, same database and supplier
docker compose rm -sf app2                  # stop the second instance
curl -X POST localhost:3000/payment-events -H 'Content-Type: application/json' \
  -d '{"event_id":"evt-demo-1","order_id":"ORD-1001","type":"payment.succeeded"}'
curl 'localhost:4001/orders?order_ref=ORD-1001'   # what the supplier holds
```
- **Schema:** `npm run db:setup` runs before every start; safe to run twice or from two instances at once.
- **Environment:** `DATABASE_URL`, `SUPPLIER_URL`, `PORT`, and `CRASH_AFTER_SUPPLIER_SUCCESS=1`, which exits with code 91 after supplier success and before the local confirmation. In-container tests also read `APP_URL`.
- **Crash demo:** with no other order `pending`, run `CRASH_AFTER_SUPPLIER_SUCCESS=1 docker compose up -d --force-recreate app`, send an event for an untouched order, then `CRASH_AFTER_SUPPLIER_SUCCESS=0 docker compose up -d --force-recreate app`. The order becomes `confirmed` by itself with the same supplier ID.
- **Faults:** `curl -X POST localhost:4001/_test/mode -H 'Content-Type: application/json' -d '{"order_ref":"ORD-1002","mode":"unavailable"}'`; modes are listed in `SUPPLIER_API.md`.
- **Other ways:** the starter's foreground second instance `docker compose run --rm --no-deps -e PORT=3000 -p 127.0.0.1:3002:3000 app` also works (instead of `app2`). Without Docker (Node 24+): `docker compose up -d --wait db supplier`, `npm ci`, `npm run db:setup`, `npm start`; Docker is the tested path. `docker compose down -v` wipes data: only between clean test runs, never as recovery.

## Limitations
- The row lock is held during the supplier call (at most 2 s): one connection per in-flight order and one worker attempt at a time per process. At much higher volume: lease-based claims with a fencing token.
- No attempt cap, metrics or alerts; `rejected` orders need a human; a 409 (impossible with immutable orders) would be retried forever.
- `failed` rows from the old code restart only on an operator retry, since their random key was never stored.
- Not tested: a vanished host's lock is freed by a 10 s idle-transaction timeout (setting verified). Surviving a database restart was checked by hand only.
- `docker stop` kills the app after 10 s because `sh` is PID 1 and does not pass the signal on. Safe by design.
- Not handled: an event ID reused for another order (excluded by the contract), a hand-edited `pending` row without `next_attempt_at`, a malformed `%` in the retry URL (500).

## Time spent
About 4 hours.

## AI note
Claude Code (Fable 5.2, Sonnet 5.5, Opus 5.5) read the contract and code, wrote the code, tests and docs, and ran the checks. I directed the work in small steps, each explained to me in plain language and executed only after my approval. Every claim had to rest on something runnable: a contract line, a reproduction on the starter, or a test shown to fail on the previous code. Corrected suggestions included recovering by looking up `order_ref` first (rejected: an empty lookup proves nothing, so recovery replays the same key) and a random-kill test that passed even without the worker (the kill landed after the burst; rewritten with a mid-stream kill).
