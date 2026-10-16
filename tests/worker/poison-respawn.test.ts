import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import { startGeneratorWithProvider } from '../../src/services/worker/session/GeneratorRunner.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';

function makeDbManager(storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }))): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      ensureMemorySessionIdRegistered: () => {},
      storeObservations,
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

const makeWorker = (): WorkerRef => ({
  broadcastProcessingStatus: mock(() => {}),
}) as unknown as WorkerRef;

async function queueAndClaimOne(sm: SessionManager, sessionDbId: number): Promise<void> {
  await sm.queueObservation(sessionDbId, {
    tool_name: 'Read',
    tool_input: {},
    tool_response: {},
    prompt_number: 1,
    toolUseId: `tu-${sessionDbId}`,
  });

  const iterator = sm.getMessageIterator(sessionDbId);
  const claimed = await iterator.next();
  expect(claimed.done).toBe(false);
  expect(sm.getMessageBuffer().getPendingCount(sessionDbId)).toBe(1);
  await iterator.return?.();
}

async function claimAgain(sm: SessionManager, sessionDbId: number): Promise<void> {
  const iterator = sm.getMessageIterator(sessionDbId);
  const claimed = await iterator.next();
  expect(claimed.done).toBe(false);
  await iterator.return?.();
}

/** What a restarted generator starts from: a live controller and no reason. */
function restartGeneration(session: { abortController: AbortController; abortReason?: string | null }): void {
  session.abortController = new AbortController();
  session.abortReason = null;
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('observer invalid-output handling (Phase 3 recovery)', () => {
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
    mock.restore();
  });

  it('quarantines context-window prose without acknowledging or discarding the claimed batch', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(1, 'do the thing', 1);
    session.memorySessionId = 'mem-1';
    await queueAndClaimOne(sm, 1);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'I hit the context window and cannot continue <observation>',
      session,
      makeDbManager(),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(1)).toBe(1);
    expect(session.consecutiveInvalidOutputs).toBe(1);
    expect(session.abortController.signal.aborted).toBe(false);
    expect(session.abortReason ?? null).toBeNull();
  });

  it('repeated no-op prose is bounded and quarantined without losing work', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(2, 'do the thing', 1);
    session.memorySessionId = 'mem-2';
    await queueAndClaimOne(sm, 2);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const answer = () => processAgentResponse(
      'No observations to record.', session, makeDbManager(), sm, makeWorker(), 0, null, 'TestAgent',
    );

    for (let i = 0; i < 5; i++) {
      await processAgentResponse(
        'No observations to record.',
        session,
        makeDbManager(),
        sm,
        makeWorker(),
        0,
        null,
        'TestAgent',
      );
      expect(session.abortController.signal.aborted).toBe(false);
    }

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(2)).toBe(1);
  });

  it('pauses on weekly-limit quota prose and preserves claimed pending work', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(3, 'do the thing', 1);
    session.memorySessionId = 'mem-3';
    await queueAndClaimOne(sm, 3);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'Claude usage limit reached. Your weekly limit will reset soon, so please try again later.',
      session,
      makeDbManager(storeObservations),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(3);
    expect(sm.getMessageBuffer().getPendingCount(3)).toBe(1);
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.abortReason).toBe('quota:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(worker.broadcastProcessingStatus).toHaveBeenCalled();
    expect(storeObservations).not.toHaveBeenCalled();
  });

  it('pauses on auth-failure prose without confirming or storing the claimed batch', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(7, 'do the thing', 1);
    session.memorySessionId = 'mem-7';
    await queueAndClaimOne(sm, 7);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');
    const worker = makeWorker();

    await processAgentResponse(
      'Failed to authenticate. API Error: 401 · Please run /login',
      session,
      makeDbManager(storeObservations),
      sm,
      worker,
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(7);
    expect(storeObservations).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(7)).toBe(1);
    expect(session.claimedMessageIds).toEqual([]);
    expect(session.earliestPendingTimestamp).not.toBeNull();
    expect(session.abortReason).toBe('auth:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
    expect(worker.broadcastProcessingStatus).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('pauses on a bare unauthorized status and preserves the claimed batch', async () => {
    const storeObservations = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }));
    const sm = new SessionManager(makeDbManager(storeObservations));
    const session = sm.initializeSession(9, 'do the thing', 1);
    session.memorySessionId = 'mem-9';
    await queueAndClaimOne(sm, 9);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    await processAgentResponse(
      '401 Unauthorized',
      session,
      makeDbManager(storeObservations),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).toHaveBeenCalledWith(9);
    expect(storeObservations).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(9)).toBe(1);
    expect(session.abortReason).toBe('auth:observer_text');
    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('preserves unrelated login prose as malformed output pending repair', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(10, 'do the thing', 1);
    session.memorySessionId = 'mem-10';
    await queueAndClaimOne(sm, 10);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    await processAgentResponse(
      'Please run /login in the observed project instructions.',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(10)).toBe(1);
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('preserves project auth-guide prose as malformed output pending repair', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(11, 'do the thing', 1);
    session.memorySessionId = 'mem-11';
    await queueAndClaimOne(sm, 11);

    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const resetSpy = spyOn(sm, 'resetProcessingToPending');

    await processAgentResponse(
      'The project authentication guide says to run /login before testing.',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(11)).toBe(1);
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('auth generator exit keeps the active session and in-memory buffer', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(8, 'do the thing', 1);
    session.memorySessionId = 'mem-8';
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await queueAndClaimOne(sm, 8);

    await processAgentResponse(
      'Failed to authenticate. API Error: 401 · Please run /login',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    const finalizeSession = mock(() => Promise.resolve());
    const removeSpy = spyOn(sm, 'removeSessionImmediate');

    await handleGeneratorExit(session, session.abortReason, {
      sessionManager: sm,
      completionHandler: { finalizeSession } as any,
    });

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(sm.getSession(8)).toBe(session);
    expect(sm.getMessageBuffer().getPendingCount(8)).toBe(1);
  });

  it('quota generator exit keeps the active session and in-memory buffer', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(6, 'do the thing', 1);
    session.memorySessionId = 'mem-6';
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await queueAndClaimOne(sm, 6);

    await processAgentResponse(
      'Claude usage limit reached. Your weekly limit will reset soon.',
      session,
      makeDbManager(),
      sm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    const finalizeSession = mock(() => Promise.resolve());
    const removeSpy = spyOn(sm, 'removeSessionImmediate');

    await handleGeneratorExit(session, session.abortReason, {
      sessionManager: sm,
      completionHandler: { finalizeSession } as any,
    });

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(sm.getSession(6)).toBe(session);
    expect(sm.getMessageBuffer().getPendingCount(6)).toBe(1);
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
  });

  it('acknowledges explicit skip but preserves quota pauses', async () => {
    const skipSm = new SessionManager(makeDbManager());
    const skipSession = skipSm.initializeSession(4, 'do the thing', 1);
    skipSession.memorySessionId = 'mem-4';
    await queueAndClaimOne(skipSm, 4);

    await processAgentResponse(
      '<skip_summary reason="noise" />',
      skipSession,
      makeDbManager(),
      skipSm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    const quotaSm = new SessionManager(makeDbManager());
    const quotaSession = quotaSm.initializeSession(5, 'do the thing', 1);
    quotaSession.memorySessionId = 'mem-5';
    await queueAndClaimOne(quotaSm, 5);

    await processAgentResponse(
      'Your subscription weekly quota has been exhausted and resets later.',
      quotaSession,
      makeDbManager(),
      quotaSm,
      makeWorker(),
      0,
      null,
      'TestAgent',
    );

    expect(skipSm.getMessageBuffer().getPendingCount(4)).toBe(0);
    expect(quotaSm.getMessageBuffer().getPendingCount(5)).toBe(1);
  });
});

describe('a batch asked for again resumes at once, in a fresh generation (#3624)', () => {
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
    mock.restore();
  });

  it('starts the next generator on the next tick after an output_retry pause', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(16, 'do the thing', 1);
    session.memorySessionId = 'mem-16';
    await queueAndClaimOne(sm, 16);
    const ensureGeneratorRunning = mock(async () => {});
    const finalizeSession = mock(() => Promise.resolve());

    await startGeneratorWithProvider(session, 'claude', 'observation', null, null, {
      sessionManager: sm,
      // What ResponseProcessor leaves behind for a rejected reply: the batch
      // back in the queue, the generator stopped with the retry reason.
      sdkAgent: {
        startSession: async (current: ActiveSession) => {
          await sm.resetProcessingToPending(current.sessionDbId);
          current.abortReason = 'output_retry:prose';
          current.abortController.abort();
        },
      } as any,
      geminiAgent: {} as any,
      openRouterAgent: {} as any,
      workerService: {} as any,
      completionHandler: { finalizeSession } as any,
      ensureGeneratorRunning,
      maybeSelfHealStaleClaudeSpawn: () => false,
    });
    await session.generatorPromise;

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(session.pausedReason).toBe('output_retry');
    expect(sm.getMessageBuffer().getPendingCount(16)).toBe(1);
    expect(session.scheduledResumeTimer).toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ensureGeneratorRunning).toHaveBeenCalledWith(16, 'output-retry');
  });

  it('starts a fresh generation on the next tick after a schema-drift pause (#3461)', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(17, 'do the thing', 1);
    session.memorySessionId = 'mem-17';
    await queueAndClaimOne(sm, 17);
    const ensureGeneratorRunning = mock(async () => {});
    const finalizeSession = mock(() => Promise.resolve());

    await startGeneratorWithProvider(session, 'claude', 'observation', null, null, {
      sessionManager: sm,
      // What ResponseProcessor leaves behind after the third drifted reply in a
      // row: the batch was stored and confirmed, the generation ended.
      sdkAgent: {
        startSession: async (current: ActiveSession) => {
          current.abortReason = 'drift:observer_schema';
          current.abortController.abort();
        },
      } as any,
      geminiAgent: {} as any,
      openRouterAgent: {} as any,
      workerService: {} as any,
      completionHandler: { finalizeSession } as any,
      ensureGeneratorRunning,
      maybeSelfHealStaleClaudeSpawn: () => false,
    });
    await session.generatorPromise;

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(session.pausedReason).toBe('drift');
    expect(sm.getSession(17)).toBe(session);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(ensureGeneratorRunning).toHaveBeenCalledWith(17, 'schema-drift');
  });
});
