import { setTimeout as delay } from 'node:timers/promises';
import type { JsonModel } from './model.ts';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface DeepSeekOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  /** Overall deadline, including retries and response-body consumption. */
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

/** Provider-reported tokens, not a price estimate; requests include HTTP retries. */
export interface DeepSeekUsage {
  requests: number;
  successfulJsonResponses: number;
  providerUsageResponses: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class DeepSeekError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  constructor(code: string, message: string, status?: number) {
    super(`${code}: ${message}`);
    this.name = 'DeepSeekError'; this.code = code; this.status = status;
  }
}

function configurationError(message: string): never {
  throw new DeepSeekError('DEEPSEEK_CONFIG_INVALID', message);
}

function endpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { return configurationError('The model base URL must be an absolute HTTPS URL.'); }
  if (url.username || url.password || /[?#]/u.test(baseUrl)) {
    return configurationError('The model base URL must not contain credentials, query parameters or fragments.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return configurationError('HTTPS is required; HTTP is allowed only for a loopback test server.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/chat/completions`;
  return url.toString();
}

function resolved(options: DeepSeekOptions) {
  if (typeof options.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(options.apiKey)) {
    return configurationError('Provide DEEPSEEK_API_KEY locally; its value must be a nonempty token without whitespace.');
  }
  const model = options.model ?? DEFAULT_MODEL;
  if (typeof model !== 'string' || model.length === 0 || model.length > 200
    || model !== model.trim() || /[\x00-\x1f\x7f]/u.test(model)) {
    return configurationError('The model name must be a nonempty identifier without control characters.');
  }
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxRetries = options.maxRetries ?? 1;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    return configurationError('timeoutMs must be an integer from 1 to 300000.');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) {
    return configurationError('maxRetries must be an integer from 0 to 3.');
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  if (typeof baseUrl !== 'string' || baseUrl !== baseUrl.trim()) return configurationError('The model base URL is invalid.');
  return { apiKey: options.apiKey, model, timeoutMs, maxRetries, endpoint: endpoint(baseUrl) };
}

/** Reads only project-specific DeepSeek variables; never falls back to another provider's credentials. */
export function loadDeepSeekConfig(env: NodeJS.ProcessEnv = process.env): DeepSeekOptions {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new DeepSeekError('DEEPSEEK_KEY_MISSING', 'Set DEEPSEEK_API_KEY in the local environment or .env.local.');
  const timeout = env.DEEPSEEK_TIMEOUT_MS;
  if (timeout !== undefined && !/^[1-9]\d*$/u.test(timeout)) return configurationError('DEEPSEEK_TIMEOUT_MS must be a positive integer.');
  const options: DeepSeekOptions = {
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
    model: env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
    timeoutMs: timeout === undefined ? 90_000 : Number(timeout),
    maxRetries: 1,
  };
  resolved(options);
  return options;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function boundedBody(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new DeepSeekError('DEEPSEEK_RESPONSE_TOO_LARGE', 'The model response exceeded the size limit.');
  }
  if (!response.body) throw new DeepSeekError('DEEPSEEK_RESPONSE_INVALID', 'The model response body is missing.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new DeepSeekError('DEEPSEEK_RESPONSE_TOO_LARGE', 'The model response exceeded the size limit.');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new DeepSeekError('DEEPSEEK_RESPONSE_INVALID', 'The model response is not valid UTF-8.'); }
}

function completion(body: string, statistics?: DeepSeekUsage): unknown {
  let envelope: unknown;
  try { envelope = JSON.parse(body); }
  catch { throw new DeepSeekError('DEEPSEEK_RESPONSE_INVALID', 'The model service returned a non-JSON response.'); }
  if (statistics && object(envelope) && object(envelope.usage)) {
    const usage = envelope.usage;
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (valid(usage.prompt_tokens) && valid(usage.completion_tokens) && valid(usage.total_tokens)) {
      statistics.providerUsageResponses += 1;
      statistics.promptTokens += usage.prompt_tokens; statistics.completionTokens += usage.completion_tokens;
      statistics.totalTokens += usage.total_tokens;
    }
  }
  const choice = object(envelope) && Array.isArray(envelope.choices) ? envelope.choices[0] as unknown : undefined;
  if (!object(choice) || !object(choice.message)) {
    throw new DeepSeekError('DEEPSEEK_RESPONSE_INVALID', 'The model response has no complete assistant message.');
  }
  if (choice.finish_reason === 'length') {
    throw new DeepSeekError('DEEPSEEK_TRUNCATED', 'The model response was truncated; reduce the input or output scope.');
  }
  if (choice.finish_reason !== 'stop') {
    throw new DeepSeekError('DEEPSEEK_RESPONSE_INCOMPLETE', 'The model did not finish with a complete JSON answer.');
  }
  const content = choice.message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new DeepSeekError('DEEPSEEK_EMPTY_CONTENT', 'The model returned an empty JSON answer.');
  }
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new DeepSeekError('DEEPSEEK_JSON_INVALID', 'The assistant answer is not valid JSON.'); }
  if (!object(value)) throw new DeepSeekError('DEEPSEEK_JSON_INVALID', 'The assistant answer must be a JSON object.');
  return value;
}

function redirectFailure(error: unknown): boolean {
  // Inspect native fetch diagnostics only for classification. Never expose them,
  // response bodies or a caller's abort reason in a public error.
  if (!(error instanceof Error)) return false;
  return /redirect/iu.test(error.message)
    || (error.cause instanceof Error && /redirect/iu.test(error.cause.message));
}

/** Narrow JSON transport; domain schemas, source grounding and professional review are separate. */
export function createDeepSeekModel(options: DeepSeekOptions): JsonModel & { getUsage(): Readonly<DeepSeekUsage> } {
  const config = resolved(options);
  const statistics: DeepSeekUsage = { requests: 0, successfulJsonResponses: 0, providerUsageResponses: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return Object.freeze({
    id: 'deepseek-json@1', model: config.model,
    getUsage: () => Object.freeze({ ...statistics }),
    async complete(input: { system: string; user: string; signal?: AbortSignal; reasoning?: 'none' | 'high' }): Promise<unknown> {
      if (typeof input.system !== 'string' || typeof input.user !== 'string') {
        throw new DeepSeekError('DEEPSEEK_INPUT_INVALID', 'Model system and user inputs must be strings.');
      }
      if (input.signal?.aborted) throw new DeepSeekError('DEEPSEEK_CANCELLED', 'The model request was cancelled.');
      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => { controller.abort(); };
      input.signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
      const system = /json/iu.test(input.system) ? input.system : `${input.system}\nReturn a JSON object only.`;
      const body = JSON.stringify({
        model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: input.user }],
        response_format: { type: 'json_object' },
        ...(input.reasoning === 'high' ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
          : { thinking: { type: 'disabled' }, temperature: 0 }),
        stream: false, max_tokens: input.reasoning === 'high' ? 32768 : 8192,
      });
      try {
        for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
          try {
            statistics.requests += 1;
            const response = await fetch(config.endpoint, {
              method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
              body, signal: controller.signal, redirect: 'error',
            });
            if (!response.ok) {
              void response.body?.cancel().catch(() => {});
              throw new DeepSeekError('DEEPSEEK_HTTP_ERROR', `The model service returned HTTP ${response.status}.`, response.status);
            }
            const result = completion(await boundedBody(response), statistics);
            statistics.successfulJsonResponses += 1;
            return result;
          } catch (error) {
            if (timedOut) throw new DeepSeekError('DEEPSEEK_TIMEOUT', 'The model request exceeded its overall deadline.');
            if (input.signal?.aborted) throw new DeepSeekError('DEEPSEEK_CANCELLED', 'The model request was cancelled.');
            if (redirectFailure(error)) throw new DeepSeekError('DEEPSEEK_REDIRECT_REJECTED', 'Model endpoint redirects are not followed.');
            const network = !(error instanceof DeepSeekError);
            const transientHttp = error instanceof DeepSeekError && error.code === 'DEEPSEEK_HTTP_ERROR'
              && (error.status === 429 || (error.status !== undefined && error.status >= 500));
            if ((!network && !transientHttp) || attempt === config.maxRetries) {
              if (error instanceof DeepSeekError) throw error;
              throw new DeepSeekError('DEEPSEEK_NETWORK_ERROR', 'The model service could not be reached or its response connection failed.');
            }
            await delay(Math.min(100 * 2 ** attempt, 1000), undefined, { signal: controller.signal });
          }
        }
        throw new DeepSeekError('DEEPSEEK_NETWORK_ERROR', 'The model request could not be completed.');
      } catch (error) {
        if (timedOut) throw new DeepSeekError('DEEPSEEK_TIMEOUT', 'The model request exceeded its overall deadline.');
        if (input.signal?.aborted) throw new DeepSeekError('DEEPSEEK_CANCELLED', 'The model request was cancelled.');
        if (error instanceof DeepSeekError) throw error;
        throw new DeepSeekError('DEEPSEEK_NETWORK_ERROR', 'The model request could not be completed.');
      } finally {
        clearTimeout(timer); input.signal?.removeEventListener('abort', cancel); controller.abort();
      }
    },
  });
}
