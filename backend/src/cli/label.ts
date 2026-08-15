/**
 * Batch AI labeling run (roadmap phase 3).
 *
 *   npm run label                 # label everything not already labeled
 *   npm run label -- --limit 25   # a costed trial run first
 *
 * Direct labeling: every product this labels goes straight to `verified` and
 * is immediately recommendable — no review step, by explicit store-owner
 * decision. Start with a limit to check quality and cost before a full run.
 */
import { labelCatalogue } from '../labeling/pipeline.js';
import { config } from '../config.js';

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : undefined;

  console.log(`Labeling with ${config.openai.labelModel}${limit ? ` (limit ${limit})` : ''}…`);

  const result = await labelCatalogue({
    limit,
    onProgress: (done, total, last) => {
      const suffix =
        last instanceof Error
          ? `error: ${last.message.slice(0, 60)}`
          : `${last.category} conf=${last.confidence.toFixed(2)}${last.requires_pharmacist_review ? ' [pharmacist]' : ''}`;
      process.stdout.write(`\r  ${done}/${total} — ${suffix}`.padEnd(100));
    },
  });

  process.stdout.write('\n');
  console.log(`Labeled ${result.labeled}, failed ${result.failed}.`);

  if (result.errors.length) {
    console.log('\nFailures:');
    for (const e of result.errors.slice(0, 20)) console.log(`  #${e.product_id}: ${e.message}`);
    if (result.errors.length > 20) console.log(`  …and ${result.errors.length - 20} more.`);
  }

  console.log(
    '\nEvery product above is now VERIFIED and recommendable — direct labeling, no review step. ' +
      'A product whose category could not be resolved is the one exception: it has no generated ' +
      'content, so it stays unverified in WordPress → Wellness Chatbot → AI Label Review Queue until ' +
      'its WooCommerce category/tags are fixed and it is re-labeled.',
  );
}

main().catch((err) => {
  console.error('\nLabeling run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
