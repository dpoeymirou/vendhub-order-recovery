# Supplier API contract

This is a fictional supplier. Its documented guarantees apply for the entire exercise. Leave `supplier/server.py` unchanged. Communicate with it only over HTTP; do not access its database. Do not add uniqueness on `order_ref` or otherwise strengthen its guarantees.

## Submit an order

`POST /orders` with JSON `{"order_ref":"ORD-1001","sku":"COFFEE-CASE","quantity":2}`. An optional `Idempotency-Key` header is supported.

- Accepted submission: HTTP 201 and `{"supplier_order_id":"SUP-...","order_ref":"ORD-1001"}`.
- Repeating the same key and the same payload: HTTP 200 with the original supplier order ID. Concurrent requests with that key also resolve to one order.
- Repeating a key with a different payload: HTTP 409; the existing order is unchanged.
- A key is retained durably for this entire exercise, including across supplier restarts. It is scoped to this single supplier account.
- Without a key, or with a different key, each accepted call creates another supplier order. `order_ref` is a label, not a unique key.
- HTTP 422 is a definite rejection of that request without creation of a new order. HTTP 503 in this fixture is a definite temporary failure before creation. A disconnect or timeout does not identify the supplier's outcome.
- Successful orders and key records are committed atomically before success is returned. An accepted order is not subsequently canceled by this fixture.

## Inspect submissions

`GET /orders?order_ref=ORD-1001` returns an array of accepted orders with `supplier_order_id`, `order_ref`, `sku`, and `quantity`. An empty array means none is committed at the instant of the read. It does not exclude a concurrent request committing afterward. Repeated submissions with different keys can produce several entries.

## Local testing controls

These are fixture controls, not business API endpoints. Use them only from tests or setup commands. Application recovery must not call `/_test/*`.

`POST /_test/mode` with `{"order_ref":"ORD-1001","mode":"accept_then_disconnect_once"}` selects a fault per order:

| Mode | Behavior |
| --- | --- |
| `normal` | Normal API behavior |
| `accept_then_disconnect_once` | First new accepted submission commits, then the connection closes before a response; subsequent submissions respond normally |
| `unavailable` | New submissions return 503 without creating an order until the mode changes |
| `reject` | New submissions return 422 without creating an order until the mode changes |

A replay of an already accepted idempotency key returns its original order even when another mode is configured. Setting a mode resets its one-shot counter. Fault configuration and counters survive fixture restarts.

`POST /_test/reset` clears all supplier orders, keys, and fault configuration. Use only between isolated test cases, never during application recovery.
