export type LLMProviderName =
  | 'gemini'
  | 'openai'
  | 'openai-compatible'
  | 'claude'
  | 'anthropic'
  | 'none'
  | 'deterministic'
  | (string & {});

export type LLMJsonSchemaType =
  | 'OBJECT'
  | 'ARRAY'
  | 'STRING'
  | 'NUMBER'
  | 'INTEGER'
  | 'BOOLEAN'
  | 'NULL';

export interface LLMJsonSchema {
  type: LLMJsonSchemaType;
  description?: string;
  properties?: Record<string, LLMJsonSchema>;
  items?: LLMJsonSchema;
  required?: string[];
}

export interface LLMRequest {
  task: string;
  systemInstruction: string;
  prompt: string;
  responseFormat: 'json' | 'text';
  responseSchema?: LLMJsonSchema;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  metadata?: Record<string, string | number | boolean>;
}

export interface LLMTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LLMResponse<T = unknown> {
  provider: string;
  model: string;
  rawText: string;
  parsedJson?: T;
  usage?: LLMTokenUsage;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export type LLMProviderErrorCode =
  | 'UNKNOWN_PROVIDER'
  | 'MISSING_CONFIGURATION'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'VALIDATION_FAILED';

export class LLMProviderError extends Error {
  public readonly code: LLMProviderErrorCode;
  public readonly provider: string;
  public readonly retryable: boolean;
  public readonly statusCode?: number;

  constructor(options: {
    code: LLMProviderErrorCode;
    provider: string;
    message: string;
    retryable?: boolean;
    statusCode?: number;
    cause?: unknown;
  }) {
    super(`[LLM:${options.provider}:${options.code}] ${options.message}`, {
      cause: options.cause,
    });
    this.name = 'LLMProviderError';
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
  }
}

export interface LLMProviderStatus {
  enabled: boolean;
  provider: string;
  model: string;
  status: 'connected' | 'unconfigured' | 'disabled';
  endpointConfigured: boolean;
  timeoutMs: number;
  maxRetries: number;
}

export interface ILLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  isConfigured(): boolean;
  analyze<T = unknown>(request: LLMRequest): Promise<LLMResponse<T>>;
}
