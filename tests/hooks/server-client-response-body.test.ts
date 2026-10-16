import { createServer } from 'node:net';
import { expect, it } from 'bun:test';
import { ServerClient, ServerClientError } from '../../src/services/hooks/server-client.js';

it('keeps a success-body timeout eligible for hook fallback', async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"session":'));
        timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('{}}')); controller.close(); }, 1000);
      }, cancel() { if (timer) clearTimeout(timer); },
    }), { headers: { 'content-type': 'application/json' } });
  } });
  try {
    const client = new ServerClient({ serverBaseUrl: server.url.toString(), apiKey: 'fixture', timeoutMs: 100 });
    let error: unknown;
    try { await client.startSession({ projectId: 'fixture' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ServerClientError);
    expect((error as ServerClientError).kind).toBe('timeout');
    expect((error as ServerClientError).isFallbackEligible()).toBe(true);
  } finally { if (timer) clearTimeout(timer); server.stop(true); }
});

it('keeps a disconnected success body eligible for hook fallback', async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raw TCP framing avoids Bun.serve converting a stream failure into a clean partial JSON response.
  const server = createServer(socket => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{"session":');
      timer = setTimeout(() => socket.destroy(), 50);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const client = new ServerClient({ serverBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', timeoutMs: 1000 });
    let error: unknown;
    try { await client.startSession({ projectId: 'fixture' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ServerClientError);
    expect((error as ServerClientError).kind).toBe('transport');
    expect((error as ServerClientError).isFallbackEligible()).toBe(true);
  } finally {
    if (timer) clearTimeout(timer);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
