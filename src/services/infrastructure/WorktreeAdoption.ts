
import path from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { ChromaSync, MergedIntoProjectTarget } from '../sync/ChromaSync.js';
import { emitRemapProject, hasSyncLane } from '../sync/remap-outbox.js';
import { paths } from '../../shared/paths.js';
import { openConfiguredSqliteDatabase } from '../sqlite/connection.js';

const DEFAULT_DATA_DIR = paths.dataDir();

export interface AdoptionResult {
  repoPath: string;
  parentProject: string;
  scannedWorktrees: number;
  mergedBranches: string[];
  adoptedObservations: number;
  adoptedSummaries: number;
  chromaUpdates: number;
  chromaFailed: number;
  dryRun: boolean;
  errors: Array<{ worktree: string; error: string }>;
  /** Durable Chroma metadata patches which have not yet been proven. */
  chromaPending?: number;
}

/**
 * Render per-branch adoption errors as a string for logger CONTEXT values —
 * the logger interpolates context values with a template literal
 * (logger.ts `${k}=${v}`), so a raw object array renders as
 * '[object Object]' (#3378).
 */
export function formatAdoptionErrors(errors: AdoptionResult['errors']): string {
  return errors.map(e => `${e.worktree}: ${e.error}`).join('; ');
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** A deliberately declared logical-project adoption source. */
export interface DeclaredWorktreeSource {
  /** Immutable provenance key currently stored on the rows. */
  project: string;
  /** Exact registered Git branch for that worktree. */
  branch: string;
}

const GIT_TIMEOUT_MS = 15000;

class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}

/**
 * Apply durable Chroma patches left by an earlier adoption attempt.  This is
 * intentionally independent of discovery: a later worker boot can have no
 * currently mergeable worktrees while SQLite still has a committed remap
 * waiting for its vector metadata proof.
 */
async function reconcilePendingChromaOutbox(
  dbPath: string,
  parentProject: string,
  result: AdoptionResult,
): Promise<void> {
  let pending: Array<{ patch_key: string; doc_type: 'observation' | 'session_summary'; sqlite_id: number }> = [];
  let reconcileDb: import('bun:sqlite').Database | null = null;
  try {
    reconcileDb = openConfiguredSqliteDatabase(dbPath);
    const outboxExists = reconcileDb.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'worktree_adoption_chroma_outbox'"
    ).get();
    if (!outboxExists) return;
    pending = reconcileDb.prepare(`SELECT patch_key, doc_type, sqlite_id
      FROM worktree_adoption_chroma_outbox WHERE status = 'pending' AND parent_project = ?
      ORDER BY sqlite_id LIMIT 1000`).all(parentProject) as typeof pending;
  } finally { reconcileDb?.close(); }

  if (pending.length > 0) try {
    const chromaSync = new ChromaSync('claude-mem');
    const patched = await chromaSync.updateMergedIntoProject(pending.map(row => ({ docType: row.doc_type, sqliteId: row.sqlite_id })), parentProject);
    if (patched !== pending.length) throw new Error(`Chroma proof incomplete: patched ${patched}/${pending.length} documents`);
    const ackDb = openConfiguredSqliteDatabase(dbPath);
    try {
      const acknowledge = ackDb.prepare("UPDATE worktree_adoption_chroma_outbox SET status = 'applied', attempts = attempts + 1, last_error = NULL, updated_at_epoch = ? WHERE patch_key = ?");
      ackDb.transaction(() => { for (const row of pending) acknowledge.run(Date.now(), row.patch_key); })();
    } finally { ackDb.close(); }
    result.chromaUpdates = patched;
  } catch (err) {
    logger.error(
      'SYSTEM',
      'Worktree adoption Chroma patch failed (SQL already committed)',
      { parentProject, sqliteIdCount: pending.length },
      err instanceof Error ? err : new Error(String(err))
    );
    result.chromaFailed = pending.length;
    const failedDb = openConfiguredSqliteDatabase(dbPath);
    try {
      const fail = failedDb.prepare("UPDATE worktree_adoption_chroma_outbox SET attempts = attempts + 1, last_error = ?, updated_at_epoch = ? WHERE patch_key = ?");
      failedDb.transaction(() => { for (const row of pending) fail.run(err instanceof Error ? err.message : String(err), Date.now(), row.patch_key); })();
    } finally { failedDb.close(); }
  }

  const countDb = openConfiguredSqliteDatabase(dbPath);
  try { result.chromaPending = (countDb.prepare("SELECT COUNT(*) AS n FROM worktree_adoption_chroma_outbox WHERE status = 'pending' AND parent_project = ?").get(parentProject) as { n: number }).n; }
  finally { countDb.close(); }
}

