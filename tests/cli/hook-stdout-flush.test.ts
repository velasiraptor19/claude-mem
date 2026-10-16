import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const HOOK_IO_PATH = join(import.meta.dir, '..', '..', 'src', 'shared', 'hook-io.ts');
const CONTEXT = 'x'.repeat(1024 * 1024) + '\nSynthetic context: \u03bb \ud83d\ude80';
const nodePath = Bun.which('node');
const runtimes = [
  { name: 'Bun', executable: process.execPath },
  ...(nodePath ? [{ name: 'Node', executable: nodePath }] : []),
];
let fixtureDir: string;
let fixturePath: string;

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'claude-mem-hook-stdout-'));
  const entrypoint = join(fixtureDir, 'fixture.ts');
  writeFileSync(entrypoint, `
    import { writeSync } from 'node:fs';
    import { emitModelContext, exitGraceful, installHookStderrBuffer } from ${JSON.stringify(HOOK_IO_PATH)};

    const context = ${JSON.stringify(CONTEXT)};
    const adapter = {
      normalizeInput: (input) => input,
      formatOutput: () => process.argv[2] === 'raw'
        ? context
        : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } },
    };
    installHookStderrBuffer();
    process.stderr.write('buffered library noise\\n');

    // Node's old immediate exit prevents this callback from running. The parent
    // then drains on child exit, exposing bytes lost from the pending write.
    // Bun's console.log can block synchronously, so release its reader first.
    if (process.versions.bun) {
      writeSync(3, 'drain');
    } else {
      setImmediate(() => writeSync(3, 'drain'));
    }
    try {
      emitModelContext(adapter, {});
      await exitGraceful();
    } catch (error) {
      writeSync(3, 'failure:' + (error instanceof Error ? error.name : String(error)) + '\\n');
      process.exit(1);
    }
  `);
  const build = await Bun.build({ entrypoints: [entrypoint], target: 'node', format: 'esm' });
  if (!build.success) {
    throw new Error(`Failed to build hook stdout fixture: ${build.logs.join('\n')}`);
  }
  fixturePath = join(fixtureDir, 'fixture.mjs');
  writeFileSync(fixturePath, await build.outputs[0].text());
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

interface CapturedOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  marker: string;
}

// Node owns the pipes: Bun's extra-fd emulation races fast child exits and
// drains paused stdout internally, so it cannot exercise native backpressure.
function captureWithPausedReader(
  executable: string,
  kind: 'json' | 'raw',
  closeReader = false,
): Promise<CapturedOutput> {
  return new Promise((resolve, reject) => {
    execFile(nodePath ?? 'node', [
      join(import.meta.dir, '../fixtures/hook-stdout-reader.mjs'),
      fixturePath, executable, kind, String(closeReader),
    ], { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      if (stderr) { reject(new Error(stderr)); return; }
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
}

describe('hook stdout completes before graceful exit', () => {
  for (const runtime of runtimes) {
    it(`${runtime.name} preserves the entire large JSON envelope through a paused pipe`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'json');
      const expected = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT },
      }) + '\n';

      expect(output.code).toBe(0);
      expect(output.signal).toBeNull();
      expect(output.stderr).toBe('');
      expect(output.stdout.length).toBe(expected.length);
      expect(output.stdout === expected).toBe(true);
      expect(output.stdout.endsWith('\n')).toBe(true);
      expect(JSON.parse(output.stdout).hookSpecificOutput.additionalContext === CONTEXT).toBe(true);
    }, 10000);

    it(`${runtime.name} preserves the entire large raw adapter string and trailing newline`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'raw');
      const expected = CONTEXT + '\n';

      expect(output.code).toBe(0);
      expect(output.signal).toBeNull();
      expect(output.stderr).toBe('');
      expect(output.stdout.length).toBe(expected.length);
      expect(output.stdout === expected).toBe(true);
      expect(output.stdout.endsWith('\n')).toBe(true);
    }, 10000);

    it(`${runtime.name} rejects a closed stdout pipe with a handled delivery error`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'json', true);

      expect(output.code).toBe(1);
      expect(output.signal).toBeNull();
      expect(output.stdout).toBe('');
      expect(output.stderr).toBe('');
      expect(output.marker).toContain('failure:HookStdoutError\n');
    }, 10000);
  }
});
