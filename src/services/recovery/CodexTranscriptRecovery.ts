import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';

export interface CodexLineage {
  contentSessionId: string;
  parentContentSessionId: string | null;
  rootContentSessionId: string;
  agentId: string | null;
  agentType: 'main' | 'subagent';
  agentPath: string | null;
  agentNickname: string | null;
  agentDepth: number;
  cwd: string | null;
}

export interface CanonicalToolEvidence {
  kind: 'function_call_output' | 'tool_output';
  callId: string | null;
  source: string | null;
  content: string;
}

export interface CanonicalRecoveryTurn {
  promptNumber: number;
  turnId: string;
  userMessage: string;
  finalAssistantMessage: string | null;
  toolEvidence: CanonicalToolEvidence[];
  occurredAtEpoch: number;
  /** True only when the canonical event that opened this turn supplied a parseable timestamp. */
  hasAuthoritativeTimestamp: boolean;
  sourceFingerprint: string;
  completionState: 'completed' | 'aborted' | 'incomplete';
  corruptionLines: number[];
}

export interface ParsedCodexTranscript {
  locator: string;
  transcriptSha256: string;
  lineage: CodexLineage;
  turns: CanonicalRecoveryTurn[];
  corruptions: Array<{ line: number; turnId: string | null }>;
}

const stringAt = (value: unknown, ...path: string[]): string | null => {
  let current: unknown = value;
  for (const part of path) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined;
  return typeof current === 'string' && current.trim() ? current.trim() : null;
};
const numberAt = (value: unknown, ...path: string[]): number | null => {
  let current: unknown = value;
  for (const part of path) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined;
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
};
export const sha256Text = (value: string) => createHash('sha256').update(value).digest('hex');

function textContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const text = value.map(item => typeof item === 'string'
    ? item
    : stringAt(item, 'text') ?? stringAt(item, 'content') ?? stringAt(item, 'output_text') ?? '')
    .filter(Boolean).join('\n').trim();
  return text || null;
}

function eventText(entry: Record<string, unknown>): string | null {
  const payload = entry.payload as Record<string, unknown> | undefined;
  return textContent(payload?.content) ?? textContent(payload?.message) ?? textContent(payload?.output)
    ?? textContent(entry.content) ?? stringAt(payload, 'text');
}

function turnFingerprint(contentSessionId: string, turn: Omit<CanonicalRecoveryTurn, 'sourceFingerprint'>): string {
  return sha256Text(JSON.stringify({
    session: contentSessionId,
    turn: turn.turnId,
    prompt: turn.promptNumber,
    user: turn.userMessage,
    assistant: turn.finalAssistantMessage,
    tools: turn.toolEvidence,
  }));
}

interface PendingToolCall {
  kind: CanonicalToolEvidence['kind'];
  source: string;
}

