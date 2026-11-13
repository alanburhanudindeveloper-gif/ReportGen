import { ILLMProvider, LLMProviderError, LLMRequest, LLMResponse } from '../abstractions.ts';

export interface ClaudeProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export class ClaudeProvider implements ILLMProvider {
  public readonly name = 'claude';
  public readonly defaultModel: string;
  private readonly explicitApiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: ClaudeProviderOptions = {}) {
    this.explicitApiKey = options.apiKey;
    this.baseUrl = (
      options.baseUrl ||
      process.env.LLM_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      'https://api.anthropic.com/v1'
    ).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel || 'claude-sonnet-4-20250514';
    this.defaultTimeoutMs = options.timeoutMs ?? 25000;
  }

  private resolveApiKey(): string | undefined {
    return this.explicitApiKey || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY;
  }

  public isConfigured(): boolean {
    return Boolean(this.resolveApiKey());
  }

  public async analyze<T = unknown>(request: LLMRequest): Promise<LLMResponse<T>> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new LLMProviderError({
        code: 'MISSING_CONFIGURATION',
        provider: this.name,
        message: 'ANTHROPIC_API_KEY (or LLM_API_KEY) is not configured in environment.',
        retryable: false,
      });
    }

    if (request.signal?.aborted) {
      throw new LLMProviderError({
        code: 'CANCELLED',
        provider: this.name,
        message: 'LLM request cancelled before execution.',
        retryable: false,
      });
    }

    const model = request.model || this.defaultModel;
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const started = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onExternalAbort = () => controller.abort(request.signal?.reason ?? new Error('cancelled'));
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const endpoint = `${this.baseUrl}/messages`;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: request.systemInstruction,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          messages: [{ role: 'user', content: request.prompt }],
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const code =
          resp.status === 401 || resp.status === 403
            ? 'AUTH_ERROR'
            : resp.status === 429
            ? 'RATE_LIMITED'
            : 'PROVIDER_ERROR';
        throw new LLMProviderError({
          code,
          provider: this.name,
          statusCode: resp.status,
          retryable: resp.status === 429 || resp.status >= 500,
          message: `Claude HTTP ${resp.status}: ${errText.slice(0, 240)}`,
        });
      }

      const data = (await resp.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const rawText = (data.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join('\n')
        .trim();

      let parsedJson: T | undefined;
      if (request.responseFormat === 'json') {
        try {
          parsedJson = JSON.parse(extractJsonBlock(rawText) || '{}') as T;
        } catch (parseErr) {
          throw new LLMProviderError({
            code: 'INVALID_RESPONSE',
            provider: this.name,
            message: 'Claude returned invalid JSON for structured request.',
            retryable: false,
            cause: parseErr,
          });
        }
      }

      const inputTokens = data.usage?.input_tokens;
      const outputTokens = data.usage?.output_tokens;

      return {
        provider: this.name,
        model,
        rawText,
        parsedJson,
        usage:
          inputTokens !== undefined || outputTokens !== undefined
            ? {
                inputTokens,
                outputTokens,
                totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
              }
            : undefined,
        latencyMs: Date.now() - started,
        metadata: request.metadata,
      };
    } catch (err) {
      if (err instanceof LLMProviderError) throw err;
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        const isTimeout = reason instanceof Error && reason.message === 'timeout';
        throw new LLMProviderError({
          code: isTimeout ? 'TIMEOUT' : 'CANCELLED',
          provider: this.name,
          message: isTimeout
            ? `Claude request timed out after ${timeoutMs}ms.`
            : 'Claude request was cancelled.',
          retryable: isTimeout,
          cause: err,
        });
      }
      throw new LLMProviderError({
        code: 'PROVIDER_ERROR',
        provider: this.name,
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