function gitCapture(cwd: string, args: string[]): string | null {
  const startTime = Date.now();
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true
  });
  const duration = Date.now() - startTime;
  
  if (duration > 1000) {
    logger.debug('GIT', `Slow git operation: git -C ${cwd} ${args.join(' ')} took ${duration}ms`);
  }

  if (r.error) {
    logger.warn('GIT', `Git operation failed: git -C ${cwd} ${args.join(' ')}`, {
      error: r.error.message,
      timedOut: r.error.name === 'ETIMEDOUT' || (r.status === null && r.signal === 'SIGTERM')
    });
    return null;
  }

  if (r.status !== 0) {
    logger.debug('GIT', `Git returned non-zero exit code ${r.status}: git -C ${cwd} ${args.join(' ')}`, {
      stderr: r.stderr?.toString().trim()
    });
    return null;
  }
  return (r.stdout ?? '').trim();
}

function resolveMainRepoPath(cwd: string): string | null {
  const commonDir = gitCapture(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir'
  ]);
  if (!commonDir) return null;

  const mainRoot = commonDir.endsWith('/.git')
    ? path.dirname(commonDir)
    : commonDir.replace(/\.git$/, '');
  return existsSync(mainRoot) ? mainRoot : null;
}

function listWorktrees(mainRepo: string): WorktreeEntry[] {
  const raw = gitCapture(mainRepo, ['worktree', 'list', '--porcelain']);
  if (!raw) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice('worktree '.length).trim(), branch: null };
    } else if (line.startsWith('branch ')) {
      const refName = line.slice('branch '.length).trim();
      current.branch = refName.startsWith('refs/heads/')
        ? refName.slice('refs/heads/'.length)
        : refName;
    } else if (line === '' && current.path) {
      entries.push({ path: current.path, branch: current.branch ?? null });
      current = {};
    }
  }
  if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}

function listMergedBranches(mainRepo: string): Set<string> {
  const raw = gitCapture(mainRepo, [
    'branch',
    '--merged',
    'HEAD',
    '--format=%(refname:short)'
  ]);
  if (!raw) return new Set();
  return new Set(
    raw.split('\n').map(b => b.trim()).filter(b => b.length > 0)
  );
}

