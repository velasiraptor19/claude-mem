import { join, dirname, basename, resolve, sep } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { readJsonFileWithBom } from './atomic-json.js';
import { settingsTarget } from './settings-document.js';
import { expandHome } from './expand-home.js';

export { expandHome } from './expand-home.js';

function getDirname(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

const _dirname = getDirname();

export function resolveDataDir(): string {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  }

  const defaultDataDir = join(homedir(), '.claude-mem');
  const settingsPath = join(defaultDataDir, 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const raw = readJsonFileWithBom<unknown>(settingsPath);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaultDataDir;
      const settings = settingsTarget(raw as Record<string, unknown>);
      if (typeof settings.CLAUDE_MEM_DATA_DIR === 'string' && settings.CLAUDE_MEM_DATA_DIR) {
        return expandHome(settings.CLAUDE_MEM_DATA_DIR);
      }
    }
  } catch {
    // settings file missing or corrupt — fall through to default
  }

  return defaultDataDir;
}

export const DATA_DIR = resolveDataDir();
// #2753 — the literal default config dir, independent of process.env state.
// Lets callers (oauth-token.ts) compare an *effective* config dir against the
// TRUE default rather than against CLAUDE_CONFIG_DIR (which already folds in
// process.env). Purely additive: does not change CLAUDE_CONFIG_DIR's own
// derivation or MARKETPLACE_ROOT below.
export const DEFAULT_CLAUDE_CONFIG_DIR = join(homedir(), '.claude');
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR;

export const MARKETPLACE_ROOT = join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack');

export const LOGS_DIR = join(DATA_DIR, 'logs');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const DB_FILENAME = 'claude-mem.db';

/**
 * Database path resolved at CALL time. `DB_PATH` freezes `DATA_DIR` at import,
 * which is right for long-lived processes but wrong for anything that must
 * honor a `CLAUDE_MEM_DATA_DIR` set after this module was loaded.
 */
export function resolveDbPath(): string {
  return join(resolveDataDir(), DB_FILENAME);
}

export const DB_PATH = join(DATA_DIR, DB_FILENAME);

export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

export const OBSERVER_SESSIONS_PROJECT = basename(OBSERVER_SESSIONS_DIR);

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/** mkdir failures that retrying can never fix: the data dir is a file, sits under one, or is not writable. */
const PERMANENT_DIRECTORY_ERROR_CODES = new Set(['ENOTDIR', 'EEXIST', 'EACCES', 'EPERM', 'EROFS']);

export const OBSERVER_WORKING_DIRECTORY_ERROR_PREFIX = 'Observer working directory could not be prepared';

/**
 * Create the Observer/KnowledgeAgent working directory before an SDK spawn.
 *
 * A permanent mkdir failure is rethrown as a message that classifyClaudeError
 * maps to `setup_required`, so it is recorded once instead of retried on every
 * ingest. Anything else (EMFILE, ENFILE, EIO, ENOSPC …) is rethrown unchanged:
 * a passing file-system hiccup must not park Claude starts behind the setup
 * cooldown. `makeDirectory` is a test seam; production callers omit it.
 */
export function ensureObserverSessionsDir(
  dir: string = OBSERVER_SESSIONS_DIR,
  makeDirectory: (dirPath: string) => void = ensureDir,
): string {
  try {
    makeDirectory(dir);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !PERMANENT_DIRECTORY_ERROR_CODES.has(code)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${OBSERVER_WORKING_DIRECTORY_ERROR_PREFIX}: ${dir} (${code}): ${detail}`);
  }
  return dir;
}

export interface PackageRootResolutionOptions {
  entryScript?: string;
  moduleDir?: string;
  cwd?: string;
}

function isRuntimePackageRoot(candidate: string): boolean {
  const scriptsDir = join(candidate, 'scripts');
  const hasRuntimeEntry = existsSync(join(scriptsDir, 'worker-service.cjs'))
    || existsSync(join(scriptsDir, 'server-service.cjs'));
  const hasRuntimeAssets = existsSync(join(candidate, 'ui'))
    || existsSync(join(candidate, 'skills'));

  // Marketplace plugin payloads are executable distributions but are not
  // guaranteed to carry package.json. Requiring npm metadata made a worker
  // launched from <marketplace>/plugin/scripts fall through to the bundled
  // source-tree __dirname, breaking GUI assets and lazy worker startup.
  // Concrete runtime entries plus packaged assets are stricter and work for
  // Claude/Codex caches, marketplace payloads, npm, and source installs.
  return existsSync(scriptsDir) && hasRuntimeEntry && hasRuntimeAssets;
}

function findRuntimePackageRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (isRuntimePackageRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the runtime package root from the script that Node/Bun actually
 * launched. Bundlers may bake the source-tree `__dirname` into a generated
 * worker, so moduleDir is only a fallback. Structural markers make this work
 * for Claude and Codex caches as well as npm and source-tree installations
 * without encoding any host-specific cache path.
 */
export function getPackageRoot(options: PackageRootResolutionOptions = {}): string {
  const entryScript = options.entryScript ?? process.argv[1];
  const starts = [
    entryScript ? dirname(resolve(entryScript)) : null,
    options.moduleDir ?? _dirname,
    options.cwd ?? process.cwd(),
  ];
  for (const start of starts) {
    if (!start) continue;
    const root = findRuntimePackageRoot(start);
    if (root) return root;
  }

  return join(options.moduleDir ?? _dirname, '..');
}

/**
 * Expand a leading `~` / `~/` (or `~\` on Windows) to the user's home dir.
 *
 * User-typed config paths like `~/.local/bin/claude` are never expanded by the
 * shell when passed programmatically to existsSync/posix_spawn, so a literal
 * `~` reaches the syscall and fails with ENOENT. Every other home-relative path
 * in the codebase is built with join(homedir(), ...); this brings user-supplied
 * ones onto the same footing. Non-tilde paths are returned unchanged.
 *
 * `home` is injectable so callers behind a homedir() test seam stay testable.
 */
export function expandTilde(
  filePath: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return expandHome(filePath, platform, home);
}

export const paths = {
  dataDir: () => DATA_DIR,
  workerPid: () => join(DATA_DIR, 'worker.pid'),
  workerHeartbeat: () => join(DATA_DIR, 'worker-heartbeat.json'),
  // Phase 1b: identifier renamed to `server*`; the on-disk file basenames
  // remain `.server-beta.*` so existing installations keep finding their
  // pid/port/runtime state. Plan §1d will migrate the basenames.
  serverPid: () => join(DATA_DIR, '.server-beta.pid'),
  serverPort: () => join(DATA_DIR, '.server-beta.port'),
  serverRuntime: () => join(DATA_DIR, '.server-beta.runtime.json'),
  settings: () => join(DATA_DIR, 'settings.json'),
  database: () => join(DATA_DIR, DB_FILENAME),
  chroma: () => join(DATA_DIR, 'chroma'),
  combinedCerts: () => join(DATA_DIR, 'combined_certs.pem'),
  transcriptsConfig: () => join(DATA_DIR, 'transcript-watch.json'),
  transcriptsState: () => join(DATA_DIR, 'transcript-watch-state.json'),
  corpora: () => join(DATA_DIR, 'corpora'),
  supervisorRegistry: () => join(DATA_DIR, 'supervisor.json'),
  envFile: () => join(DATA_DIR, '.env'),
  logsDir: () => LOGS_DIR,
} as const;
