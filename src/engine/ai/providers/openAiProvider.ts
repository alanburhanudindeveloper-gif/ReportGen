import { ILLMProvider, LLMProviderError, LLMRequest, LLMResponse } from '../abstractions.ts';

export interface OpenAIProviderOptions {
  providerName?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export class OpenAIProvider implements ILLMProvider {
  public readonly name: string;
  public readonly defaultModel: string;
  private readonly explicitApiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: OpenAIProviderOptions = {}) {
    this.name = options.providerName || 'openai';
    this.explicitApiKey = options.apiKey;
    this.baseUrl = (
      options.baseUrl ||
      process.env.LLM_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      'https://api.openai.com/v1'
    ).replace(/\/+$/, '');
    this.defaultModel = options.defaultModel || 'gpt-4o-mini';
    this.defaultTimeoutMs = options.timeoutMs ?? 25000;
  }

  private resolveApiKey(): string | undefined {
    return this.explicitApiKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
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
        message: 'OPENAI_API_KEY (or LLM_API_KEY) is not configured in environment.',
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
      const endpoint = `${this.baseUrl}/chat/completions`;
      const bodyPayload: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: request.systemInstruction },
          { role: 'user', content: request.prompt },
        ],
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      };

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(bodyPayload),
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
          message: `${this.name} HTTP ${resp.status}: ${errText.slice(0, 240)}`,
        });
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const rawText = (data.choices?.[0]?.message?.content ?? '').trim();
      let parsedJson: T | undefined;
      if (request.responseFormat === 'json') {
        try {
          parsedJson = JSON.parse(rawText || '{}') as T;
        } catch (parseErr) {
          throw new LLMProviderError({
            code: 'INVALID_RESPONSE',
            provider: this.name,
            message: `${this.name} returned invalid JSON for structured request.`,
            retryable: false,
            cause: parseErr,
          });
        }
      }

      return {
        provider: this.name,
        model,
        rawText,
        parsedJson,
        usage: data.usage
          ? {
              inputTokens: data.usage.prompt_tokens,
              outputTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
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
            ? `${this.name} request timed out after ${timeoutMs}ms.`
            : `${this.name} request was cancelled.`,
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
