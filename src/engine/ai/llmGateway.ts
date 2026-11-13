import { ReportGenConfig } from '../core/config.ts';
import { StructuredLogger } from '../core/types.ts';
import {
  ILLMProvider,
  LLMProviderError,
  LLMProviderStatus,
  LLMRequest,
  LLMResponse,
} from './abstractions.ts';
import { ClaudeProvider } from './providers/claudeProvider.ts';
import { DeterministicNoOpProvider } from './providers/deterministicProvider.ts';
import { GeminiProvider } from './providers/geminiProvider.ts';
import { OpenAIProvider } from './providers/openAiProvider.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LLMGatewayOptions {
  logger: StructuredLogger;
  config?: ReportGenConfig;
  providerOverride?: ILLMProvider;
  providerName?: string;
  model?: string;
  baseUrl?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
}

export function resolveProviderInstance(options: {
  providerName: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): ILLMProvider {
  const key = options.providerName.trim().toLowerCase();
  if (key === 'none' || key === 'deterministic' || key === 'offline') {
    return new DeterministicNoOpProvider();
  }
  if (key === 'gemini') {
    return new GeminiProvider({
      defaultModel: options.model,
      timeoutMs: options.timeoutMs,
    });
  }
  if (key === 'openai') {
    return new OpenAIProvider({
      providerName: 'openai',
      defaultModel: options.model,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
    });
  }
  if (key === 'openai-compatible' || key === 'corporate') {
    return new OpenAIProvider({
      providerName: key,
      defaultModel: options.model || 'approved-corporate-model',
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
    });
  }
  if (key === 'claude' || key === 'anthropic') {
    return new ClaudeProvider({
      defaultModel: options.model,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
    });
  }

  throw new LLMProviderError({
    code: 'UNKNOWN_PROVIDER',
    provider: options.providerName,
    message: `Unsupported LLM provider "${options.providerName}". Valid options: gemini, openai, openai-compatible, claude, none.`,
    retryable: false,
  });
}

export class LLMGateway {
  private readonly logger: StructuredLogger;
  private readonly enabled: boolean;
  private readonly provider: ILLMProvider;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly temperature?: number;
  private readonly endpointConfigured: boolean;

  constructor(options: LLMGatewayOptions) {
    this.logger = options.logger;
    const aiCfg = options.config?.ai;
    const rawProvider =
      options.providerOverride?.name ??
      options.providerName ??
      process.env.LLM_PROVIDER ??
      aiCfg?.provider ??
      'none';
    this.timeoutMs = options.timeoutMs ?? aiCfg?.timeoutMs ?? 25000;
    this.maxRetries = options.maxRetries ?? aiCfg?.maxRetries ?? 1;
    this.temperature = options.temperature ?? aiCfg?.temperature;
    const baseUrl = options.baseUrl ?? process.env.LLM_BASE_URL ?? aiCfg?.baseUrl;

    const envEnabled =
      process.env.LLM_ENABLED !== undefined
        ? process.env.LLM_ENABLED.toLowerCase() !== 'false'
        : undefined;
    const requestedEnabled = options.enabled ?? envEnabled ?? aiCfg?.enabled ?? true;
    this.enabled =
      requestedEnabled &&
      rawProvider.toLowerCase() !== 'none' &&
      rawProvider.toLowerCase() !== 'deterministic';

    this.provider =
      options.providerOverride ??
      resolveProviderInstance({
        providerName: rawProvider,
        model: options.model ?? process.env.LLM_MODEL ?? aiCfg?.model,
        baseUrl,
        timeoutMs: this.timeoutMs,
      });

    this.model =
      options.model ??
      process.env.LLM_MODEL ??
      aiCfg?.model ??
      this.provider.defaultModel;
    this.endpointConfigured = Boolean(baseUrl);
  }

  public getStatus(): LLMProviderStatus {
    const status: LLMProviderStatus['status'] = !this.enabled
      ? 'disabled'
      : this.provider.isConfigured()
      ? 'connected'
      : 'unconfigured';

    return {
      enabled: this.enabled,
      provider: this.provider.name,
      model: this.model,
      status,
      endpointConfigured: this.endpointConfigured,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    };
  }

  public isAvailable(): boolean {
    return this.enabled && this.provider.isConfigured();
  }

  public async execute<T = unknown>(
    request: LLMRequest,
    validator?: (parsed: unknown, response: LLMResponse<unknown>) => T
  ): Promise<{ response: LLMResponse<unknown>; validated: T }> {
    if (!this.enabled) {
      throw new LLMProviderError({
        code: 'MISSING_CONFIGURATION',
        provider: this.provider.name,
        message: 'LLM reasoning is disabled by configuration.',
        retryable: false,
      });
    }

    const retries = Math.max(0, request.maxRetries ?? this.maxRetries);
    const enrichedRequest: LLMRequest = {
      ...request,
      model: request.model ?? this.model,
      timeoutMs: request.timeoutMs ?? this.timeoutMs,
      temperature: request.temperature ?? this.temperature,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.provider.analyze<unknown>(enrichedRequest);
        if (request.responseFormat === 'json' && res.parsedJson === undefined) {
          throw new LLMProviderError({
            code: 'INVALID_RESPONSE',
            provider: this.provider.name,
            message: 'Structured JSON response expected but parsedJson was empty.',
            retryable: false,
          });
        }
        const validated = validator
          ? validator(res.parsedJson ?? res.rawText, res)
          : ((res.parsedJson ?? res.rawText) as T);

        this.logger.info('LLMGateway', `Completed ${request.task} via ${res.provider}`, {
          provider: res.provider,
          model: res.model,
          latencyMs: res.latencyMs,
          tokens: res.usage?.totalTokens,
        });

        return { response: res, validated };
      } catch (err) {
        lastError = err;
        const retryable = err instanceof LLMProviderError && err.retryable;
        if (!retryable || attempt >= retries || request.signal?.aborted) {
          throw err;
        }
        const backoffMs = 250 * Math.pow(2, attempt);
        this.logger.warn('LLMGateway', `Retrying ${request.task} after transient provider error`, {
          provider: this.provider.name,
          attempt: attempt + 1,
          backoffMs,
        });
        await delay(backoffMs);
      }
    }

    throw lastError;
  }
}

export function createLLMGateway(options: LLMGatewayOptions): LLMGateway {
  return new LLMGateway(options);
}
