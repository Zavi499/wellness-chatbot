/**
 * Local catalogue import — no connection to the website (roadmap phase 2,
 * revised).
 *
 * Reads a product export file from disk and loads it directly into this
 * service's own database. This replaced a version that pulled products over
 * the WooCommerce REST API: on constrained hosting, that pull was a second
 * full WordPress + WooCommerce boot for every product the webhook had already
 * pushed once. There is no REST client left in this codebase to fall back to.
 *
 * The file is produced by the WordPress plugin's exporter (Settings → Export
 * catalogue, or `wp wellness-chatbot export`) and is either a bare array of
 * products or `{ "products": [...] }`.
 *
 *   npm run import:prod -- --file ./catalogue.json
 *   npm run import:prod -- --file ./catalogue.json --embed
 *   npm run import:prod -- --file ./catalogue.json --embed --prune
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWooProduct, type WooRawProduct } from '../products/normalize.js';
import { allProducts, countProducts, deleteProduct, upsertWooFields } from '../products/repository.js';
import { reindexProducts } from '../search/embeddings.js';

function readProducts(filePath: string): WooRawProduct[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  const products = Array.isArray(parsed)
    ? parsed
    : (parsed as { products?: unknown }).products;

  if (!Array.isArray(products)) {
    throw new Error(
      `${resolved} does not look like a catalogue export — expected an array, or { "products": [...] }.`,
    );
  }
  return products as WooRawProduct[];
}

async function main(): Promise<void> {
  const fileArg = process.argv.indexOf('--file');
  const filePath = fileArg > -1 ? process.argv[fileArg + 1] : undefined;
  if (!filePath) {
    console.error('Usage: npm run import:prod -- --file <path> [--embed] [--prune]');
    process.exit(1);
  }

  const withEmbeddings = process.argv.includes('--embed');
  const withPrune = process.argv.includes('--prune');

  console.log(`Reading ${filePath}…`);
  const products = readProducts(filePath);
  console.log(`Found ${products.length} products in the file.`);

  let upserted = 0;
  let skipped = 0;
  for (const product of products) {
    if (!product.id || !product.name) {
      skipped += 1;
      continue;
    }
    upsertWooFields(normalizeWooProduct(product));
    upserted += 1;
    if (upserted % 100 === 0) process.stdout.write(`\r  imported ${upserted}/${products.length}…`);
  }
  process.stdout.write('\n');
  console.log(`Imported ${upserted} products.${skipped ? ` Skipped ${skipped} with no id/name.` : ''}`);

  if (withPrune) {
    const keep = new Set(products.map((p) => p.id).filter(Boolean));
    const toRemove = allProducts()
      .map((p) => p.product_id)
      .filter((id) => !keep.has(id));
    for (const id of toRemove) deleteProduct(id);
    console.log(`Pruned ${toRemove.length} local product(s) not present in the file.`);
  }

  if (withEmbeddings) {
    console.log('Building embeddings…');
    const embedded = await reindexProducts((done, total) => {
      process.stdout.write(`\r  embedded ${done}/${total}…`);
    });
    process.stdout.write('\n');
    console.log(`Embedded ${embedded} products.`);
  }

  const counts = countProducts();
  console.log(
    `\nCatalogue: ${counts.total} products, ${counts.verified} recommendable (verified or partial), ` +
      `${counts.queued} awaiting label review.`,
  );
  if (counts.verified === 0) {
    console.log('\nNothing is recommendable yet — run `npm run label:prod`, then approve products in the WP Label Review Queue.');
  }
}

main().catch((err) => {
  console.error('\nImport failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
