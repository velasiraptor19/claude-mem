import { afterEach, describe, expect, it, mock } from 'bun:test';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { PendingMessage, PendingMessageWithId } from '../../src/services/worker-types.js';

// Growing batches retain the oldest malformed retry count and enter durable recovery.

const originalLoad = SettingsDefaultsManager.loadFromFile;
afterEach(() => { SettingsDefaultsManager.loadFromFile = originalLoad; });

function harness() {
  SettingsDefaultsManager.loadFromFile = (() => ({ ...SettingsDefaultsManager.getAllDefaults() })) as any;
  const manager = new SessionManager(null as any);
  const session: any = {
    sessionDbId: 1, contentSessionId: 'test', memorySessionId: 'test', project: 'test',
    abortController: new AbortController(), claimedMessageIds: [], earliestPendingTimestamp: null,
    conversationHistory: [], lastPromptNumber: 1, cumulativeInputTokens: 0, cumulativeOutputTokens: 0,
    consecutiveInvalidOutputs: 0, invalidOutputBatchKey: null, lastGeneratorSource: 'ingest',
  };
  (manager as any).sessions.set(1, session);
  const buffer = manager.getMessageBuffer();
  const db = {
    getSessionStore: () => ({
      storeObservations: mock(() => ({ observationIds: [], summaryId: null })),
      ensureMemorySessionIdRegistered: () => 'test',
    }),
    getChromaSync: () => null,
    getCloudSync: () => null,
  };
  const provider: any = new CodexProvider(db as any, manager);
  provider.conversationMaxChars = () => 1_000_000;
  // Neither observation XML nor the skip sentinel: a rejected reply.
  provider.query = async () => ({ content: 'I looked at the file.' });
  const enqueue = (message: Partial<PendingMessage> = {}) => buffer.enqueue(1, {
    type: 'observation', tool_name: 'Read', tool_input: { path: 'file' }, tool_response: 'data', prompt_number: 1, ...message,
  });
  // One generator attempt: reset like getMessageIterator, claim the head, process it.
  const attempt = async () => {
    session.abortController = new AbortController();
    session.abortReason = undefined;
    await manager.resetProcessingToPending(1);
    const head = manager.claimNextObservation(1, () => true)! as PendingMessageWithId;
    session.lastGeneratorSource = 'ingest';
    await provider.processObservationMessage(session, head, undefined, { model: '', apiKey: 'x' }, head._originalTimestamp, undefined);
    return session.abortReason as string | undefined;
  };
  return { buffer, enqueue, attempt, session, manager };
}

describe('a growing Codex batch has bounded malformed repair', () => {
  it('keeps the head retry count and durably queues the grown batch without dropping it', async () => {
    const h = harness();
    const recover = mock(async () => {});
    h.manager.setOnMalformedOutputExhausted(recover);
    const firstId = h.enqueue();
    expect(await h.attempt()).toBeUndefined();
    expect(h.session.consecutiveInvalidOutputs).toBe(1);
    expect(h.buffer.getPendingCount(1)).toBe(1);

    const secondId = h.enqueue();
    expect(await h.attempt()).toBeUndefined();
    expect(h.session.consecutiveInvalidOutputs).toBe(2);
    expect(h.buffer.getPendingCount(1)).toBe(2);
    expect(recover).not.toHaveBeenCalled();

    expect(await h.attempt()).toBeUndefined();
    expect(h.session.consecutiveInvalidOutputs).toBe(3);
    expect(recover).toHaveBeenCalledTimes(1);
    expect((recover.mock.calls[0] as any)[0].messages).toHaveLength(2);
    expect(h.buffer.getPendingCount(1)).toBe(0);
    expect(h.buffer.getMessagesByIds(1, [firstId, secondId])).toHaveLength(2);
  });
});
