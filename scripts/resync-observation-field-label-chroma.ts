import { Database } from 'bun:sqlite';
import { ChromaSync } from '../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../src/services/sync/ChromaMcpManager.js';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.CLAUDE_MEM_DB ?? '/root/.claude-mem/claude-mem.db';
const CONCURRENCY = 4;

type Row = {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at_epoch: number;
  platform_source: string | null;
};

function stringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

const db = new Database(DB_PATH, { readonly: true });
const auditPresent = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_field_label_repair_audit'").get();
if (!auditPresent) {
  db.close();
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'audit', database: DB_PATH, observations: 0, reason: 'field-label repair audit table does not exist yet' }, null, 2));
  process.exit(0);
}
const rows = db.query(`SELECT DISTINCT o.id, o.memory_session_id, o.project, o.type, o.title, o.subtitle,
  o.facts, o.narrative, o.concepts, o.files_read, o.files_modified, o.prompt_number, o.created_at_epoch,
  COALESCE(NULLIF(s.platform_source, ''), 'claude') AS platform_source
  FROM observations o
  JOIN observation_field_label_repair_audit audit ON audit.observation_id = o.id
  LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
  ORDER BY o.id`).all() as Row[];
db.close();

console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'audit', database: DB_PATH, observations: rows.length, concurrency: CONCURRENCY }, null, 2));
if (!APPLY || rows.length === 0) process.exit(0);

const sync = new ChromaSync('claude-mem');
let succeeded = 0;
const failures: Array<{ id: number; error: string }> = [];
try {
  for (let offset = 0; offset < rows.length; offset += CONCURRENCY) {
    const batch = rows.slice(offset, offset + CONCURRENCY);
    await Promise.all(batch.map(async row => {
      try {
        await sync.syncObservation(row.id, row.memory_session_id, row.project, {
          type: row.type,
          title: row.title,
          subtitle: row.subtitle,
          facts: stringArray(row.facts),
          narrative: row.narrative,
          concepts: stringArray(row.concepts),
          files_read: stringArray(row.files_read),
          files_modified: stringArray(row.files_modified),
        }, row.prompt_number ?? 0, row.created_at_epoch, row.platform_source ?? undefined);
        succeeded += 1;
      } catch (error) {
        failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }));
  }
  console.log(JSON.stringify({ succeeded, failed: failures.length, failures: failures.slice(0, 12) }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await ChromaMcpManager.getInstance().stop();
}
