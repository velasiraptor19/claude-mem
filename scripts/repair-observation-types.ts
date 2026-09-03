import { Database } from 'bun:sqlite';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.CLAUDE_MEM_DB ?? '/root/.claude-mem/claude-mem.db';
const VALID_TYPES = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision', 'security_alert', 'security_note', 'sensitive'];

type Repair = { id: number; originalType: string; repairedType: string; policy: string; metadata: string | null; originDeviceId: string | null; syncRev: string };

function normalizedType(rawType: string): { type: string; policy: string } {
  const raw = rawType.trim();
  const direct = VALID_TYPES.find(type => type.toLowerCase() === raw.toLowerCase());
  if (direct) return { type: direct, policy: 'canonical_case_normalization' };

  const canonical = VALID_TYPES.join('|');
  const match = new RegExp(`^[\\s\\[*_]*?(?:\\*{1,2}\\s*)?(?:(?:\\*{0,2}type\\*{0,2})\\s*:\\s*)?(${canonical})\\b`, 'i').exec(raw);
  if (match) {
    const type = VALID_TYPES.find(candidate => candidate.toLowerCase() === match[1].toLowerCase())!;
    return { type, policy: 'canonical_wrapper_normalization' };
  }

  const aliases: Record<string, string> = { error: 'discovery', patch: 'change', pattern: 'discovery' };
  const alias = aliases[raw.toLowerCase()];
  if (alias) return { type: alias, policy: 'nvidia_alias_normalization' };
  // A type field containing a title, prompt fragment or arbitrary prose has no
  // safe semantic subtype. discovery is code mode's neutral factual category.
  return { type: 'discovery', policy: 'invalid_type_neutral_fallback' };
}

function incrementDecimal(value: string): string {
  try { return (BigInt(value || '0') + 1n).toString(); } catch { return '1'; }
}

function mergeAuditMetadata(existing: string | null, repair: Pick<Repair, 'originalType' | 'repairedType' | 'policy'>): string {
  let metadata: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
      else metadata = { previous_metadata: existing };
    } catch {
      metadata = { previous_metadata: existing };
    }
  }
  metadata.claude_mem_type_repair = {
    original_type: repair.originalType,
    repaired_type: repair.repairedType,
    policy: repair.policy,
    repaired_at_epoch: Date.now(),
  };
  return JSON.stringify(metadata);
}

const db = APPLY ? new Database(DB_PATH) : new Database(DB_PATH, { readonly: true });
const rows: Array<{ id: number; type: string; metadata: string | null; origin_device_id: string | null; sync_rev: string }> = db.query(`SELECT id, type, metadata, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
  FROM observations WHERE lower(trim(type)) NOT IN (${VALID_TYPES.map(() => '?').join(',')})`).all(...VALID_TYPES) as Array<{ id: number; type: string; metadata: string | null; origin_device_id: string | null; sync_rev: string }>;
const repairs: Repair[] = rows.map(row => {
  const normalized = normalizedType(row.type);
  return { id: row.id, originalType: row.type, repairedType: normalized.type, policy: normalized.policy, metadata: row.metadata, originDeviceId: row.origin_device_id, syncRev: row.sync_rev };
});
const byPolicy = Object.fromEntries([...Map.groupBy(repairs, repair => repair.policy)]
  .map(([policy, records]) => [policy, records.length]));
console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'audit', database: DB_PATH, candidates: repairs.length, byPolicy, sample: repairs.slice(0, 12).map(({ id, originalType, repairedType, policy }) => ({ id, originalType, repairedType, policy })) }, null, 2));

if (!APPLY || repairs.length === 0) {
  db.close();
  process.exit(0);
}

db.transaction(() => {
  db.run(`CREATE TABLE IF NOT EXISTS observation_type_repair_audit (
    observation_id INTEGER PRIMARY KEY, original_type TEXT NOT NULL, repaired_type TEXT NOT NULL,
    policy TEXT NOT NULL, repaired_at_epoch INTEGER NOT NULL
  )`);
  const update = db.prepare(`UPDATE observations SET type=?, metadata=?, sync_rev=?, synced_at=NULL WHERE id=?`);
  const audit = db.prepare(`INSERT OR REPLACE INTO observation_type_repair_audit
    (observation_id, original_type, repaired_type, policy, repaired_at_epoch) VALUES (?, ?, ?, ?, ?)`);
  const now = Date.now();
  for (const repair of repairs) {
    // Replica rows remain locally corrected. Native rows are marked unsynced so
    // cloud sync can propagate the higher canonical revision.
    const nextRev = repair.originDeviceId === null ? incrementDecimal(repair.syncRev) : repair.syncRev;
    update.run(repair.repairedType, mergeAuditMetadata(repair.metadata, repair), nextRev, repair.id);
    audit.run(repair.id, repair.originalType, repair.repairedType, repair.policy, now);
  }
})();

const remaining = db.query(`SELECT COUNT(*) AS count FROM observations WHERE lower(trim(type)) NOT IN (${VALID_TYPES.map(() => '?').join(',')})`).get(...VALID_TYPES) as { count: number };
console.log(JSON.stringify({ repaired: repairs.length, remainingInvalid: remaining.count, integrity: db.query('PRAGMA integrity_check').all(), foreignKeys: db.query('PRAGMA foreign_key_check').all() }, null, 2));
db.close();
