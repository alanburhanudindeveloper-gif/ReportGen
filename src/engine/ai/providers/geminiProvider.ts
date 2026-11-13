import { GoogleGenAI, Schema, Type } from '@google/genai';
import {
  ILLMProvider,
  LLMJsonSchema,
  LLMProviderError,
  LLMRequest,
  LLMResponse,
} from '../abstractions.ts';

function toGeminiType(t: LLMJsonSchema['type']): Type {
  switch (t) {
    case 'OBJECT':
      return Type.OBJECT;
    case 'ARRAY':
      return Type.ARRAY;
    case 'STRING':
      return Type.STRING;
    case 'NUMBER':
      return Type.NUMBER;
    case 'INTEGER':
      return Type.INTEGER;
    case 'BOOLEAN':
      return Type.BOOLEAN;
    case 'NULL':
      return Type.NULL;
  }
}

function toGeminiSchema(schema: LLMJsonSchema): Schema {
  const out: Schema = {
    type: toGeminiType(schema.type),
  };
  if (schema.description) out.description = schema.description;
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
  }
  return out;
}

export interface GeminiProviderOptions {
  apiKey?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export class GeminiProvider implements ILLMProvider {
  public readonly name = 'gemini';
  public readonly defaultModel: string;
  private readonly explicitApiKey?: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: GeminiProviderOptions = {}) {
    this.explicitApiKey = options.apiKey;
    this.defaultModel = options.defaultModel || 'gemini-4-hydrogen';
    this.defaultTimeoutMs = options.timeoutMs ?? 25000;
  }

  private resolveApiKey(): string | undefined {
    return this.explicitApiKey || process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
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
        message: 'GEMINI_API_KEY (or LLM_API_KEY) is not configured in environment.',
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

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onExternalAbort = () => controller.abort(request.signal?.reason ?? new Error('cancelled'));
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const callPromise = ai.models.generateContent({
        model,
        contents: request.prompt,
        config: {
          systemInstruction: request.systemInstruction,
          ...(request.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
          ...(request.responseSchema ? { responseSchema: toGeminiSchema(request.responseSchema) } : {}),
        },
      });

      const abortPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            const reason = controller.signal.reason;
            const isTimeout = reason instanceof Error && reason.message === 'timeout';
            reject(
              new LLMProviderError({
                code: isTimeout ? 'TIMEOUT' : 'CANCELLED',
                provider: this.name,
                message: isTimeout
                  ? `Gemini request timed out after ${timeoutMs}ms.`
                  : 'Gemini request was cancelled.',
                retryable: isTimeout,
              })
            );
          },
          { once: true }
        );
      });

      const response = await Promise.race([callPromise, abortPromise]);
      const rawText = (response.text ?? '').trim();

      let parsedJson: T | undefined;
      if (request.responseFormat === 'json') {
        try {
          parsedJson = JSON.parse(rawText || '{}') as T;
        } catch (parseErr) {
          throw new LLMProviderError({
            code: 'INVALID_RESPONSE',
            provider: this.name,
            message: 'Gemini returned non-JSON output for structured JSON request.',
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
        usage: response.usageMetadata
          ? {
              inputTokens: response.usageMetadata.promptTokenCount,
              outputTokens: response.usageMetadata.candidatesTokenCount,
              totalTokens: response.usageMetadata.totalTokenCount,
            }
          : undefined,
        latencyMs: Date.now() - started,
        metadata: request.metadata,
      };
    } catch (err) {
      if (err instanceof LLMProviderError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const isAuth = /401|403|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg);
      const isRate = /429|RESOURCE_EXHAUSTED/i.test(msg);
      throw new LLMProviderError({
        code: isAuth ? 'AUTH_ERROR' : isRate ? 'RATE_LIMITED' : 'PROVIDER_ERROR',
        provider: this.name,
        message: msg,
        retryable: isRate || /500|502|503|504|ECONNRESET|ETIMEDOUT/i.test(msg),
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
