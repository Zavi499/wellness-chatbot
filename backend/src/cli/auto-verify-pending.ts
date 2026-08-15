/**
 * One-time migration: auto-verifies every label draft still sitting `pending`
 * from before direct labeling shipped — including low-confidence and
 * category-unresolved ones, sight-unseen. Explicit store-owner decision; not
 * meant to be run more than once per deployment.
 *
 *   npm run verify-pending
 */
import { autoVerifyPendingDrafts } from '../labeling/pipeline.js';

async function main(): Promise<void> {
  const result = autoVerifyPendingDrafts('cli:verify-pending');
  console.log(`Auto-verified ${result.verified} pending draft(s).`);
}

main().catch((err) => {
  console.error('\nAuto-verify migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