export async function adoptMergedWorktrees(opts: {
  repoPath?: string;
  dataDirectory?: string;
  dryRun?: boolean;
  onlyBranch?: string;
  // Internal escape hatch used only after adoptDeclaredWorktrees validates
  // every pair against `git worktree list`. It deliberately cannot supply a
  // parent target: the target always derives from the main repository.
  declaredSources?: DeclaredWorktreeSource[];
} = {}): Promise<AdoptionResult> {
  const dataDirectory = opts.dataDirectory ?? DEFAULT_DATA_DIR;
  const dryRun = opts.dryRun ?? false;
  const startCwd = opts.repoPath ?? process.cwd();

  const mainRepo = resolveMainRepoPath(startCwd);
  const parentProject = mainRepo ? getProjectContext(mainRepo).primary : '';

  const result: AdoptionResult = {
    repoPath: mainRepo ?? startCwd,
    parentProject,
    scannedWorktrees: 0,
    mergedBranches: [],
    adoptedObservations: 0,
    adoptedSummaries: 0,
    chromaUpdates: 0,
    chromaFailed: 0,
    dryRun,
    errors: []
  };

  if (!mainRepo) {
    logger.debug('SYSTEM', 'Worktree adoption skipped (not a git repo)', { startCwd });
    return result;
  }

  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  if (!existsSync(dbPath)) {
    logger.debug('SYSTEM', 'Worktree adoption skipped (no DB yet)', { dbPath });
    return result;
  }

  const allWorktrees = listWorktrees(mainRepo);
  const childWorktrees = allWorktrees.filter(w => w.path !== mainRepo);
  result.scannedWorktrees = childWorktrees.length;

  if (childWorktrees.length === 0) {
    if (!dryRun) await reconcilePendingChromaOutbox(dbPath, parentProject, result);
    return result;
  }

  let targets: WorktreeEntry[];
  if (opts.declaredSources) {
    targets = opts.declaredSources.map(source => {
      const worktree = childWorktrees.find(candidate =>
        candidate.branch === source.branch &&
        getProjectContext(candidate.path).primary === source.project
      );
      if (!worktree) {
        // This is defense in depth. The public explicit entrypoint performs
        // this check before opening SQLite, and no caller can nominate a
        // target parent through this internal option.
        throw new Error(`Declared source is not a registered worktree: ${source.project} (${source.branch})`);
      }
      return worktree;
    });
  } else if (opts.onlyBranch) {
    targets = childWorktrees.filter(w => w.branch === opts.onlyBranch);
  } else {
    const merged = listMergedBranches(mainRepo);
    targets = childWorktrees.filter(w => w.branch !== null && merged.has(w.branch));
  }

  result.mergedBranches = targets
    .map(t => t.branch)
    .filter((b): b is string => b !== null);

  if (targets.length === 0) {
    if (!dryRun) await reconcilePendingChromaOutbox(dbPath, parentProject, result);
    return result;
  }

  const adoptedChromaTargets: MergedIntoProjectTarget[] = [];

  let db: import('bun:sqlite').Database | null = null;
  try {
    db = openConfiguredSqliteDatabase(dbPath);

    interface ColumnInfo { name: string }
    const obsColumns = db
      .prepare('PRAGMA table_info(observations)')
      .all() as ColumnInfo[];
    const sumColumns = db
      .prepare('PRAGMA table_info(session_summaries)')
      .all() as ColumnInfo[];
    const obsHasColumn = obsColumns.some(c => c.name === 'merged_into_project');
    const sumHasColumn = sumColumns.some(c => c.name === 'merged_into_project');
    if (!obsHasColumn || !sumHasColumn) {
      logger.debug(
        'SYSTEM',
        'Worktree adoption skipped (merged_into_project column missing; will run after migration)',
        { obsHasColumn, sumHasColumn }
      );
      return result;
    }

    // SQLite is canonical.  The Chroma mutation is deliberately represented
    // here, in the same transaction as the logical-project remap, so a crash
    // can never leave an adopted row without a deterministic retry record.
    if (!dryRun) db.run(`CREATE TABLE IF NOT EXISTS worktree_adoption_chroma_outbox (
      patch_key TEXT PRIMARY KEY,
      source_project TEXT NOT NULL,
      parent_project TEXT NOT NULL,
      doc_type TEXT NOT NULL CHECK(doc_type IN ('observation','session_summary')),
      sqlite_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at_epoch INTEGER NOT NULL
    )`);
    if (!dryRun) db.run('CREATE INDEX IF NOT EXISTS idx_worktree_adoption_chroma_pending ON worktree_adoption_chroma_outbox(status, parent_project)');

    const selectObsForPatch = db.prepare(
      `SELECT id FROM observations
       WHERE project = ?
         AND (merged_into_project IS NULL OR merged_into_project = ?)`
    );
    const selectSumForPatch = db.prepare(
      `SELECT id FROM session_summaries
       WHERE project = ?
         AND (merged_into_project IS NULL OR merged_into_project = ?)`
    );
    const updateObs = db.prepare(
      'UPDATE observations SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
    );
    const updateSum = db.prepare(
      'UPDATE session_summaries SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
    );

    // Two-lane sync (plan Phase 3 task 2): this function runs on its OWN DB
    // connection, so the remap must be pure SQL — emitRemapProject bumps
    // sync_rev to R = 1+MAX per the SyncApply contract, re-nulls synced_at
    // on native rows, and queues the remap_project mutation op in the same
    // transaction. Pre-migration DBs (no sync lane yet) take the legacy
    // plain-UPDATE path.
    const syncLane = hasSyncLane(db);

    const adoptWorktreeInTransaction = (wt: WorktreeEntry) => {
      const worktreeProject = getProjectContext(wt.path).primary;
      const rows = selectObsForPatch.all(
        worktreeProject,
        parentProject
      ) as Array<{ id: number }>;
      const summaryRows = selectSumForPatch.all(
        worktreeProject,
        parentProject
      ) as Array<{ id: number }>;

      let obsChanges: number;
      let sumChanges: number;
      if (syncLane) {
        const remap = emitRemapProject(
          db!,
          { project: worktreeProject, merged_into_project_is_null: true },
          { merged_into_project: parentProject }
        );
        obsChanges = remap.observations;
        sumChanges = remap.summaries;
      } else {
        obsChanges = updateObs.run(parentProject, worktreeProject).changes;
        sumChanges = updateSum.run(parentProject, worktreeProject).changes;
      }
      for (const r of rows) {
        adoptedChromaTargets.push({ docType: 'observation', sqliteId: r.id });
        if (!dryRun) db!.prepare(`INSERT OR IGNORE INTO worktree_adoption_chroma_outbox
          (patch_key, source_project, parent_project, doc_type, sqlite_id, updated_at_epoch)
          VALUES (?, ?, ?, 'observation', ?, ?)`).run(
          `observation:${worktreeProject}:${parentProject}:${r.id}`, worktreeProject, parentProject, r.id, Date.now());
      }
      for (const r of summaryRows) {
        adoptedChromaTargets.push({ docType: 'session_summary', sqliteId: r.id });
        if (!dryRun) db!.prepare(`INSERT OR IGNORE INTO worktree_adoption_chroma_outbox
          (patch_key, source_project, parent_project, doc_type, sqlite_id, updated_at_epoch)
          VALUES (?, ?, ?, 'session_summary', ?, ?)`).run(
          `session_summary:${worktreeProject}:${parentProject}:${r.id}`, worktreeProject, parentProject, r.id, Date.now());
      }
      result.adoptedObservations += obsChanges;
      result.adoptedSummaries += sumChanges;
    };

    const tx = db.transaction(() => {
      for (const wt of targets) {
        // A declared logical adoption is an operator-specified unit: every
        // declared source must remap, or none of its SQL changes may commit.
        // Automatic discovery retains its historical best-effort behavior.
        if (opts.declaredSources) {
          adoptWorktreeInTransaction(wt);
          continue;
        }
        try {
          adoptWorktreeInTransaction(wt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('SYSTEM', 'Worktree adoption skipped branch', {
            worktree: wt.path,
            branch: wt.branch,
            error: message
          });
          result.errors.push({ worktree: wt.path, error: message });
        }
      }
      if (dryRun) {
        throw new DryRunRollback();
      }
    });

    try {
      tx();
    } catch (err) {
      if (err instanceof DryRunRollback) {
        // Rolled back as intended for dry-run — counts are still useful.
      } else if (err instanceof Error) {
        logger.error('SYSTEM', 'Worktree adoption transaction failed', {}, err);
        throw err;
      } else {
        logger.error('SYSTEM', 'Worktree adoption transaction failed with non-Error', { error: String(err) });
        throw err;
      }
    }
  } finally {
    db?.close();
  }

  if (!dryRun) await reconcilePendingChromaOutbox(dbPath, parentProject, result);

  if (
    result.adoptedObservations > 0 ||
    result.adoptedSummaries > 0 ||
    result.chromaUpdates > 0 ||
    result.errors.length > 0
  ) {
    logger.info('SYSTEM', 'Worktree adoption applied', {
      parentProject,
      dryRun,
      scannedWorktrees: result.scannedWorktrees,
      mergedBranches: result.mergedBranches,
      adoptedObservations: result.adoptedObservations,
      adoptedSummaries: result.adoptedSummaries,
      chromaUpdates: result.chromaUpdates,
      chromaFailed: result.chromaFailed,
      errors: result.errors.length
    });
  }

  return result;
}

/**
 * Adopt explicitly declared worktree projects without consulting Git's
 * merged-branch graph. This is intentionally narrow: the destination must be
 * the exact project name derived from the main repository and every source
 * must match one registered worktree path AND branch. Row provenance
 * (`project`) remains immutable; only `merged_into_project` is remapped.
 */
export async function adoptDeclaredWorktrees(opts: {
  repoPath?: string;
  dataDirectory?: string;
  dryRun?: boolean;
  parentProject: string;
  sources: DeclaredWorktreeSource[];
}): Promise<AdoptionResult> {
  const startCwd = opts.repoPath ?? process.cwd();
  const mainRepo = resolveMainRepoPath(startCwd);
  if (!mainRepo) {
    throw new Error(`Explicit worktree adoption requires a registered Git repository: ${startCwd}`);
  }

  const derivedParent = getProjectContext(mainRepo).primary;
  if (!isExactProjectName(opts.parentProject) || opts.parentProject.includes('/') || opts.parentProject !== derivedParent) {
    throw new Error(`--parent-project must exactly match this repository's parent project: ${derivedParent}`);
  }
  if (!Array.isArray(opts.sources) || opts.sources.length === 0) {
    throw new Error('Explicit worktree adoption requires at least one --source-project/--branch pair');
  }

  const registered = listWorktrees(mainRepo).filter(worktree => worktree.path !== mainRepo);
  const seen = new Set<string>();
  for (const source of opts.sources) {
    if (!isExactProjectName(source.project) || !isExactBranchName(source.branch)) {
      throw new Error('Declared source project and branch must be non-blank exact values');
    }
    if (!source.project.startsWith(`${derivedParent}/`)) {
      throw new Error(`Declared source project is not a child of ${derivedParent}: ${source.project}`);
    }
    const key = `${source.project}\u0000${source.branch}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate declared source: ${source.project} (${source.branch})`);
    }
    seen.add(key);
    const match = registered.find(worktree =>
      worktree.branch === source.branch &&
      getProjectContext(worktree.path).primary === source.project
    );
    if (!match) {
      throw new Error(`Declared source is not a registered worktree: ${source.project} (${source.branch})`);
    }
  }

  return adoptMergedWorktrees({
    repoPath: mainRepo,
    dataDirectory: opts.dataDirectory,
    dryRun: opts.dryRun,
    declaredSources: opts.sources,
  });
}

