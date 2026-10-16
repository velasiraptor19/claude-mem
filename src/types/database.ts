
export interface TableColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface IndexInfo {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

export interface TableNameRow {
  name: string;
}

export interface SchemaVersion {
  version: number;
}

export interface ObservationRecord {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  created_at: string;
  created_at_epoch: number;
  title?: string;
  concept?: string;
  prompt_number?: number;
  discovery_tokens?: number;
}

export interface SessionSummaryRecord {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
  created_at_epoch: number;
  prompt_number?: number;
  discovery_tokens?: number;
}

export interface UserPromptRecord {
  id: number;
  session_db_id?: number | null;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  project?: string;  
  platform_source?: string;
  created_at: string;
  created_at_epoch: number;
}

export interface AdvisorCallRecord {
  id: number;
  session_db_id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  tool_use_id: string;
  advisor_model: string | null;
  cwd: string | null;
  last_user_message: string | null;
  transcript_path: string | null;
  transcript_byte_offset: number | null;
  advice: string;
  occurred_at_epoch: number;
  created_at: string;
  created_at_epoch: number;
}

export interface LatestPromptResult {
  id: number;
  session_db_id?: number | null;
  content_session_id: string;
  memory_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export type RecoveryJobStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'completed'
  | 'dead_letter'
  | 'cancelled';

/** Known cancellation reasons written by claude-mem. NULL is retained for legacy automatic cancellations. */
export type KnownRecoveryCancellationReason = 'manual' | 'superseded_turn_mismatch' | 'historical_scan';

/**
 * SQLite stores cancellation_reason as free-form TEXT, so readers must retain
 * unknown values from future versions or external maintenance tools.
 */
export type RecoveryCancellationReason = KnownRecoveryCancellationReason | (string & {});

/** Only historical/system cancellations may be retried by a historical scan. */
export const AUTO_REVIVABLE_RECOVERY_CANCELLATION_REASONS = [
  'historical_scan',
  'superseded_turn_mismatch',
] as const satisfies readonly KnownRecoveryCancellationReason[];

export function isAutoRevivableRecoveryCancellation(reason: RecoveryCancellationReason | null): boolean {
  return reason === null || AUTO_REVIVABLE_RECOVERY_CANCELLATION_REASONS.includes(reason as typeof AUTO_REVIVABLE_RECOVERY_CANCELLATION_REASONS[number]);
}

export interface RecoveryJobRecord {
  id: number;
  content_session_id: string;
  recovery_kind: string;
  project: string;
  platform_source: string;
  transcript_locator: string | null;
  reason: string;
  first_failure_at_epoch: number;
  last_failure_at_epoch: number;
  attempts: number;
  next_attempt_at_epoch: number;
  status: RecoveryJobStatus;
  provider: string | null;
  model: string | null;
  last_sanitized_error: string | null;
  lease_owner: string | null;
  lease_expires_at_epoch: number | null;
  created_at_epoch: number;
  updated_at_epoch: number;
  completed_at_epoch: number | null;
  recovery_key: string;
  source_fingerprint: string | null;
  prompt_number: number | null;
  turn_id: string | null;
  parent_content_session_id: string | null;
  root_content_session_id: string | null;
  agent_id: string | null;
  transcript_sha256: string | null;
  dead_letter_reason: string | null;
  cancellation_reason: RecoveryCancellationReason | null;
}

export interface EnqueueRecoveryJobInput {
  contentSessionId: string;
  recoveryKind: string;
  project: string;
  platformSource: string;
  transcriptLocator?: string | null;
  reason: string;
  provider?: string | null;
  model?: string | null;
  sanitizedError?: string | null;
  nowEpoch?: number;
  nextAttemptAtEpoch?: number;
  recoveryKey?: string;
  sourceFingerprint?: string | null;
  promptNumber?: number | null;
  turnId?: string | null;
  parentContentSessionId?: string | null;
  rootContentSessionId?: string | null;
  agentId?: string | null;
  transcriptSha256?: string | null;
}

export interface SessionLineageInput {
  parentContentSessionId?: string | null;
  rootContentSessionId?: string | null;
  agentId?: string | null;
  agentType?: string | null;
  agentPath?: string | null;
  agentNickname?: string | null;
  agentDepth?: number | null;
  transcriptLocator?: string | null;
}
