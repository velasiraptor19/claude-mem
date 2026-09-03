import { globSync } from 'fs';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { parseCodexTranscript } from '../src/services/recovery/CodexTranscriptRecovery.js';
import { HistoricalFingerprintReconciler } from '../src/services/recovery/HistoricalFingerprintReconciler.js';
import { HistoricalRecoveryScanner } from '../src/services/recovery/HistoricalRecoveryScanner.js';
import { SessionSearch } from '../src/services/sqlite/SessionSearch.js';

const dbPath = process.env.CLAUDE_MEM_RECONCILE_DB_COPY;
const transcriptRoot = process.env.CLAUDE_MEM_CODEX_TRANSCRIPT_ROOT ?? '/root/.codex/sessions';
if (!dbPath) throw new Error('CLAUDE_MEM_RECONCILE_DB_COPY is required; live DB paths are intentionally not assumed');

const store = new SessionStore(dbPath);
const files = globSync(`${transcriptRoot}/**/*.jsonl`).sort();
const transcripts = files.flatMap(locator => {
  try { return [parseCodexTranscript(locator)]; } catch { return []; }
});
const reconciler = new HistoricalFingerprintReconciler(store);
const scanner = new HistoricalRecoveryScanner(store, undefined, transcriptRoot);
const beforeReconcile = reconciler.reconcile(transcripts, true);
const beforeScan = await scanner.scan(true);
const applied = reconciler.reconcile(transcripts, false);
const afterScan = await scanner.scan(true);
const secondReconcile = reconciler.reconcile(transcripts, false);
const queuedOnCopy = await scanner.scan(false);
const secondScan = await scanner.scan(true);
const integrity = store.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
const foreignKeys = (store.db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;

// The historical gate is not just a row-count check.  Prove that a bounded,
// deterministic sample remains available through the ordinary SQLite search
// implementation.  The report keeps only IDs and query terms, never record
// bodies, so it can be retained as a redacted audit receipt.
const search = new SessionSearch(store.db);
const candidates = store.db.prepare(`
  SELECT id, project, title, narrative
  FROM observations
  WHERE COALESCE(title, '') <> '' OR COALESCE(narrative, '') <> ''
  ORDER BY id
  LIMIT 500
`).all() as Array<{ id: number; project: string; title: string | null; narrative: string | null }>;
const retrievalSample: Array<{ observationId: number; term: string; retrieved: true }> = [];
for (const candidate of candidates) {
  if (retrievalSample.length === 20) break;
  const term = `${candidate.title ?? ''} ${candidate.narrative ?? ''}`
    .match(/[\p{L}\p{N}_-]{3,}/u)?.[0];
  if (!term) continue;
  const found = search.searchObservations(term, { project: candidate.project, limit: 50 });
  if (found.some(item => item.id === candidate.id)) {
    retrievalSample.push({ observationId: candidate.id, term, retrieved: true });
  }
}
if (retrievalSample.length < 20) {
  throw new Error(`historical retrieval gate failed: expected 20 records, retrieved ${retrievalSample.length}`);
}

console.log(JSON.stringify({
  files: files.length,
  transcripts: transcripts.length,
  beforeReconcile,
  beforeScan,
  applied,
  afterScan,
  secondReconcile,
  queuedOnCopy,
  secondScan,
  integrity: integrity.integrity_check,
  foreignKeyViolations: foreignKeys,
  retrievalSample,
}, null, 2));
