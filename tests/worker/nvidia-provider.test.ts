import { afterEach, describe, expect, it } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { compactNvidiaHistory, estimateNvidiaHistoryInputCeiling, classifyNvidiaError, DEFAULT_NVIDIA_MODEL, MIN_NVIDIA_MAX_INPUT_TOKENS, NvidiaProvider, validateNvidiaSettings, type NvidiaConfig } from '../../src/services/worker/NvidiaProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { selectAvailableProvider } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { providerAuthMethodDescription } from '../../src/services/worker-service.js';

class TestNvidiaProvider extends NvidiaProvider {
  runQuery(history: Array<{ role: 'user' | 'assistant'; content: string }>, config: NvidiaConfig) {
    return this.query(history, config);
  }
  recovery(input: { userMessage: string; finalAssistantMessage: string | null; toolEvidence: Array<{ kind: 'function_call_output'; callId: string; source: string; content: string }>; completionState?: 'completed' | 'aborted' | 'incomplete'; corruptionLines?: number[] }) {
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
    expect(Object.keys(body).sort()).toEqual(['chat_template_kwargs', 'max_tokens', 'messages', 'model', 'stream', 'temperature', 'top_p']);
    expect(body).toEqual({ model: config.model, messages: [{ role: 'user', content: 'hello' }], temperature: 0.1, top_p: 0.8, max_tokens: 321, stream: false, chat_template_kwargs: { enable_thinking: false } });
    expect((request?.headers as Record<string, string>)['Accept']).toBe('application/json');
    expect((request?.headers as Record<string, string>)['HTTP-Referer']).toBeUndefined();
    expect(result).toMatchObject({ content: '<observation />', inputTokens: 10, outputTokens: 2, tokensUsed: 12, servedModel: 'nvidia/served' });
  });

  it('redacts credentials, private fields, and email before NVIDIA sends even when storage redaction is off', async () => {
    let body = '';
    globalThis.fetch = (async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '<skip_summary />' } }] }), { status: 200 });
    }) as typeof fetch;
    const provider = new TestNvidiaProvider({} as any, {} as any);
    await provider.runQuery([{ role: 'user', content: JSON.stringify({ api_key: 'canaryCredentialValue', output: 'DB_PASSWORD=canaryEnvValue contact=canary@example.test <private>privateCanary</private> Bearer canaryBearerValue' }) }], config);
    for (const canary of ['canaryCredentialValue', 'canaryEnvValue', 'canary@example.test', 'privateCanary', 'canaryBearerValue']) expect(body).not.toContain(canary);
  });

  it('keeps completion metadata and rejects IDs belonging to omitted oversized evidence', async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '<summary><request>[U1] inspect</request><investigated>[E2] fabricated</investigated><learned>[E1] incomplete</learned><completed></completed><next_steps>[U1] check</next_steps><notes>[E1] gap</notes></summary>' } }] }), { status: 200 });
    }) as typeof fetch;
    const provider = new TestNvidiaProvider({} as any, {} as any);
    await expect(provider.recovery({ userMessage: 'inspect', finalAssistantMessage: 'large '.repeat(100_000), toolEvidence: [], completionState: 'incomplete', corruptionLines: [9] })).rejects.toBeInstanceOf(ClassifiedProviderError);
    for (const body of bodies) {
      const prompt = JSON.parse(body).messages[1].content;
      expect(prompt).toContain('"completion_state":"incomplete"');
      expect(prompt).toContain('"corrupt_transcript_lines":[9]');
      expect(prompt).not.toContain('[E2]');
    }
  });

  it('preserves canonical evidence through both repairs after large multibyte malformed replies', async () => {
    const requests: Array<{ role: 'system' | 'user' | 'assistant'; content: string }[]> = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)).messages);
      const content = requests.length < 3 ? '錯'.repeat(4000) + '😀'.repeat(100)
        : '<summary><request>[U1] inspect</request><investigated>[E2] partial</investigated><learned>[E1] incomplete</learned><completed></completed><next_steps>[U1] check</next_steps><notes>[E1] gap</notes></summary>';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    const provider = new TestNvidiaProvider({} as any, {} as any);
    (provider as any).getConfig = () => ({ ...config, maxInputTokens: 30000 });
    (provider as any).getSummaryConfig = (value: NvidiaConfig) => value;
    await provider.recovery({ userMessage: '測'.repeat(2100), finalAssistantMessage: '證'.repeat(4000) + '😀'.repeat(100), toolEvidence: [], completionState: 'incomplete', corruptionLines: [9] });
    expect(requests).toHaveLength(3);
    const originalPrompt = requests[0][1].content;
    for (const messages of requests) {
      expect(messages.map(message => message.role)).toEqual(['system', 'user']);
      expect(estimateNvidiaHistoryInputCeiling(messages)).toBeLessThanOrEqual(30000);
      expect(messages[1].content).toStartWith(originalPrompt);
      expect(messages[1].content).toContain('[E1] {"completion_state":"incomplete"');
      expect(messages[1].content).toContain('"corrupt_transcript_lines":[9]');
      expect(messages[1].content).toContain('[E2] ' + '證'.repeat(4000) + '😀'.repeat(100));
      expect(messages[1].content).not.toContain('錯');
    }
    expect(requests[1][1].content).toContain('REPAIR REQUIRED');
    expect(requests[2][1].content).toBe(requests[1][1].content);
  });

  it('defaults both NVIDIA tiers to the verified Lightning model while preserving overrides', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(DEFAULT_NVIDIA_MODEL).toBe('nvidia/nemotron-3.5-lightning-30b-a3b');
    expect(defaults.CLAUDE_MEM_NVIDIA_OBSERVATION_MODEL).toBe(DEFAULT_NVIDIA_MODEL);
    expect(defaults.CLAUDE_MEM_NVIDIA_SUMMARY_MODEL).toBe(DEFAULT_NVIDIA_MODEL);
    expect(config.model).toBe('nvidia/test-model');
  });

  it('classifies NVIDIA status codes and Retry-After', () => {
    const cases: Array<[number, string]> = [[202, 'transient'], [400, 'unrecoverable'], [401, 'auth_invalid'], [403, 'auth_invalid'], [404, 'unrecoverable'], [429, 'rate_limit'], [500, 'transient']];
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
    const compacted = compactNvidiaHistory(history, 1_000);
    expect(compacted.map(m => m.content)).toContain('INIT');
    expect(compacted.map(m => m.content)).toContain('LATEST_ASSISTANT');
    expect(compacted.map(m => m.content)).toContain('SUMMARY_PROMPT');
  });

  it('rejects impossible framing budgets and compacts them to an empty history without looping', async () => {
    const history = [{ role: 'user' as const, content: 'must not hang' }];
    expect(compactNvidiaHistory(history, MIN_NVIDIA_MAX_INPUT_TOKENS - 1)).toEqual([]);
    expect(validateNvidiaSettings({ CLAUDE_MEM_NVIDIA_MAX_INPUT_TOKENS: MIN_NVIDIA_MAX_INPUT_TOKENS - 1 }))
      .toContain(`at least ${MIN_NVIDIA_MAX_INPUT_TOKENS}`);

    globalThis.fetch = (async () => { throw new Error('request must not be sent'); }) as typeof fetch;
    const provider = new TestNvidiaProvider({} as any, {} as any);
    await expect(provider.runQuery(history, { ...config, maxInputTokens: MIN_NVIDIA_MAX_INPUT_TOKENS - 1 }))
      .rejects.toMatchObject({ kind: 'unrecoverable' });
  });

  it('uses a documented UTF-8 ceiling for Turkish and tool-heavy histories', () => {
    const maxInputTokens = 1_000;
    const history = [
      { role: 'user' as const, content: 'Türkçe bağlam: ' + 'çğıİöşü'.repeat(350) },
      { role: 'assistant' as const, content: JSON.stringify({ tool: 'shell', input: 'rg --json src '.repeat(400) }) },
      { role: 'user' as const, content: 'Özetle ve kanıtları koru.' },
    ];
    const compacted = compactNvidiaHistory(history, maxInputTokens);
    expect(estimateNvidiaHistoryInputCeiling(compacted)).toBeLessThanOrEqual(maxInputTokens);
    expect(compacted.map(message => message.content).join('')).not.toBe(history.map(message => message.content).join(''));
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
    expect(validateNvidiaSettings({ CLAUDE_MEM_NVIDIA_BASE_URL: 'http://127.0.0.1:8080/v1', CLAUDE_MEM_NVIDIA_ALLOW_INSECURE_GATEWAY: 'true' })).toBeNull();
    expect(validateNvidiaSettings({ CLAUDE_MEM_NVIDIA_BASE_URL: 'http://127.0.0.1:8080/v1' })).toContain('must use HTTPS');
    expect(validateNvidiaSettings({ CLAUDE_MEM_NVIDIA_BASE_URL: 'http://gateway.example/v1', CLAUDE_MEM_NVIDIA_ALLOW_INSECURE_GATEWAY: 'true' })).toContain('must use HTTPS');
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
