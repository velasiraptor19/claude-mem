import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ReleaseWindowManager } from '../../src/services/release/ReleaseWindow.js';
import { WorkerService } from '../../src/services/worker-service.js';
import { RecoveryRoutes } from '../../src/services/worker/http/routes/RecoveryRoutes.js';
import { ingestSummarize } from '../../src/services/worker/http/shared.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { hookCommand } from '../../src/cli/hook-command.js';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

describe('maintained runtime integration', () => {
  it('does not retire an exhausted batch without a successful durable callback', async () => {
    for (const callback of [undefined, async () => { throw new Error('unanchored'); }]) {
      const manager = new SessionManager({} as any);
      const buffer = manager.getMessageBuffer();
      const id = buffer.enqueue(1, { type: 'observation', tool_name: 'Read' });
      const session = { claimedMessageIds: [id] };
      spies.push(spyOn(manager, 'getSession').mockReturnValue(session as any));
      // handleMalformedOutput reads the registered session directly.
      (manager as any).sessions.set(1, session);
      const messages = (buffer as any).buffers.get(1);
      messages[0].claimed = true;
      messages[0].malformedRetryCount = 2;
      if (callback) manager.setOnMalformedOutputExhausted(callback);
      await manager.handleMalformedOutput(1, { outputClass: 'prose', preview: 'invalid', agentName: 'test' });
      expect(buffer.getPendingCount(1)).toBe(1);
      expect(messages[0].recoveryPending).toBe(false);
      expect(buffer.resetClaimed(1)).toBe(1);
    }
  });

  it('fences the actual hook entry before stdin, handler, or spool work', async () => {
    spies.push(spyOn(ReleaseWindowManager.prototype, 'tryAcquireHookLease').mockReturnValue(null));
    let output = '';
    spies.push(spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, callback?: () => void) => {
      output += String(chunk); callback?.(); return true;
    }) as any));
    expect(await hookCommand('codex', 'context', { skipExit: true })).toBe(0);
    expect(JSON.parse(output).hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: '' });
  });

  it('releases the hook lease on the early disabled-tool path', async () => {
    const release = mock(() => {});
    spies.push(spyOn(ReleaseWindowManager.prototype, 'tryAcquireHookLease').mockReturnValue(release));
    const prior = process.env.CLAUDE_MEM_DISABLE_TOOL_HOOKS;
    process.env.CLAUDE_MEM_DISABLE_TOOL_HOOKS = '1';
    try { await hookCommand('claude-code', 'observation', { skipExit: true }); }
    finally {
      if (prior === undefined) delete process.env.CLAUDE_MEM_DISABLE_TOOL_HOOKS;
      else process.env.CLAUDE_MEM_DISABLE_TOOL_HOOKS = prior;
    }
    expect(release).toHaveBeenCalled();
  });

  it('rejects stale release generations before touching the database or consumer', async () => {
    spies.push(spyOn(ReleaseWindowManager.prototype, 'current').mockReturnValue({ generation: 7, phase: 'window_closed' } as any));
    const worker = { releaseRecoveryInFlight: null };
    await expect(WorkerService.prototype.reconcileReleaseRecovery.call(worker, 6)).rejects.toThrow('matching closed generation');
    expect(worker.releaseRecoveryInFlight).toBeNull();
  });

  it('requires a generation and waits for canonical reconciliation before reporting success', async () => {
    const reconcile = mock(async () => {});
    const routes = new RecoveryRoutes({} as any, () => null, reconcile);
    let status = 200;
    let result: unknown;
    const response = { headersSent: false, status(value: number) { status = value; return this; }, json(value: unknown) { result = value; } };
    await (routes as any).reconcile({ body: { generation: '7' } }, response);
    expect(status).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();
    await (routes as any).reconcile({ body: { generation: 7 } }, response);
    expect(reconcile).toHaveBeenCalledWith(7);
    expect(result).toEqual({ generation: 7, status: 'recovery_reconciled' });
  });

  it('preserves spooled subagent transcript metadata without queuing an unanchored summary', async () => {
    const persist = mock(() => {});
    const queue = mock(() => {});
    const outcome = await ingestSummarize({ contentSessionId: 'child', platformSource: 'codex', agentId: 'agent', transcriptPath: '/canonical/child.jsonl' }, {
      dbManager: { getSessionStore: () => ({ findSessionDbIdByContentSessionId: () => 42, db: { prepare: () => ({ run: persist }) } }) },
      sessionManager: { queueSummarize: queue }, eventBroadcaster: {},
    } as any);
    expect(persist).toHaveBeenCalledWith('/canonical/child.jsonl', 42);
    expect(queue).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'skipped', reason: 'deferred_to_canonical_recovery' });
  });
});
