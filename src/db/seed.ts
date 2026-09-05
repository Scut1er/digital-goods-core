import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

type Catalog = {
  products: Array<{
    sku: string;
    name: string;
    type: string;
    price: number;
    currency: string;
    image: string;
  }>;
};

type KeysFile = { keys: string[] };

async function seed() {
  const catalog = JSON.parse(readFileSync(join(root, 'data', 'catalog.json'), 'utf8')) as Catalog;
  const keysFile = JSON.parse(readFileSync(join(root, 'data', 'keys.json'), 'utf8')) as KeysFile;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const p of catalog.products) {
      await client.query(
        `INSERT INTO products (sku, name, type, price, currency, image)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sku) DO UPDATE SET
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           price = EXCLUDED.price,
           currency = EXCLUDED.currency,
           image = EXCLUDED.image,
           active = TRUE`,
        [p.sku, p.name, p.type, p.price, p.currency, p.image],
      );
    }

    // Distribute keys round-robin across SKUs so every product has stock for demos.
    const skus = catalog.products.map((p) => p.sku);
    let inserted = 0;
    for (let i = 0; i < keysFile.keys.length; i++) {
      const sku = skus[i % skus.length];
      const code = keysFile.keys[i];
      const r = await client.query(
        `INSERT INTO inventory_keys (sku, code, status)
         VALUES ($1, $2, 'available')
         ON CONFLICT (code) DO NOTHING`,
        [sku, code],
      );
      inserted += r.rowCount ?? 0;
    }

    for (const sku of skus) {
      await client.query('SELECT refresh_product_stock($1)', [sku]);
    }

    // Extra synthetic SKUs for stage 5 (thousands+) — prices/stock for load demo.
    const extra = 2000;
    for (let i = 0; i < extra; i++) {
      const sku = `BULK-SKU-${String(i).padStart(5, '0')}`;
      await client.query(
        `INSERT INTO products (sku, name, type, price, currency, image)
         VALUES ($1, $2, 'key', $3, 'RUB', 'assets/bulk.png')
         ON CONFLICT (sku) DO NOTHING`,
        [sku, `Bulk digital item ${i}`, 100 + (i % 50) * 10],
      );
      await client.query(
        `INSERT INTO product_stock (sku, available_qty)
         VALUES ($1, $2)
         ON CONFLICT (sku) DO UPDATE SET available_qty = EXCLUDED.available_qty`,
        [sku, (i * 7) % 40],
      );
    }

    await client.query('COMMIT');
    console.log(`Seeded ${catalog.products.length} catalog SKUs, ${inserted} keys, +${extra} bulk SKUs`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
