import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
// This suite verifies the SQL/outbox contract. It must not boot the real
// chroma-mcp subprocess: unavailable uvx can otherwise consume the production
// 30s connection timeout before the durable pending result is asserted.
let chromaAttemptCount = 0;
mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async () => {
        chromaAttemptCount += 1;
        throw new Error('isolated test Chroma unavailable');
      },
    }),
  },
}));

import { adoptDeclaredWorktrees } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { parseAdoptCommand } from '../../../src/services/worker-service.js';

let root: string | undefined;
let repo: string | undefined;

afterEach(() => {
  chromaAttemptCount = 0;
  if (repo && existsSync(repo)) {
    try { git(repo, 'worktree', 'remove', '--force', path.join(root!, 'rebase-v13.13.0')); } catch {}
    try { git(repo, 'worktree', 'remove', '--force', path.join(root!, 'rebase-v13.14.0')); } catch {}
  }
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  repo = undefined;
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function setup(): { dataDir: string; dbPath: string; sources: Array<{ project: string; branch: string }> } {
  root = mkdtempSync(path.join(tmpdir(), 'claude-mem-explicit-adoption-'));
  repo = path.join(root, 'claude-mem');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'base');
  const first = path.join(root, 'rebase-v13.13.0');
  const second = path.join(root, 'rebase-v13.14.0');
  git(repo, 'worktree', 'add', '-b', 'rebase-v13.13.0', first);
  git(repo, 'worktree', 'add', '-b', 'rebase-v13.14.0', second);
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir);
  const dbPath = path.join(dataDir, 'claude-mem.db');
  const store = new SessionStore(dbPath);
  for (const [index, project] of ['claude-mem/rebase-v13.13.0', 'claude-mem/rebase-v13.14.0'].entries()) {
    const sdk = store.createSDKSession(`content-${index}`, project, 'prompt');
    store.ensureMemorySessionIdRegistered(sdk, `memory-${index}`);
    store.importSessionSummary({
      memory_session_id: `memory-${index}`, project, request: `request-${index}`,
      investigated: null, learned: null, completed: null, next_steps: null,
      files_read: null, files_edited: null, notes: null, prompt_number: 1,
      discovery_tokens: 0, created_at: new Date(1_700_000_000_000 + index).toISOString(), created_at_epoch: 1_700_000_000_000 + index,
    });
  }
  store.close();
  return {
    dataDir, dbPath,
    sources: [
      { project: 'claude-mem/rebase-v13.13.0', branch: 'rebase-v13.13.0' },
      { project: 'claude-mem/rebase-v13.14.0', branch: 'rebase-v13.14.0' },
    ],
  };
}

