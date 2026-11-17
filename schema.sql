CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  payment_status text NOT NULL DEFAULT 'paid',
  fulfillment_status text NOT NULL DEFAULT 'not_submitted',
  supplier_order_id text,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Durable submission state. Additive only: every statement is safe to run twice.
-- States used in fulfillment_status: not_submitted -> pending -> confirmed | rejected.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_request_key text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_confirmed_has_supplier_id' AND conrelid = 'orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_confirmed_has_supplier_id
      CHECK (fulfillment_status <> 'confirmed' OR supplier_order_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_pending_has_request_key' AND conrelid = 'orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_pending_has_request_key
      CHECK (fulfillment_status <> 'pending' OR supplier_request_key IS NOT NULL);
  END IF;
END $$;
-- One supplier request key per order, never shared between orders.
CREATE UNIQUE INDEX IF NOT EXISTS orders_supplier_request_key_uq ON orders (supplier_request_key) WHERE supplier_request_key IS NOT NULL;
-- Lets the worker find due work quickly.
CREATE INDEX IF NOT EXISTS orders_pending_due_idx ON orders (next_attempt_at) WHERE fulfillment_status = 'pending';
CREATE TABLE IF NOT EXISTS payment_events (
  event_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  received_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO orders (id, sku, quantity) VALUES
  ('ORD-1001', 'COFFEE-CASE', 2),
  ('ORD-1002', 'WATER-CASE', 3)
ON CONFLICT (id) DO NOTHING;
