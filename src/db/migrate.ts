import { pool } from './pool.js';

const SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE order_status AS ENUM (
    'created',
    'paid',
    'delivering',
    'delivered',
    'payment_failed',
    'out_of_stock',
    'delivery_failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE key_status AS ENUM ('available', 'reserved', 'sold');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ledger_entry_type AS ENUM (
    'payment_in',
    'payment_failed',
    'delivery_cost',
    'refund_reserve'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS products (
  sku            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL,
  price          INTEGER NOT NULL CHECK (price > 0),
  currency       TEXT NOT NULL DEFAULT 'RUB',
  image          TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_stock (
  sku            TEXT PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
  available_qty  INTEGER NOT NULL DEFAULT 0 CHECK (available_qty >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_keys (
  id             BIGSERIAL PRIMARY KEY,
  sku            TEXT NOT NULL REFERENCES products(sku),
  code           TEXT NOT NULL,
  status         key_status NOT NULL DEFAULT 'available',
  order_id       TEXT,
  request_id     TEXT,
  sold_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code)
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_keys_request_id_uq
  ON inventory_keys (request_id) WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_keys_sku_available_idx
  ON inventory_keys (sku) WHERE status = 'available';

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  sku             TEXT NOT NULL REFERENCES products(sku),
  amount          INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'RUB',
  status          order_status NOT NULL DEFAULT 'created',
  delivery_code   TEXT,
  provider        TEXT,
  request_id      TEXT,
  last_error      TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version         INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_delivery_code_uq
  ON orders (delivery_code) WHERE delivery_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS orders_request_id_uq
  ON orders (request_id) WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_status_next_attempt_idx
  ON orders (status, next_attempt_at)
  WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed');

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  event_id       TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL,
  status         TEXT NOT NULL,
  amount         INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied        BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS payment_events_order_id_idx ON payment_events (order_id);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id             BIGSERIAL PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  provider       TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  http_status    INTEGER,
  code           TEXT,
  error_reason   TEXT,
  latency_ms     INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS delivery_attempts_order_id_idx ON delivery_attempts (order_id);
CREATE INDEX IF NOT EXISTS delivery_attempts_request_id_idx ON delivery_attempts (request_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  order_id       TEXT,
  entry_type     ledger_entry_type NOT NULL,
  amount         BIGINT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'RUB',
  description    TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_entries_order_id_idx ON ledger_entries (order_id);
CREATE INDEX IF NOT EXISTS ledger_entries_created_at_idx ON ledger_entries (created_at);

CREATE TABLE IF NOT EXISTS provider_issue_log (
  request_id     TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  sku            TEXT NOT NULL,
  order_id       TEXT NOT NULL,
  code           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_active_sku_idx
  ON products (sku) WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS product_stock_available_idx
  ON product_stock (available_qty DESC, sku)
  WHERE available_qty > 0;

CREATE OR REPLACE FUNCTION refresh_product_stock(p_sku TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO product_stock (sku, available_qty, updated_at)
  VALUES (
    p_sku,
    (SELECT COUNT(*)::INT FROM inventory_keys WHERE sku = p_sku AND status = 'available'),
    now()
  )
  ON CONFLICT (sku) DO UPDATE
  SET available_qty = EXCLUDED.available_qty,
      updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_inventory_keys_stock()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_product_stock(OLD.sku);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' AND OLD.sku IS DISTINCT FROM NEW.sku THEN
    PERFORM refresh_product_stock(OLD.sku);
    PERFORM refresh_product_stock(NEW.sku);
    RETURN NEW;
  ELSE
    PERFORM refresh_product_stock(NEW.sku);
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_keys_stock_aiud ON inventory_keys;
CREATE TRIGGER inventory_keys_stock_aiud
AFTER INSERT OR UPDATE OR DELETE ON inventory_keys
FOR EACH ROW EXECUTE FUNCTION trg_inventory_keys_stock();
`;

async function migrate() {
  await pool.query(SQL);
  console.log('Migrations applied');
  await pool.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
