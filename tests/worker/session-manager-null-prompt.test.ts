import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function makeDbManager(userPrompt: string | null): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: userPrompt,
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
    }),
  } as unknown as DatabaseManager;
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('SessionManager with NULL user_prompt (worker-restart stale-session window)', () => {
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(s => s.mockRestore());
  });

  it('initializeSession does not throw when the db row has NULL user_prompt and no current prompt is provided', () => {
    const sm = new SessionManager(makeDbManager(null));

    const session = sm.initializeSession(1);

    expect(session.contentSessionId).toBe('content-123');
    expect(session.userPrompt ?? null).toBeNull();
  });

  it('cached-session paths tolerate a NULL cached prompt and accept a fresh one', () => {
    const sm = new SessionManager(makeDbManager(null));
    sm.initializeSession(1);

    // Cached session, still no prompt: logs the cached (null) prompt.
    expect(() => sm.initializeSession(1)).not.toThrow();

    // Cached session, fresh prompt arrives: logs old (null) prompt, then updates.
    const session = sm.initializeSession(1, 'fresh prompt', 2);
    expect(session.userPrompt).toBe('fresh prompt');
    expect(session.lastPromptNumber).toBe(2);
  });

  it('emits exhausted malformed batches once and keeps them quarantined', async () => {
    const sm = new SessionManager(makeDbManager('prompt'));
    sm.initializeSession(1);
    await sm.queueObservation(1, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'tool-1',
    });
    const exhausted = mock(() => Promise.reject(new Error('durable service unavailable')));
    sm.setOnMalformedOutputExhausted(exhausted);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const iterator = sm.getMessageIterator(1);
      expect((await iterator.next()).done).toBe(false);
      await expect(sm.handleMalformedOutput(1, {
        outputClass: 'prose', preview: 'bad output', agentName: 'TestAgent',
      })).resolves.toEqual({ retry: attempt <= 2, retryCount: attempt });
      await iterator.return?.();
    }

    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(exhausted).toHaveBeenCalledWith(expect.objectContaining({
      sessionDbId: 1,
      retryCount: 3,
      messages: [expect.objectContaining({ toolUseId: 'tool-1' })],
    }));
    expect(await sm.resetProcessingToPending(1)).toBe(0);
    expect(sm.getTotalQueueDepth()).toBe(1);
  });
});
