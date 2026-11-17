# VendHub Senior Full Stack Developer Assignment

Read the accompanying assignment document first. This starter intentionally contains defects. The supplier fixture is the fixed external-system boundary. No UI or real payment integration is required.

## Fast start with Docker

Prerequisite: Docker with Compose v2. No cloud accounts or credentials are needed.

```bash
docker compose up --build --wait
docker compose exec app npm test
curl http://localhost:3000/orders
curl -X POST http://localhost:3000/payment-events -H 'Content-Type: application/json' -d '{"event_id":"evt-demo-1","order_id":"ORD-1001","type":"payment.succeeded"}'
curl 'http://localhost:4001/orders?order_ref=ORD-1001'
```

Compose binds services to localhost. Test credentials are local fixture credentials only. Smoke tests check connectivity and seeded data, not workflow correctness. Application schema setup is additive and does not reset orders on restart.

After editing code, rebuild the app with `docker compose up -d --build app`. To run a second application instance against the same database and supplier:

```bash
docker compose run --rm --no-deps -e PORT=3000 -p 127.0.0.1:3002:3000 app
```

That foreground command occupies its terminal. Your solution must work with both instances running. Preserve the four routes below and the basic fields in their responses; add fields or routes if useful. Keep confirmed supplier submission represented by `fulfillment_status: "confirmed"` and the correct `supplier_order_id`.

## Application routes

- `GET /health`: liveness response.
- `GET /orders`: JSON array of orders including `id`, `sku`, `quantity`, `payment_status`, `fulfillment_status`, `supplier_order_id`, `last_error`.
- `POST /payment-events`: body `{event_id, order_id, type:"payment.succeeded"}`. This starts submission for a known paid order. More than one distinct event ID can refer to the same order. Event IDs are globally unique and, on replay, have the same payload.
- `POST /orders/:id/retry`: operations-triggered attempt for a known paid order. It must share the same correctness guarantees as automatic recovery. This can also start submission for a seeded order.

Both seeded orders are paid, immutable snapshots with exactly one SKU and one supplier submission each. They start as `not_submitted`; do not submit untouched seed orders until a payment event or explicit retry requests submission. No partial fulfillment, order edits, payment reversals, or multiple suppliers are in scope. Events in this local exercise are trusted fixtures; authentication and webhook signatures are excluded.

## Fault examples

Configure before sending the event:

```bash
curl -X POST http://localhost:4001/_test/mode -H 'Content-Type: application/json' -d '{"order_ref":"ORD-1002","mode":"accept_then_disconnect_once"}'
```

See `SUPPLIER_API.md` for all guarantees and test controls.

For the crash checkpoint, use a fresh order and normal supplier mode:

```bash
CRASH_AFTER_SUPPLIER_SUCCESS=1 docker compose up -d --force-recreate app
```

Send an event: the process exits immediately after receiving supplier success and before local confirmation. Inspect with `docker compose logs app`, then restart normally with the flag disabled:

```bash
CRASH_AFTER_SUPPLIER_SUCCESS=0 docker compose up -d --force-recreate app
```

Do not delete volumes for this recovery check. A hard process stop at other points is also allowed in your tests. Preserve the checkpoint in an equivalent position if you refactor the supplier call.

## Local development alternative

Use Node 24+, Python 3.12+, and PostgreSQL 17+. Run `docker compose up -d --wait db supplier` if you want just the fixture services. In another terminal:

```bash
npm ci
export DATABASE_URL=postgres://exercise:exercise@localhost:55432/exercise
export SUPPLIER_URL=http://localhost:4001
npm run db:setup
npm start
```

For a locally running supplier without Docker, run `python3 supplier/server.py`. Its database path is set by `SUPPLIER_DB` and defaults to a temporary-directory file. Node defaults to the connection values above.

## Reset and submission

`docker compose down` stops services and preserves data. `docker compose down -v` permanently clears only this exercise's Compose volumes; use it between clean test runs, never as a recovery procedure. Source code and submitted tests must not contain reset-on-start behavior.

Submit a repository link or ZIP containing code, lockfile, schema/migrations, tests, and README. Exclude `node_modules`, database files, secrets, and Docker volumes. Your README should include exact setup, migration and test commands, root cause, guarantees and limitations, approximate time spent, and a short AI-use note. Do not submit the assignment document as your solution.