function isExactProjectName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\u0000-\u001f]/.test(value);
}

function isExactBranchName(value: unknown): value is string {
  return isExactProjectName(value) && !value.startsWith('-');
}

export async function adoptMergedWorktreesForAllKnownRepos(opts: {
  dataDirectory?: string;
  dryRun?: boolean;
} = {}): Promise<AdoptionResult[]> {
  const dataDirectory = opts.dataDirectory ?? DEFAULT_DATA_DIR;
  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  const results: AdoptionResult[] = [];

  if (!existsSync(dbPath)) {
    logger.debug('SYSTEM', 'Worktree adoption skipped (no DB yet)', { dbPath });
    return results;
  }

  const uniqueParents = new Set<string>();
  let db: import('bun:sqlite').Database | null = null;
  try {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    db = new Database(dbPath, { readonly: true });

    const hasPending = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
    ).get() as { name: string } | undefined;
    if (!hasPending) {
      logger.debug('SYSTEM', 'Worktree adoption skipped (pending_messages table missing)');
      return results;
    }

    const cwdRows = db.prepare(`
      SELECT cwd FROM pending_messages
      WHERE cwd IS NOT NULL AND cwd != ''
      GROUP BY cwd
    `).all() as Array<{ cwd: string }>;

    for (const { cwd } of cwdRows) {
      const mainRepo = resolveMainRepoPath(cwd);
      if (mainRepo) uniqueParents.add(mainRepo);
    }
  } finally {
    db?.close();
  }

  if (uniqueParents.size === 0) {
    logger.debug('SYSTEM', 'Worktree adoption found no known parent repos');
    return results;
  }

  for (const repoPath of uniqueParents) {
    try {
      const result = await adoptMergedWorktrees({
        repoPath,
        dataDirectory,
        dryRun: opts.dryRun
      });
      results.push(result);
    } catch (err) {
      logger.warn(
        'SYSTEM',
        'Worktree adoption failed for parent repo (continuing)',
        { repoPath, error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  return results;
}
