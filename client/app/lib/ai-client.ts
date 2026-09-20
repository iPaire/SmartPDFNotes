// lib/ai-client.ts - Single entry point for LLM chat completions with a
// provider fallback chain and retry/backoff.
//
// Chain: primary OpenAI model -> secondary OpenAI model -> Anthropic Claude.
// Each hop retries transient failures (429 / 5xx / network) with exponential
// backoff before moving to the next model. Anthropic is only attempted when
// ANTHROPIC_API_KEY is configured, so the app runs fine with OpenAI alone.
//
// This replaces the old lib/ai.ts, which was dead code with a broken Claude
// implementation (referenced a non-existent config and used the wrong auth header).
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getErrorMessage } from '@/lib/errors';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

let anthropic: Anthropic | null | undefined;
function getAnthropic(): Anthropic | null {
  if (anthropic !== undefined) return anthropic;
  anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  return anthropic;
}

const ANTHROPIC_FALLBACK_MODEL = process.env.ANTHROPIC_FALLBACK_MODEL || 'claude-opus-4-8';
const OPENAI_SECONDARY_MODEL = process.env.OPENAI_SECONDARY_MODEL || 'gpt-4o-mini';

const RETRIES_PER_MODEL = 2;
const BASE_BACKOFF_MS = 500;

export interface ChatMessageTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  /** Primary OpenAI model, e.g. 'gpt-4o-mini' or 'gpt-3.5-turbo'. */
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  /** Ask the provider for a JSON object response where supported. */
  jsonMode?: boolean;
  /**
   * Optional multi-turn history inserted between the system prompt and the
   * final user prompt. Single-prompt callers are unaffected when omitted.
   */
  messages?: ChatMessageTurn[];
}

export interface ChatCompletionResult {
  content: string;
  provider: 'openai' | 'anthropic';
  model: string;
}

function isRetryable(error: unknown): boolean {
  const e = error as { status?: number; response?: { status?: number } } | null | undefined;
  const status = e?.status ?? e?.response?.status;
  if (status === undefined) return true;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  // network-level failures (no HTTP status)
  return status === undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpenAI(req: ChatCompletionRequest, model: string): Promise<string> {
  const supportsJsonMode =
    req.jsonMode &&
    (model.includes('gpt-4o') || model.includes('gpt-4-turbo') ||
      model.includes('gpt-3.5-turbo-1106') || model.includes('gpt-3.5-turbo-0125'));

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: req.system },
      ...(req.messages ?? []),
      { role: 'user', content: req.prompt },
    ],
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    ...(supportsJsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });

  const content = completion.choices[0]?.message?.content?.trim();
  if (!content) throw new Error(`OpenAI (${model}) returned an empty response`);
  return content;
}

async function callAnthropic(req: ChatCompletionRequest): Promise<string> {
  const client = getAnthropic();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  const system = req.jsonMode
    ? `${req.system}\n\nRespond ONLY with a single valid JSON object. No markdown fences, no prose.`
    : req.system;

  // Note: current Claude models (Opus 4.7+) reject the temperature parameter,
  // so it is intentionally not forwarded here.
  const message = await client.messages.create({
    model: ANTHROPIC_FALLBACK_MODEL,
    max_tokens: req.maxTokens,
    system,
    messages: [
      ...(req.messages ?? []),
      { role: 'user' as const, content: req.prompt },
    ],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!text) throw new Error('Anthropic returned an empty response');
  return text;
}

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === RETRIES_PER_MODEL) break;
      const backoff = BASE_BACKOFF_MS * 2 ** attempt;
      console.warn(`[ai-client] ${label} attempt ${attempt + 1} failed, retrying in ${backoff}ms`, error);
      await sleep(backoff);
    }
  }
  throw lastError;
}

/**
 * Run a chat completion through the fallback chain.
 * Throws only when every provider in the chain has failed.
 */
export async function createChatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
  const openaiModels = req.model === OPENAI_SECONDARY_MODEL
    ? [req.model]
    : [req.model, OPENAI_SECONDARY_MODEL];

  const errors: string[] = [];

  for (const model of openaiModels) {
    try {
      const content = await withRetries(`openai/${model}`, () => callOpenAI(req, model));
      return { content, provider: 'openai', model };
    } catch (error) {
      errors.push(`openai/${model}: ${getErrorMessage(error, String(error))}`);
      console.error(`[ai-client] OpenAI model ${model} exhausted retries`, error);
    }
  }

  if (getAnthropic()) {
    try {
      const content = await withRetries('anthropic', () => callAnthropic(req));
      return { content, provider: 'anthropic', model: ANTHROPIC_FALLBACK_MODEL };
    } catch (error) {
      errors.push(`anthropic/${ANTHROPIC_FALLBACK_MODEL}: ${getErrorMessage(error, String(error))}`);
      console.error('[ai-client] Anthropic fallback exhausted retries', error);
    }
  }

  throw new Error(`All AI providers failed: ${errors.join(' | ')}`);
}

/**
 * Streaming variant used by the workspace chat. Tries OpenAI with
 * stream: true; if the request fails BEFORE the first token, falls back to
 * the non-streaming chain (secondary model -> Anthropic) and yields its full
 * answer as a single chunk. A mid-stream failure propagates to the caller,
 * which should surface a retry to the user.
 */
export async function* createChatCompletionStream(
  req: ChatCompletionRequest
): AsyncGenerator<string, void, undefined> {
  let stream: AsyncIterable<any> | null = null;
  try {
    stream = await openai.chat.completions.create({
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        ...(req.messages ?? []),
        { role: 'user', content: req.prompt },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
    });
  } catch (error) {
    console.warn('[ai-client] streaming request failed before first token, falling back', error);
    const result = await createChatCompletion(req);
    yield result.content;
    return;
  }

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}
