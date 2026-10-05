// Backend 1: any OpenAI-compatible chat endpoint (vLLM, llama.cpp server, ...). Global fetch, no dependencies.

import { JUDGE_JSON_SCHEMA } from './prompt.ts';
import { BackendError, type JudgeBackend, type JudgeCompletion, type JudgePrompt } from './types.ts';

export interface OpenAiOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  structured: boolean; // response_format: json_schema (vLLM guided decoding)
  timeoutMs: number;
  retries: number; // additional attempts after the first
  backoffMs: number; // first backoff, doubled each retry, with jitter
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function chatUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

export function buildRequestBody(model: string, p: JudgePrompt, structured: boolean): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ],
    temperature: 0,
    max_tokens: 600,
    ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'agento_judge', strict: true, schema: JUDGE_JSON_SCHEMA } } } : {}),
  };
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const retryableStatus = (s: number): boolean => s === 408 || s === 425 || s === 429 || s >= 500;

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function openAiBackend(o: OpenAiOptions): JudgeBackend {
  const doFetch = o.fetchFn ?? fetch;
  const sleep = o.sleep ?? sleepMs;
  const url = chatUrl(o.baseUrl);

  async function once(p: JudgePrompt): Promise<JudgeCompletion> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
        body: JSON.stringify(buildRequestBody(o.model, p, o.structured)),
        signal: AbortSignal.timeout(o.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new BackendError(timeout ? `timeout after ${o.timeoutMs} ms` : `request failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new BackendError(`HTTP ${res.status}${body ? `: ${body}` : ''}`, retryableStatus(res.status));
    }
    let json: ChatResponse;
    try {
      json = (await res.json()) as ChatResponse;
    } catch {
      throw new BackendError('response is not JSON', true);
    }
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new BackendError('response has no choices[0].message.content', false);
    return {
      text,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
      resolvedModel: json.model,
    };
  }

  return {
    kind: 'openai',
    model: o.model,
    async complete(p) {
      let last: BackendError | undefined;
      for (let attempt = 0; attempt <= o.retries; attempt++) {
        try {
          return await once(p);
        } catch (e) {
          if (!(e instanceof BackendError)) throw e;
          last = e;
          if (!e.retryable || attempt === o.retries) break;
          await sleep(o.backoffMs * 2 ** attempt * (0.75 + Math.random() * 0.5));
        }
      }
      throw last ?? new BackendError('request failed');
    },
  };
}
