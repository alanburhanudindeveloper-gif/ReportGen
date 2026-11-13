import { ILLMProvider, LLMProviderError, LLMRequest, LLMResponse } from '../abstractions.ts';

export class DeterministicNoOpProvider implements ILLMProvider {
  public readonly name = 'none';
  public readonly defaultModel = 'deterministic-only';

  public isConfigured(): boolean {
    return false;
  }

  public async analyze<T = unknown>(_request: LLMRequest): Promise<LLMResponse<T>> {
    throw new LLMProviderError({
      code: 'MISSING_CONFIGURATION',
      provider: this.name,
      message: 'LLM provider is disabled (LLM_PROVIDER=none); callers should run deterministically.',
      retryable: false,
    });
  }
}
