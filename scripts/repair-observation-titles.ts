import { Database } from 'bun:sqlite';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.CLAUDE_MEM_DB ?? '/root/.claude-mem/claude-mem.db';

type Repair = { id: number; originalTitle: string; repairedTitle: string; metadata: string | null; originDeviceId: string | null; syncRev: string };

function normalizeTitle(title: string): string | null {
  const trimmed = title.trim();
  const titleMatch = /^\[\*\*title\*\*:\s*/i.exec(trimmed);
  if (titleMatch) {
    const content = trimmed.slice(titleMatch[0].length).trim();
    return (content.endsWith(']') ? content.slice(0, -1) : content).trim() || 'Untitled observation';
  }
  const typedMatch = /^\[\*\*(?:bugfix|feature|refactor|change|discovery|decision|security_alert|security_note|sensitive)\*\*(?:\]\s*:?\s*|:\s*)/i.exec(trimmed);
  if (!typedMatch) return null;
  const content = trimmed.slice(typedMatch[0].length).trim();
  return (typedMatch[0].includes(':') && content.endsWith(']') ? content.slice(0, -1) : content).trim() || 'Untitled observation';
}

function incrementDecimal(value: string): string {
  try { return (BigInt(value || '0') + 1n).toString(); } catch { return '1'; }
}

function metadataWithAudit(existing: string | null, repair: Repair): string {
  let metadata: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { previous_metadata: existing };
    } catch { metadata = { previous_metadata: existing }; }
  }
  metadata.claude_mem_title_repair = { original_title: repair.originalTitle, repaired_title: repair.repairedTitle, repaired_at_epoch: Date.now() };
  return JSON.stringify(metadata);
}

const db = APPLY ? new Database(DB_PATH) : new Database(DB_PATH, { readonly: true });
const rows = db.query(`SELECT id, title, metadata, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
  FROM observations WHERE title IS NOT NULL`).all() as Array<{ id: number; title: string; metadata: string | null; origin_device_id: string | null; sync_rev: string }>;
const repairs: Repair[] = rows.flatMap(row => {
  const repairedTitle = normalizeTitle(row.title);
  return repairedTitle && repairedTitle !== row.title ? [{ id: row.id, originalTitle: row.title, repairedTitle, metadata: row.metadata, originDeviceId: row.origin_device_id, syncRev: row.sync_rev }] : [];
});
console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'audit', database: DB_PATH, candidates: repairs.length, sample: repairs.slice(0, 12).map(({ id, originalTitle, repairedTitle }) => ({ id, originalTitle, repairedTitle })) }, null, 2));
if (!APPLY || repairs.length === 0) { db.close(); process.exit(0); }

db.transaction(() => {
  db.run(`CREATE TABLE IF NOT EXISTS observation_title_repair_audit (
    observation_id INTEGER PRIMARY KEY, original_title TEXT NOT NULL, repaired_title TEXT NOT NULL, repaired_at_epoch INTEGER NOT NULL
  )`);
  const update = db.prepare('UPDATE observations SET title=?, metadata=?, sync_rev=?, synced_at=NULL WHERE id=?');
  const audit = db.prepare('INSERT OR REPLACE INTO observation_title_repair_audit (observation_id, original_title, repaired_title, repaired_at_epoch) VALUES (?, ?, ?, ?)');
  const now = Date.now();
  for (const repair of repairs) {
    update.run(repair.repairedTitle, metadataWithAudit(repair.metadata, repair), repair.originDeviceId === null ? incrementDecimal(repair.syncRev) : repair.syncRev, repair.id);
    audit.run(repair.id, repair.originalTitle, repair.repairedTitle, now);
  }
})();
const titleWrapper = /^\[\*\*(?:title|bugfix|feature|refactor|change|discovery|decision|security_alert|security_note|sensitive)\*\*(?::|\]\s*:|\]\s)/i;
const remainingMalformed = (db.query('SELECT title FROM observations WHERE title IS NOT NULL').all() as Array<{ title: string }>)
  .filter(row => titleWrapper.test(row.title.trim()))
  .length;
console.log(JSON.stringify({ repaired: repairs.length, remainingMalformed, integrity: db.query('PRAGMA integrity_check').all(), foreignKeys: db.query('PRAGMA foreign_key_check').all() }, null, 2));
db.close();
