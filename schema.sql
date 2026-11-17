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
CREATE TABLE IF NOT EXISTS payment_events (
  event_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  received_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO orders (id, sku, quantity) VALUES
  ('ORD-1001', 'COFFEE-CASE', 2),
  ('ORD-1002', 'WATER-CASE', 3)
ON CONFLICT (id) DO NOTHING;
