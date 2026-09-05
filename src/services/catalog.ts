import { pool } from '../db/pool.js';

/**
 * Hot storefront query: active products with available stock.
 *
 * Plan (PostgreSQL):
 * 1. Index Only / Bitmap on product_stock_available_idx (available_qty > 0)
 * 2. Nested loop / merge join to products via PK (sku)
 * 3. Filter products.active using products_active_sku_idx
 *
 * product_stock is a denormalized counter maintained by trigger on inventory_keys,
 * so we never COUNT(*) the keys table on the hot path.
 */
export async function getStorefrontStock(limit = 100, offset = 0) {
  const r = await pool.query(
    `SELECT p.sku, p.name, p.type, p.price, p.currency, p.image, s.available_qty
     FROM product_stock s
     JOIN products p ON p.sku = s.sku
     WHERE p.active = TRUE AND s.available_qty > 0
     ORDER BY s.available_qty DESC, p.sku
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return r.rows;
}

export async function explainStorefrontStock() {
  const r = await pool.query(
    `EXPLAIN (FORMAT TEXT)
     SELECT p.sku, p.name, p.type, p.price, p.currency, p.image, s.available_qty
     FROM product_stock s
     JOIN products p ON p.sku = s.sku
     WHERE p.active = TRUE AND s.available_qty > 0
     ORDER BY s.available_qty DESC, p.sku
     LIMIT 100`,
  );
  return r.rows.map((row) => Object.values(row)[0] as string);
}