/** Parse the actual Codex JSONL envelope: outer type and payload subtype are distinct. */
export function parseCodexTranscriptText(locator: string, raw: string): ParsedCodexTranscript {
  const transcriptSha256 = sha256Text(raw);
  type ParsedLine = { entry: Record<string, unknown>; line: number } | { entry: null; line: number };
  const entries: ParsedLine[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line) continue;
    try { entries.push({ entry: JSON.parse(line) as Record<string, unknown>, line: index + 1 }); }
    catch { entries.push({ entry: null, line: index + 1 }); }
  }
  const meta = entries.find(item => item.entry?.type === 'session_meta')?.entry;
  if (!meta) throw new Error(`missing_session_meta:${locator}`);
  const spawn = (meta.payload as any)?.source?.subagent?.thread_spawn ?? {};
  const contentSessionId = stringAt(meta, 'payload', 'id');
  if (!contentSessionId) throw new Error(`missing_session_id:${locator}`);
  const parent = stringAt(meta, 'payload', 'parent_thread_id') ?? (typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : null);
  const root = stringAt(meta, 'payload', 'session_id') ?? contentSessionId;
  const depth = numberAt(meta, 'payload', 'source', 'subagent', 'thread_spawn', 'depth') ?? (parent ? 1 : 0);
  const lineage: CodexLineage = {
    contentSessionId,
    parentContentSessionId: parent,
    rootContentSessionId: root,
    agentId: parent ? contentSessionId : null,
    agentType: parent ? 'subagent' : 'main',
    agentPath: stringAt(meta, 'payload', 'source', 'subagent', 'thread_spawn', 'agent_path'),
    agentNickname: stringAt(meta, 'payload', 'source', 'subagent', 'thread_spawn', 'agent_nickname'),
    agentDepth: depth,
    cwd: stringAt(meta, 'payload', 'cwd'),
  };

  // Codex >=0.146 forked subagent transcripts begin with a complete replay of
  // the parent transcript. The replay is stamped at fork time, but preserves
  // each historical task_started.payload.started_at value. Only the first task
  // whose start epoch reaches the child session's own creation epoch belongs
  // to the child. Without this boundary every parent turn is summarized once
  // per subagent, polluting memory and creating hundreds of duplicate jobs.
  let firstOwnedLine = 0;
  if (lineage.agentType === 'subagent') {
    const childStartedAt = Date.parse(stringAt(meta, 'payload', 'timestamp') ?? stringAt(meta, 'timestamp') ?? '');
    const containsParentReplay = entries.some((item, index) => index > 0
      && item.entry?.type === 'session_meta'
      && stringAt(item.entry, 'payload', 'id') === lineage.parentContentSessionId);
    if (containsParentReplay && Number.isFinite(childStartedAt)) {
      const childStartedAtSeconds = Math.floor(childStartedAt / 1000);
      firstOwnedLine = entries.find(item => item.entry?.type === 'event_msg'
        && stringAt(item.entry, 'payload', 'type') === 'task_started'
        && (numberAt(item.entry, 'payload', 'started_at') ?? Number.NEGATIVE_INFINITY) >= childStartedAtSeconds)?.line ?? 0;
      if (!firstOwnedLine) throw new Error(`missing_subagent_replay_boundary:${locator}`);
    }
  }

  const turns: CanonicalRecoveryTurn[] = [];
  let current: Omit<CanonicalRecoveryTurn, 'sourceFingerprint'> | null = null;
  let activeTurnId: string | null = null;
  let promptNumber = 0;
  let pendingResponseUser: string | null = null;
  let pendingAssistant: string | null = null;
  let currentCorruptionLines: number[] = [];
  let pendingCorruptionLines: number[] = [];
  const corruptions: Array<{ line: number; turnId: string | null }> = [];
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const flush = () => {
    if (!current) return;
    if (current.finalAssistantMessage || current.toolEvidence.length) {
      if (currentCorruptionLines.length) current.completionState = 'incomplete';
      current.corruptionLines = [...currentCorruptionLines];
      turns.push({ ...current, sourceFingerprint: turnFingerprint(contentSessionId, current) });
    }
    current = null;
    currentCorruptionLines = [];
    pendingAssistant = null;
    pendingToolCalls.clear();
  };
  const begin = (text: string, timestamp: number, hasAuthoritativeTimestamp: boolean) => {
    flush();
    promptNumber += 1;
    current = {
      promptNumber,
      turnId: activeTurnId ?? `${contentSessionId}:${promptNumber}`,
      userMessage: text,
      finalAssistantMessage: null,
      toolEvidence: [],
      occurredAtEpoch: timestamp,
      hasAuthoritativeTimestamp,
      completionState: 'incomplete',
      corruptionLines: [],
    };
    currentCorruptionLines = pendingCorruptionLines;
    pendingCorruptionLines = [];
  };

  for (const item of entries) {
    if (firstOwnedLine && item.line < firstOwnedLine) continue;
    if (!item.entry) {
      const turnId = activeTurnId;
      corruptions.push({ line: item.line, turnId });
      if (current) currentCorruptionLines.push(item.line);
      else pendingCorruptionLines.push(item.line);
      continue;
    }
    const entry = item.entry;
    const outerType = String(entry.type ?? '');
    const payloadSubtype = stringAt(entry, 'payload', 'type') ?? '';
    const role = stringAt(entry, 'payload', 'role');
    const parsedTimestamp = Date.parse(stringAt(entry, 'timestamp') ?? stringAt(entry, 'payload', 'timestamp') ?? '');
    const hasAuthoritativeTimestamp = Number.isFinite(parsedTimestamp);
    const timestamp = hasAuthoritativeTimestamp ? parsedTimestamp : 0;

    if (outerType === 'event_msg' && payloadSubtype === 'task_started') {
      // A new task is a deterministic boundary even when the prior task lacks a
      // terminal event. Only evidence-bearing incomplete work survives flush().
      flush();
      activeTurnId = stringAt(entry, 'payload', 'turn_id');
      continue;
    }
    if (outerType === 'response_item' && payloadSubtype === 'message' && role === 'user') {
      pendingResponseUser = eventText(entry);
      continue;
    }
    if (outerType === 'event_msg' && payloadSubtype === 'user_message') {
      const text = stringAt(entry, 'payload', 'message') ?? eventText(entry) ?? pendingResponseUser;
      pendingResponseUser = null;
      if (text) begin(text, timestamp, hasAuthoritativeTimestamp);
      continue;
    }
    const isTurnWorkItem = outerType === 'response_item' && (
      (payloadSubtype === 'message' && role === 'assistant')
      || payloadSubtype === 'function_call'
      || payloadSubtype === 'custom_tool_call'
      || payloadSubtype === 'tool_search_call'
    );
    if (!current && pendingResponseUser && isTurnWorkItem) {
      begin(pendingResponseUser, timestamp, hasAuthoritativeTimestamp);
      pendingResponseUser = null;
    }
    // Older/subagent transcripts may omit event_msg.user_message. A task-complete
    // boundary is the only safe point at which to promote the pending user item.
    if (outerType === 'event_msg' && payloadSubtype === 'task_complete' && !current && pendingResponseUser) {
      begin(pendingResponseUser, timestamp, hasAuthoritativeTimestamp);
      pendingResponseUser = null;
    }
    if (!current) continue;
    const active = current as Omit<CanonicalRecoveryTurn, 'sourceFingerprint'>;

    if (outerType === 'event_msg' && payloadSubtype === 'task_complete') {
      const completedTurnId = stringAt(entry, 'payload', 'turn_id');
      if (completedTurnId && completedTurnId !== active.turnId) continue;
      active.finalAssistantMessage = stringAt(entry, 'payload', 'last_agent_message') ?? pendingAssistant;
      active.completionState = 'completed';
      flush();
      activeTurnId = null;
    } else if (outerType === 'event_msg' && payloadSubtype === 'turn_aborted') {
      const abortedTurnId = stringAt(entry, 'payload', 'turn_id');
      if (abortedTurnId && abortedTurnId !== active.turnId) continue;
      active.completionState = 'aborted';
      // Assistant prose before an abort is not a final answer. Paired tool output
      // remains admissible evidence and allows an explicit incomplete summary.
      active.finalAssistantMessage = null;
      flush();
      activeTurnId = null;
    } else if (outerType === 'response_item' && payloadSubtype === 'message' && role === 'assistant') {
      pendingAssistant = eventText(entry) ?? pendingAssistant;
    } else if (outerType === 'response_item' && (payloadSubtype === 'function_call' || payloadSubtype === 'custom_tool_call' || payloadSubtype === 'tool_search_call')) {
      const callId = stringAt(entry, 'payload', 'call_id');
      const source = stringAt(entry, 'payload', 'name')
        ?? (payloadSubtype === 'tool_search_call' ? 'tool_search' : null);
      if (callId && source) pendingToolCalls.set(callId, {
        kind: payloadSubtype === 'function_call' ? 'function_call_output' : 'tool_output',
        source,
      });
    } else if (outerType === 'response_item' && (payloadSubtype === 'function_call_output' || payloadSubtype === 'custom_tool_call_output' || payloadSubtype === 'tool_search_output')) {
      const callId = stringAt(entry, 'payload', 'call_id');
      const call = callId ? pendingToolCalls.get(callId) : null;
      const evidence = eventText(entry);
      if (callId && call && evidence) active.toolEvidence.push({
        kind: call.kind,
        callId,
        source: call.source,
        content: evidence.slice(0, 12_000),
      });
    }
  }
  flush();
  return { locator, transcriptSha256, lineage, turns, corruptions };
}

export function parseCodexTranscript(locator: string): ParsedCodexTranscript {
  if (!existsSync(locator)) throw new Error(`missing_transcript:${locator}`);
  return parseCodexTranscriptText(locator, readFileSync(locator, 'utf8'));
}

/** Recovery scans use asynchronous IO so a large history cannot block HTTP/worker timers. */
export async function parseCodexTranscriptAsync(locator: string): Promise<ParsedCodexTranscript> {
  try { return parseCodexTranscriptText(locator, await readFile(locator, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error(`missing_transcript:${locator}`);
    throw error;
  }
}

export function recoveryKeyFor(transcript: ParsedCodexTranscript, turn: CanonicalRecoveryTurn): string {
  return sha256Text(['codex', transcript.lineage.contentSessionId, turn.promptNumber, turn.turnId, turn.sourceFingerprint].join(':'));
}
