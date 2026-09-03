import { Database } from 'bun:sqlite';
import { ChromaMcpManager } from '../src/services/sync/ChromaMcpManager.js';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.CLAUDE_MEM_DB ?? '/root/.claude-mem/claude-mem.db';
const COLLECTION = 'cm__claude-mem';
const BATCH_SIZE = 100;

const db = new Database(DB_PATH, { readonly: true });
const rows = db.query(`SELECT DISTINCT o.id, o.type, o.title FROM observations o
  LEFT JOIN observation_type_repair_audit type_audit ON type_audit.observation_id = o.id
  LEFT JOIN observation_title_repair_audit title_audit ON title_audit.observation_id = o.id
  WHERE type_audit.observation_id IS NOT NULL OR title_audit.observation_id IS NOT NULL
  ORDER BY o.id`).all() as Array<{ id: number; type: string; title: string | null }>;
db.close();

console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'audit', database: DB_PATH, collection: COLLECTION, observations: rows.length }, null, 2));
if (!APPLY || rows.length === 0) process.exit(0);

const chroma = ChromaMcpManager.getInstance();
let updatedDocuments = 0;
let missingDocuments = 0;
try {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const observationById = new Map(batch.map(row => [row.id, row]));
    const found = await chroma.callTool('chroma_get_documents', {
      collection_name: COLLECTION,
      where: { $and: [{ doc_type: 'observation' }, { sqlite_id: { $in: batch.map(row => row.id) } }] },
      include: ['metadatas']
    }) as { ids?: string[]; metadatas?: Array<Record<string, unknown> | null> };
    const ids = found.ids ?? [];
    const metadatas = (found.metadatas ?? []).map(metadata => {
      const sqliteId = Number(metadata?.sqlite_id);
      const observation = observationById.get(sqliteId);
      return {
        ...(metadata ?? {}),
        type: observation?.type ?? String(metadata?.type ?? 'discovery'),
        title: observation?.title ?? String(metadata?.title ?? 'Untitled')
      };
    });
    const foundObservationIds = new Set((found.metadatas ?? []).map(metadata => Number(metadata?.sqlite_id)));
    missingDocuments += batch.filter(row => !foundObservationIds.has(row.id)).length;
    if (ids.length > 0) {
      await chroma.callTool('chroma_update_documents', { collection_name: COLLECTION, ids, metadatas });
      updatedDocuments += ids.length;
    }
  }
  console.log(JSON.stringify({ updatedDocuments, observationsWithoutVectorDocuments: missingDocuments }, null, 2));
} finally {
  await chroma.stop();
}
