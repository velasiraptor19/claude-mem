import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { parseCodexTranscript, recoveryKeyFor } from '../src/services/recovery/CodexTranscriptRecovery.js';
import { ChromaMcpManager } from '../src/services/sync/ChromaMcpManager.js';

const apply = process.argv.includes('--apply');
const dbPath = process.env.CLAUDE_MEM_DB ?? '/root/.claude-mem/claude-mem.db';
const db = apply ? new Database(dbPath) : new Database(dbPath, { readonly: true });
const jobs = db.query(`SELECT id, status, project, transcript_locator, recovery_key, source_fingerprint
  FROM recovery_jobs WHERE platform_source='codex' AND agent_id IS NOT NULL
  ORDER BY id`).all() as Array<{ id: number; status: string; project: string; transcript_locator: string | null; recovery_key: string | null; source_fingerprint: string | null }>;

const canonicalByLocator = new Map<string, Set<string>>();
for (const job of jobs) {
  if (!job.transcript_locator || !existsSync(job.transcript_locator) || canonicalByLocator.has(job.transcript_locator)) continue;
  const transcript = parseCodexTranscript(job.transcript_locator);
  canonicalByLocator.set(job.transcript_locator, new Set(transcript.turns.map(turn => recoveryKeyFor(transcript, turn))));
}

const invalid = jobs.filter(job => !job.transcript_locator
  || !job.recovery_key
  || !canonicalByLocator.get(job.transcript_locator)?.has(job.recovery_key));
const invalidFingerprints = [...new Set(invalid.map(job => job.source_fingerprint).filter((value): value is string => Boolean(value)))];
const summaries = invalidFingerprints.length === 0 ? [] : db.query(`SELECT id, project, request, investigated, learned, completed, next_steps, notes
  FROM session_summaries WHERE source_fingerprint IN (${invalidFingerprints.map(() => '?').join(',')}) ORDER BY id`).all(...invalidFingerprints) as Array<Record<string, unknown> & { id: number; project: string }>;
const byStatus = Object.fromEntries([...new Set(invalid.map(job => job.status))].sort().map(status => [status, invalid.filter(job => job.status === status).length]));
console.log(JSON.stringify({ mode: apply ? 'apply' : 'audit', scannedJobs: jobs.length, transcripts: canonicalByLocator.size, invalidJobs: invalid.length, invalidByStatus: byStatus, invalidSummaries: summaries.length }, null, 2));

if (!apply) { db.close(); process.exit(0); }
if (invalid.length === 0) { db.close(); process.exit(0); }

// Delete vector documents first. If this fails SQLite remains untouched and a
// retry is safe because Chroma ignores IDs that no longer exist.
const chroma = ChromaMcpManager.getInstance();
try {
  const summaryFields = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'] as const;
  for (const [project, projectSummaries] of Map.groupBy(summaries, summary => summary.project)) {
    const collection = `cm__${project.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/[^a-zA-Z0-9]+$/, '') || 'unknown'}`;
    const ids = projectSummaries.flatMap(summary => summaryFields.filter(field => Boolean(summary[field])).map(field => `summary_${summary.id}_${field}`));
    for (let offset = 0; offset < ids.length; offset += 100) {
      try {
        await chroma.callTool('chroma_delete_documents', { collection_name: collection, ids: ids.slice(offset, offset + 100) });
      } catch (error) {
        if (!String(error).includes('does not exist')) throw error;
        break;
      }
    }
  }
} finally {
  await chroma.stop();
}

const now = Date.now();
const transaction = db.transaction(() => {
  if (summaries.length) db.query(`DELETE FROM session_summaries WHERE id IN (${summaries.map(() => '?').join(',')})`).run(...summaries.map(summary => summary.id));
  const update = db.query(`UPDATE recovery_jobs SET status='cancelled', completed_at_epoch=?, updated_at_epoch=?,
    lease_owner=NULL, lease_expires_at_epoch=NULL, dead_letter_reason='superseded_subagent_parent_replay'
    WHERE id=?`);
  for (const job of invalid) update.run(now, now, job.id);
});
transaction();
console.log(JSON.stringify({ deletedSummaries: summaries.length, cancelledJobs: invalid.length }));
console.log(JSON.stringify(db.query('PRAGMA integrity_check').all()));
console.log(JSON.stringify(db.query('PRAGMA foreign_key_check').all()));
db.close();
