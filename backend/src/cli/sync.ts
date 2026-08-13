/**
 * Full-catalogue sync + embedding backfill (roadmap phase 2).
 *
 *   npm run sync            # pull products from WooCommerce
 *   npm run sync -- --embed # also rebuild the vector index
 */
import { backfillCatalogue } from '../products/woocommerce.js';
import { reindexProducts } from '../search/embeddings.js';
import { countProducts } from '../products/repository.js';

async function main(): Promise<void> {
  const withEmbeddings = process.argv.includes('--embed');

  console.log('Pulling products from WooCommerce…');
  const synced = await backfillCatalogue((count, total) => {
    process.stdout.write(`\r  synced ${total} products…`);
    void count;
  });
  process.stdout.write('\n');
  console.log(`Synced ${synced} products.`);

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
    console.log('\nNothing is recommendable yet — run `npm run label`, then approve products in the WP Label Review Queue.');
  }
}

main().catch((err) => {
  console.error('\nSync failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
