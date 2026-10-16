import type { SessionStore } from '../sqlite/SessionStore.js';
import type { ParsedCodexTranscript } from './CodexTranscriptRecovery.js';

export interface FingerprintReconciliationReport {
  canonicalTurns: number;
  represented: number;
  summaryFingerprintsWritten: number;
  representationRowsWritten: number;
  ambiguous: Array<{ contentSessionId: string; promptNumber: number; reason: string }>;
}

type SummaryCandidate = {
  id: number;
  content_session_id: string;
  prompt_number: number | null;
  source_fingerprint: string | null;
};

const BACKFILL_ID = /^codex-backfill:([^:]+):p(\d+):(part-(\d+)|merged-v2)$/;

/**
 * Reconcile historical summaries using identity evidence only. Summary prose is
 * deliberately never compared: textual/fuzzy matching can attach durable
 * memory to the wrong turn.
 */
export class HistoricalFingerprintReconciler {
  constructor(private readonly store: SessionStore) {}

  reconcile(transcripts: ParsedCodexTranscript[], dryRun = true): FingerprintReconciliationReport {
    const report: FingerprintReconciliationReport = {
      canonicalTurns: 0,
      represented: 0,
      summaryFingerprintsWritten: 0,
      representationRowsWritten: 0,
      ambiguous: [],
    };
    const db = this.store.db;
    const originalQuery = db.prepare(`
      SELECT ss.id, s.content_session_id, ss.prompt_number, ss.source_fingerprint
      FROM sdk_sessions s JOIN session_summaries ss ON ss.memory_session_id=s.memory_session_id
      WHERE s.platform_source='codex' AND s.content_session_id=? AND ss.prompt_number=?
    `);
    const backfillQuery = db.prepare(`
      SELECT ss.id, s.content_session_id, ss.prompt_number, ss.source_fingerprint
      FROM sdk_sessions s JOIN session_summaries ss ON ss.memory_session_id=s.memory_session_id
      WHERE s.platform_source='codex' AND s.content_session_id LIKE ?
      ORDER BY ss.id
    `);
    const representedQuery = db.prepare('SELECT 1 FROM historical_summary_representations WHERE source_fingerprint=?');
    const insertRepresentation = db.prepare(`INSERT OR IGNORE INTO historical_summary_representations
      (source_fingerprint, summary_id, representation_kind, content_session_id, prompt_number, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const stampSummary = db.prepare(`UPDATE session_summaries SET source_fingerprint=?
      WHERE id=? AND source_fingerprint IS NULL`);

    const apply = db.transaction(() => {
      for (const transcript of transcripts) for (const turn of transcript.turns) {
        report.canonicalTurns += 1;
        if (this.store.hasSummaryFingerprint(turn.sourceFingerprint) || representedQuery.get(turn.sourceFingerprint)) {
          report.represented += 1;
          continue;
        }

        const originals = originalQuery.all(transcript.lineage.contentSessionId, turn.promptNumber) as SummaryCandidate[];
        if (originals.length > 1) {
          report.ambiguous.push({ contentSessionId: transcript.lineage.contentSessionId, promptNumber: turn.promptNumber, reason: 'multiple_original_summaries' });
          continue;
        }

        let candidate: SummaryCandidate | null = originals[0] ?? null;
        let kind: 'original' | 'backfill_part' | 'backfill_merged' = 'original';
        if (!candidate) {
          const rows = (backfillQuery.all(`codex-backfill:${transcript.lineage.contentSessionId}:p${turn.promptNumber}:%`) as SummaryCandidate[])
            .map(row => ({ row, match: BACKFILL_ID.exec(row.content_session_id) }))
            .filter(item => item.match && item.match[1] === transcript.lineage.contentSessionId && Number(item.match[2]) === turn.promptNumber);
          const merged = rows.filter(item => item.match![3] === 'merged-v2');
          if (merged.length > 1) {
            report.ambiguous.push({ contentSessionId: transcript.lineage.contentSessionId, promptNumber: turn.promptNumber, reason: 'multiple_merged_backfills' });
            continue;
          }
          if (merged.length === 1) {
            candidate = merged[0].row;
            kind = 'backfill_merged';
          } else {
            const parts = rows.filter(item => item.match![3].startsWith('part-'));
            if (parts.length === 1 && Number(parts[0].match![4]) === 1) {
              candidate = parts[0].row;
              kind = 'backfill_part';
            } else if (parts.length > 0) {
              report.ambiguous.push({ contentSessionId: transcript.lineage.contentSessionId, promptNumber: turn.promptNumber, reason: 'parts_without_provable_merged_summary' });
              continue;
            }
          }
        }
        if (!candidate) continue;
        if (candidate.source_fingerprint && candidate.source_fingerprint !== turn.sourceFingerprint) {
          report.ambiguous.push({ contentSessionId: transcript.lineage.contentSessionId, promptNumber: turn.promptNumber, reason: 'conflicting_existing_fingerprint' });
          continue;
        }
        report.represented += 1;
        if (dryRun) continue;
        if (!candidate.source_fingerprint) report.summaryFingerprintsWritten += stampSummary.run(turn.sourceFingerprint, candidate.id).changes;
        report.representationRowsWritten += insertRepresentation.run(
          turn.sourceFingerprint, candidate.id, kind, transcript.lineage.contentSessionId,
          turn.promptNumber, Date.now(),
        ).changes;
      }
    });
    apply();
    return report;
  }
}
