import { Database } from 'bun:sqlite';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.CLAUDE_MEM_DB ?? '/root/.claude-mem/claude-mem.db';
const FIELDS = ['subtitle', 'narrative'] as const;
type Field = typeof FIELDS[number];

type Row = {
  id: number;
  subtitle: string | null;
  narrative: string | null;
  metadata: string | null;
  origin_device_id: string | null;
  sync_rev: string;
};
type FieldRepair = { field: Field; original: string; repaired: string };
type Repair = Row & { fields: FieldRepair[] };

function normalizeFieldLabel(value: string, field: Field): string | null {
  const trimmed = value.trim();
  const match = new RegExp(`^\\[\\*\\*${field}\\*\\*:\\s*`, 'i').exec(trimmed);
  if (!match) return null;
  const content = trimmed.slice(match[0].length).trim();
  const repaired = (content.endsWith(']') ? content.slice(0, -1) : content).trim();
  return repaired || null;
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
  const prior = metadata.claude_mem_field_label_repair;
  metadata.claude_mem_field_label_repair = {
    ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior as Record<string, unknown> : {}),
    ...Object.fromEntries(repair.fields.map(field => [field.field, {
      original_value: field.original,
      repaired_value: field.repaired,
      repaired_at_epoch: Date.now(),
    }])),
  };
  return JSON.stringify(metadata);
}

const db = APPLY ? new Database(DB_PATH) : new Database(DB_PATH, { readonly: true });
const rows = db.query(`SELECT id, subtitle, narrative, metadata, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
  FROM observations WHERE subtitle IS NOT NULL OR narrative IS NOT NULL`).all() as Row[];
const repairs: Repair[] = rows.flatMap(row => {
  const fields = FIELDS.flatMap(field => {
    const original = row[field];
    const repaired = original ? normalizeFieldLabel(original, field) : null;
    return repaired && repaired !== original ? [{ field, original, repaired }] : [];
  });
  return fields.length > 0 ? [{ ...row, fields }] : [];
});

console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'audit', database: DB_PATH, observations: repairs.length,
  fields: Object.fromEntries(FIELDS.map(field => [field, repairs.reduce((count, repair) => count + Number(repair.fields.some(item => item.field === field)), 0)])),
  sample: repairs.slice(0, 8).map(repair => ({ id: repair.id, fields: repair.fields })),
}, null, 2));
if (!APPLY || repairs.length === 0) { db.close(); process.exit(0); }

db.transaction(() => {
  db.run(`CREATE TABLE IF NOT EXISTS observation_field_label_repair_audit (
    observation_id INTEGER NOT NULL, field_name TEXT NOT NULL, original_value TEXT NOT NULL,
    repaired_value TEXT NOT NULL, repaired_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (observation_id, field_name)
  )`);
  const audit = db.prepare(`INSERT OR REPLACE INTO observation_field_label_repair_audit
    (observation_id, field_name, original_value, repaired_value, repaired_at_epoch) VALUES (?, ?, ?, ?, ?)`);
  const now = Date.now();
  for (const repair of repairs) {
    const sets = repair.fields.map(field => `${field.field}=?`);
    const values: Array<string | number | null> = repair.fields.map(field => field.repaired);
    values.push(metadataWithAudit(repair.metadata, repair));
    values.push(repair.origin_device_id === null ? incrementDecimal(repair.sync_rev) : repair.sync_rev);
    values.push(repair.id);
    db.prepare(`UPDATE observations SET ${sets.join(', ')}, metadata=?, sync_rev=?, synced_at=NULL WHERE id=?`).run(...values);
    for (const field of repair.fields) audit.run(repair.id, field.field, field.original, field.repaired, now);
  }
})();

const remaining = (db.query('SELECT subtitle, narrative FROM observations WHERE subtitle IS NOT NULL OR narrative IS NOT NULL').all() as Array<Pick<Row, Field>>)
  .reduce((count, row) => count + FIELDS.reduce((fieldCount, field) => fieldCount + Number(Boolean(row[field] && normalizeFieldLabel(row[field]!, field))), 0), 0);
console.log(JSON.stringify({ repaired: repairs.length, remainingMalformed: remaining, integrity: db.query('PRAGMA integrity_check').all(), foreignKeys: db.query('PRAGMA foreign_key_check').all() }, null, 2));
db.close();