describe('explicit logical-project worktree adoption', () => {
  it('rejects a broad or wrong parent before writes', async () => {
    const fixture = setup();
    await expect(adoptDeclaredWorktrees({ repoPath: repo, dataDirectory: fixture.dataDir, parentProject: 'other-project', sources: fixture.sources }))
      .rejects.toThrow('--parent-project must exactly match');
    const store = new SessionStore(fixture.dbPath);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_summaries WHERE merged_into_project IS NOT NULL').get()).toEqual({ n: 0 });
    store.close();
  });

  it('rejects an unregistered source even when its project shape is valid', async () => {
    const fixture = setup();
    await expect(adoptDeclaredWorktrees({
      repoPath: repo, dataDirectory: fixture.dataDir, parentProject: 'claude-mem',
      sources: [{ project: 'claude-mem/not-a-worktree', branch: 'not-a-worktree' }],
    })).rejects.toThrow('not a registered worktree');
  });

  it('reports exact multi-source rows on dry-run without changing SQLite', async () => {
    const fixture = setup();
    const result = await adoptDeclaredWorktrees({ repoPath: repo, dataDirectory: fixture.dataDir, parentProject: 'claude-mem', sources: fixture.sources, dryRun: true });
    expect(result.mergedBranches).toEqual(['rebase-v13.13.0', 'rebase-v13.14.0']);
    expect(result.adoptedSummaries).toBe(2);
    const store = new SessionStore(fixture.dbPath);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_summaries WHERE merged_into_project IS NOT NULL').get()).toEqual({ n: 0 });
    store.close();
  });

  it('applies idempotently, preserves provenance, and queues each source remap', async () => {
    const fixture = setup();
    const first = await adoptDeclaredWorktrees({ repoPath: repo, dataDirectory: fixture.dataDir, parentProject: 'claude-mem', sources: fixture.sources });
    expect(first.adoptedSummaries).toBe(2);
    const second = await adoptDeclaredWorktrees({ repoPath: repo, dataDirectory: fixture.dataDir, parentProject: 'claude-mem', sources: fixture.sources });
    expect(second.adoptedSummaries).toBe(0);
    const store = new SessionStore(fixture.dbPath);
    const rows = store.db.prepare('SELECT project, merged_into_project FROM session_summaries ORDER BY project').all();
    expect(rows).toEqual([
      { project: 'claude-mem/rebase-v13.13.0', merged_into_project: 'claude-mem' },
      { project: 'claude-mem/rebase-v13.14.0', merged_into_project: 'claude-mem' },
    ]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE body LIKE '%remap_project%'").get()).toEqual({ n: 2 });
    // The Chroma side is a durable reconciliation lane, not a best-effort
    // post-commit write. It retains source + parent provenance even if the
    // test's isolated Chroma endpoint is unavailable.
    expect(store.db.prepare('SELECT source_project, parent_project, doc_type, status FROM worktree_adoption_chroma_outbox ORDER BY source_project').all()).toEqual([
      { source_project: 'claude-mem/rebase-v13.13.0', parent_project: 'claude-mem', doc_type: 'session_summary', status: 'pending' },
      { source_project: 'claude-mem/rebase-v13.14.0', parent_project: 'claude-mem', doc_type: 'session_summary', status: 'pending' },
    ]);
    // The retry lane was attempted, then retained as pending after the local
    // test-double's immediate outage. No production connection timeout is
    // involved, and CLI callers can still distinguish incomplete proof.
    expect(chromaAttemptCount).toBe(2);
    expect(first.chromaPending).toBe(2);
    expect(first.chromaFailed).toBe(2);
    expect(second.chromaPending).toBe(2);
    expect(second.chromaFailed).toBe(2);
    store.close();
  });
});

describe('explicit adoption CLI parsing', () => {
  it('requires paired explicit sources and parent project', () => {
    expect(() => parseAdoptCommand(['--parent-project', 'claude-mem', '--source-project', 'claude-mem/rebase-v13.14.0']))
      .toThrow('immediately followed by --branch');
    expect(parseAdoptCommand([
      '--parent-project', 'claude-mem',
      '--source-project', 'claude-mem/rebase-v13.13.0', '--branch', 'rebase-v13.13.0',
      '--source-project', 'claude-mem/rebase-v13.14.0', '--branch', 'rebase-v13.14.0',
      '--dry-run',
    ])).toEqual({
      mode: 'explicit', dryRun: true, parentProject: 'claude-mem', repoPath: undefined,
      sources: [
        { project: 'claude-mem/rebase-v13.13.0', branch: 'rebase-v13.13.0' },
        { project: 'claude-mem/rebase-v13.14.0', branch: 'rebase-v13.14.0' },
      ],
    });
  });

  it('fails closed on positional tokens and duplicate --dry-run', () => {
    const pair = [
      '--parent-project', 'claude-mem',
      '--source-project', 'claude-mem/rebase-v13.14.0', '--branch', 'rebase-v13.14.0',
    ];

    expect(() => parseAdoptCommand(['stray', ...pair]))
      .toThrow('Unexpected argument: stray');
    expect(() => parseAdoptCommand([...pair, 'stray']))
      .toThrow('Unexpected argument: stray');
    expect(() => parseAdoptCommand([
      '--parent-project', 'claude-mem',
      '--source-project', 'claude-mem/rebase-v13.14.0', 'stray', '--branch', 'rebase-v13.14.0',
    ])).toThrow('immediately followed by --branch');
    expect(() => parseAdoptCommand([...pair, '--dry-run', '--dry-run']))
      .toThrow('Duplicate option: --dry-run');
  });
});
