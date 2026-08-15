/**
 * A background-running labeling job with live, pollable progress.
 *
 * Running `labelCatalogue()` synchronously inside an HTTP request is what
 * caused the WordPress dashboard's "Run AI labeling" button to hang the page
 * and eventually surface as a gateway timeout: a batch of any real size
 * easily outlives a browser request, a PHP-FPM worker, or a reverse proxy's
 * own timeout, even though the work itself was completing fine server-side.
 *
 * The fix is the usual one for a long job behind a short-lived request: don't
 * make the request wait for it. `startLabelJob()` kicks the batch off and
 * returns immediately; the job updates a small in-memory record as it goes,
 * and `getCurrentJob()` is what a polling client reads.
 *
 * In-memory, not a database table, and deliberately so — this is a
 * single-Node-process service with no worker queue, only one admin is
 * realistically running a labeling batch at a time, and every product the
 * job touches is already safely resumable (`isEligibleForLabeling`) if the
 * process restarts mid-run. Building a persisted job table would be solving
 * a problem this deployment doesn't have.
 */
import { randomUUID } from 'node:crypto';
import { nowIso } from '../db/index.js';
import { labelCatalogue, type LabelRunResult } from './pipeline.js';
import { getProduct } from '../products/repository.js';
import { reindexProducts } from '../search/embeddings.js';

export interface LabelJobLogEntry {
  at: string;
  product_id: number | null;
  name: string | null;
  level: 'info' | 'error';
  message: string;
}

export interface LabelJobState {
  id: string;
  status: 'running' | 'completed' | 'failed';
  limit: number | null;
  total: number;
  done: number;
  labeled: number;
  failed: number;
  started_at: string;
  finished_at: string | null;
  log: LabelJobLogEntry[];
}

/** The log a client actually renders — bounded so a very large run can't grow this without limit. */
const MAX_LOG_ENTRIES = 300;

let currentJob: LabelJobState | null = null;

export function getCurrentJob(): LabelJobState | null {
  return currentJob;
}

export function isJobRunning(): boolean {
  return currentJob?.status === 'running';
}

function appendLog(job: LabelJobState, entry: Omit<LabelJobLogEntry, 'at'>): void {
  job.log.push({ at: nowIso(), ...entry });
  if (job.log.length > MAX_LOG_ENTRIES) job.log.shift();
}

export interface StartJobOptions {
  limit?: number;
  reindex?: boolean;
}

/**
 * Starts a labeling batch in the background. Only one job runs at a time —
 * starting a second while one is already running would just mean two loops
 * racing over the same products (harmless, since `isEligibleForLabeling`
 * would make the second one mostly a no-op once the first claims each item,
 * but confusing to watch and wasteful of model calls in the overlap), so this
 * refuses instead.
 */
export function startLabelJob(opts: StartJobOptions): LabelJobState {
  if (isJobRunning()) {
    throw new Error('A labeling run is already in progress.');
  }

  const job: LabelJobState = {
    id: randomUUID(),
    status: 'running',
    limit: opts.limit ?? null,
    total: 0,
    done: 0,
    labeled: 0,
    failed: 0,
    started_at: nowIso(),
    finished_at: null,
    log: [{ at: nowIso(), product_id: null, name: null, level: 'info', message: 'Starting…' }],
  };
  currentJob = job;

  // Deliberately not awaited — this is the whole point. The caller (the
  // route handler) returns as soon as this function returns the job object;
  // the work below keeps running against `job` after that response is sent.
  runJob(job, opts).catch((err) => {
    job.status = 'failed';
    job.finished_at = nowIso();
    appendLog(job, {
      product_id: null,
      name: null,
      level: 'error',
      message: `Job crashed: ${err instanceof Error ? err.message : String(err)}`,
    });
  });

  return job;
}

async function runJob(job: LabelJobState, opts: StartJobOptions): Promise<void> {
  const result = await labelCatalogue({
    limit: opts.limit,
    onProgress: (done, total, last) => {
      job.done = done;
      job.total = total;
      recordProgress(job, last);
    },
  });

  if (opts.reindex) {
    appendLog(job, { product_id: null, name: null, level: 'info', message: 'Rebuilding search index…' });
    await reindexProducts();
    appendLog(job, { product_id: null, name: null, level: 'info', message: 'Search index rebuilt.' });
  }

  job.status = 'completed';
  job.finished_at = nowIso();
  appendLog(job, {
    product_id: null,
    name: null,
    level: 'info',
    message: `Finished: ${result.labeled} labeled, ${result.failed} failed.`,
  });
}

function recordProgress(job: LabelJobState, last: LabelRunResult | Error): void {
  if (last instanceof Error) {
    job.failed += 1;
    appendLog(job, { product_id: null, name: null, level: 'error', message: last.message });
    return;
  }

  job.labeled += 1;
  const product = getProduct(last.product_id);
  const name = product?.name ?? `#${last.product_id}`;
  const flag = last.requires_pharmacist_review ? ' — needs pharmacist review to be approved' : '';
  appendLog(job, {
    product_id: last.product_id,
    name: product?.name ?? null,
    level: 'info',
    message: `Labeled "${name}" (${last.category}, confidence ${last.confidence.toFixed(2)})${flag}`,
  });
}
