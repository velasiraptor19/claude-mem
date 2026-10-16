import { spawn } from 'node:child_process';

const [fixturePath, executable, kind, closed] = process.argv.slice(2);

function captureWithPausedReader(
  executable,
  kind,
  closeReader = false,
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [fixturePath, kind], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const marker = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stdout.pause();
    if (closeReader) child.stdout.destroy();
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    const drainMarker = child.stdio[3];
    drainMarker.on('data', chunk => {
      marker.push(Buffer.from(chunk));
      child.stdout.resume();
    });
    child.once('exit', () => child.stdout.resume());

    // A deadline prevents a broken flush implementation from leaking a child.
    // Reader release itself uses the fixture's marker or exit, never a sleep.
    const deadline = setTimeout(() => {
      child.stdout.resume();
      child.kill();
      reject(new Error('Hook stdout fixture did not finish within 5 seconds'));
    }, 5000);
    child.once('error', error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        marker: Buffer.concat(marker).toString('utf-8'),
      });
    });
  });
}

process.stdout.write(JSON.stringify(await captureWithPausedReader(executable, kind, closed === 'true')));
