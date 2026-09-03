import { globSync } from 'fs';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { parseCodexTranscript } from '../src/services/recovery/CodexTranscriptRecovery.js';
import { HistoricalFingerprintReconciler } from '../src/services/recovery/HistoricalFingerprintReconciler.js';
import { HistoricalRecoveryScanner } from '../src/services/recovery/HistoricalRecoveryScanner.js';

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
}, null, 2));
