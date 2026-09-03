import { afterEach, describe, expect, it } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { compactNvidiaHistory, classifyNvidiaError, NvidiaProvider, validateNvidiaSettings, type NvidiaConfig } from '../../src/services/worker/NvidiaProvider.js';
import { selectAvailableProvider } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { providerAuthMethodDescription } from '../../src/services/worker-service.js';

class TestNvidiaProvider extends NvidiaProvider {
  runQuery(history: Array<{ role: 'user' | 'assistant'; content: string }>, config: NvidiaConfig) {
    return this.query(history, config);
  }
  recovery(input: { userMessage: string; finalAssistantMessage: string | null; toolEvidence: []; completionState?: 'completed' | 'aborted' | 'incomplete'; corruptionLines?: number[] }) {
    return this.generateRecoverySummary(input);
  }
}

const config: NvidiaConfig = {
  apiKey: 'test-key', model: 'nvidia/test-model', apiUrl: 'https://example.test/v1/chat/completions',
  maxInputTokens: 1000, maxOutputTokens: 321, temperature: 0.1, topP: 0.8, rpmLimit: 40,
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('NvidiaProvider', () => {
  it('sends only documented NIM chat-completion fields and headers', async () => {
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ model: 'nvidia/served', choices: [{ message: { content: '<observation />' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200 });
    }) as typeof fetch;
    const provider = new TestNvidiaProvider({} as any, {} as any);
    const result = await provider.runQuery([{ role: 'user', content: 'hello' }], config);
    const body = JSON.parse(String(request?.body));
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'temperature', 'top_p']);
    expect(body).toEqual({ model: config.model, messages: [{ role: 'user', content: 'hello' }], temperature: 0.1, top_p: 0.8, max_tokens: 321, stream: false });
    expect((request?.headers as Record<string, string>)['Accept']).toBe('application/json');
    expect((request?.headers as Record<string, string>)['HTTP-Referer']).toBeUndefined();
    expect(result).toMatchObject({ content: '<observation />', inputTokens: 10, outputTokens: 2, tokensUsed: 12, servedModel: 'nvidia/served' });
  });

  it('classifies NVIDIA status codes and Retry-After', () => {
    const cases: Array<[number, string]> = [[400, 'unrecoverable'], [401, 'auth_invalid'], [403, 'auth_invalid'], [404, 'unrecoverable'], [429, 'rate_limit'], [500, 'transient']];
    for (const [status, kind] of cases) {
      const error = classifyNvidiaError({ status, cause: new Error('x'), headers: new Headers({ 'Retry-After': '2' }) });
      expect(error).toBeInstanceOf(ClassifiedProviderError);
      expect(error.kind).toBe(kind);
      if (status === 429) expect(error.retryAfterMs).toBe(2000);
    }
  });

  it('preserves init, latest assistant, and pending prompt while compacting', () => {
    const history = [
      { role: 'user' as const, content: 'INIT' },
      { role: 'assistant' as const, content: 'old assistant'.repeat(20) },
      { role: 'user' as const, content: 'old tool'.repeat(20) },
      { role: 'assistant' as const, content: 'LATEST_ASSISTANT' },
      { role: 'user' as const, content: 'SUMMARY_PROMPT' },
    ];
    const compacted = compactNvidiaHistory(history, 12);
    expect(compacted.map(m => m.content)).toContain('INIT');
    expect(compacted.map(m => m.content)).toContain('LATEST_ASSISTANT');
    expect(compacted.map(m => m.content)).toContain('SUMMARY_PROMPT');
    for (const limit of [1, 2, 3, 4, 8]) {
      const tiny = compactNvidiaHistory(history, limit);
      expect(tiny.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(limit * 4);
    }
  });

  it('rejects recovery claims without known deterministic evidence references', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: '<summary><request>[U1] fix</request><investigated>invented claim</investigated><learned>[E9] unknown</learned><completed></completed><next_steps>[U1] retry</next_steps><notes></notes></summary>' } }] }), { status: 200 });
    }) as typeof fetch;
    const provider = new TestNvidiaProvider({} as any, {} as any);
    await expect(provider.recovery({ userMessage: 'fix', finalAssistantMessage: 'verified result', toolEvidence: [] })).rejects.toBeInstanceOf(ClassifiedProviderError);
    expect(calls).toBe(3);
  });

  it('tells recovery summaries about transcript gaps and includes final plus tool evidence', async () => {
    let body: any;
    globalThis.fetch = (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '<summary><request>[U1] repair</request><investigated>[E2] inspected</investigated><learned>[E1] transcript gap</learned><completed></completed><next_steps>[U1] verify</next_steps><notes>[E1] incomplete evidence</notes></summary>' } }] }), { status: 200 });
    }) as typeof fetch;
    const provider = new TestNvidiaProvider({} as any, {} as any);
    await provider.recovery({ userMessage: 'repair', finalAssistantMessage: 'partial result', toolEvidence: [], completionState: 'incomplete', corruptionLines: [4] });
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain('"completion_state":"incomplete"');
    expect(prompt).toContain('"corrupt_transcript_lines":[4]');
    expect(prompt).toContain('[E2] partial result');
  });

  it('validates NVIDIA settings and selects the native provider', () => {
    expect(validateNvidiaSettings({ CLAUDE_MEM_NVIDIA_BASE_URL: 'https://integrate.api.nvidia.com/v1/chat/completions', CLAUDE_MEM_NVIDIA_MAX_INPUT_TOKENS: '30000', CLAUDE_MEM_NVIDIA_TEMPERATURE: '0.1' })).toBeNull();
    expect(validateNvidiaSettings({ CLAUDE_MEM_NVIDIA_RPM_LIMIT: '0' })).toContain('positive integer');
    expect(validateNvidiaSettings({ CLAUDE_MEM_NVIDIA_TOP_P: '2' })).toContain('between 0 and 1');
    expect(selectAvailableProvider({ nvidia: true, openrouter: true, gemini: true })).toBe('nvidia');
    expect(selectAvailableProvider({ nvidia: false, openrouter: false, gemini: false })).toBe('claude');
  });

  it('does not report Claude OAuth for API-key providers', () => {
    expect(providerAuthMethodDescription('nvidia')).toBe('NVIDIA API key');
    expect(providerAuthMethodDescription('openrouter')).toBe('OpenRouter API key');
    expect(providerAuthMethodDescription('gemini')).toBe('Gemini API key');
  });
});
