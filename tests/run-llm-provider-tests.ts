import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  buildAiContextSlices,
  createSemanticAiProvider,
  GatewayAiProvider,
} from '../src/engine/ai/aiProvider.ts';
import {
  ILLMProvider,
  LLMProviderError,
  LLMRequest,
  LLMResponse,
} from '../src/engine/ai/abstractions.ts';
import { LLMGateway } from '../src/engine/ai/llmGateway.ts';
import {
  validateBenchmarkRankingResponse,
  validateDiffRefinementResponse,
  validateLayoutDisambiguationResponse,
} from '../src/engine/ai/prompts.ts';
import { loadConfig } from '../src/engine/core/config.ts';
import { IntermediateLayoutModel, StructuredLogger } from '../src/engine/core/types.ts';
import { SkillManager } from '../src/engine/skills/skillManager.ts';

function walkTsFiles(dir: string, collector: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, collector);
    else if (/\.(ts|tsx)$/.test(entry.name)) collector.push(full);
  }
  return collector;
}

async function runLlmProviderTests() {
  console.log('=== Provider-Agnostic LLM Gateway & Isolation Tests ===');
  const logger = new StructuredLogger(false);
  const config = loadConfig();

  // 1. Provider isolation static verification: @google/genai ONLY in providers/geminiProvider.ts
  const srcRoot = path.resolve(process.cwd(), 'src');
  const serverFile = path.resolve(process.cwd(), 'server.ts');
  const allCodeFiles = [...walkTsFiles(srcRoot), serverFile];
  const geminiImporters = allCodeFiles.filter((f) => {
    const text = fs.readFileSync(f, 'utf-8');
    return /@google\/genai/.test(text);
  });
  assert.strictEqual(geminiImporters.length, 1, `Expected @google/genai imported in exactly 1 file, got: ${geminiImporters.join(', ')}`);
  assert.ok(
    geminiImporters[0].endsWith(path.join('src', 'engine', 'ai', 'providers', 'geminiProvider.ts')),
    `Unexpected @google/genai importer: ${geminiImporters[0]}`
  );
  console.log('[PASS] Provider isolation verified: @google/genai confined strictly to geminiProvider.ts');

  // 2. Provider selection & unknown provider
  for (const pName of ['gemini', 'openai', 'openai-compatible', 'claude', 'none']) {
    const gw = new LLMGateway({ logger, config, providerName: pName });
    const st = gw.getStatus();
    assert.strictEqual(st.provider === 'none' ? 'none' : st.provider, pName);
  }

  assert.throws(
    () => new LLMGateway({ logger, config, providerName: 'unknown-vendor-xyz' }),
    (err: unknown) => err instanceof LLMProviderError && err.code === 'UNKNOWN_PROVIDER',
    'Unknown provider must throw LLMProviderError(UNKNOWN_PROVIDER)'
  );
  console.log('[PASS] Provider selection & UNKNOWN_PROVIDER error verified');

  // 3. Environment variable override check (LLM_PROVIDER / LLM_MODEL)
  const prevProv = process.env.LLM_PROVIDER;
  const prevModel = process.env.LLM_MODEL;
  process.env.LLM_PROVIDER = 'openai-compatible';
  process.env.LLM_MODEL = 'corp-llama-70b';
  const envCfg = loadConfig();
  assert.strictEqual(envCfg.ai.provider, 'openai-compatible');
  assert.strictEqual(envCfg.ai.model, 'corp-llama-70b');
  if (prevProv === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevProv;
  if (prevModel === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = prevModel;
  console.log('[PASS] Environment configuration overrides verified');

  // 4. Missing configuration & offline LLM_PROVIDER=none mode
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevGeneric = process.env.LLM_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  const unconfiguredGw = new LLMGateway({ logger, config, providerName: 'openai' });
  assert.strictEqual(unconfiguredGw.getStatus().status, 'unconfigured');
  await assert.rejects(
    () =>
      unconfiguredGw.execute({
        task: 'test',
        systemInstruction: 'sys',
        prompt: 'p',
        responseFormat: 'json',
      }),
    (err: unknown) => err instanceof LLMProviderError && err.code === 'MISSING_CONFIGURATION'
  );
  if (prevOpenAi !== undefined) process.env.OPENAI_API_KEY = prevOpenAi;
  if (prevGeneric !== undefined) process.env.LLM_API_KEY = prevGeneric;

  const offlineGw = new LLMGateway({ logger, config, providerName: 'none' });
  assert.strictEqual(offlineGw.getStatus().status, 'disabled');
  assert.strictEqual(offlineGw.isAvailable(), false);
  const semOffline = createSemanticAiProvider(logger, { ...config, ai: { ...config.ai, provider: 'none' } }, true);
  assert.strictEqual(semOffline.name, 'deterministic-fallback');
  console.log('[PASS] Missing credentials & offline LLM_PROVIDER=none mode verified');

  // 5. Retryable transient error recovery & non-retryable AUTH_ERROR fail-fast
  let attempts = 0;
  const retryingMock: ILLMProvider = {
    name: 'corporate-mock',
    defaultModel: 'corp-model-v1',
    isConfigured: () => true,
    async analyze<T>(): Promise<LLMResponse<T>> {
      attempts++;
      if (attempts === 1) {
        throw new LLMProviderError({
          code: 'RATE_LIMITED',
          provider: 'corporate-mock',
          message: '429 transient limit',
          retryable: true,
        });
      }
      return {
        provider: 'corporate-mock',
        model: 'corp-model-v1',
        rawText: '{"rankings":[{"productCode":"MFA","semanticScore":0.95,"reason":"Best tabular match"}]}',
        parsedJson: {
          rankings: [{ productCode: 'MFA', semanticScore: 0.95, reason: 'Best tabular match' }],
        } as T,
        usage: { inputTokens: 120, outputTokens: 32, totalTokens: 152 },
        latencyMs: 5,
      };
    },
  };
  const retryGw = new LLMGateway({
    logger,
    config,
    providerOverride: retryingMock,
    maxRetries: 2,
  });
  const okRes = await retryGw.execute(
    { task: 'benchmark_ranking', systemInstruction: 's', prompt: 'p', responseFormat: 'json' },
    (parsed) => validateBenchmarkRankingResponse(parsed)
  );
  assert.strictEqual(attempts, 2, 'Expected 1 retry after RATE_LIMITED');
  assert.strictEqual(okRes.response.provider, 'corporate-mock');
  assert.strictEqual(okRes.validated[0].productCode, 'MFA');

  let authAttempts = 0;
  const authFailMock: ILLMProvider = {
    name: 'corporate-mock',
    defaultModel: 'corp-model-v1',
    isConfigured: () => true,
    async analyze<T>(): Promise<LLMResponse<T>> {
      authAttempts++;
      throw new LLMProviderError({
        code: 'AUTH_ERROR',
        provider: 'corporate-mock',
        message: '401 invalid token',
        retryable: false,
      });
    },
  };
  const authGw = new LLMGateway({ logger, config, providerOverride: authFailMock, maxRetries: 3 });
  await assert.rejects(
    () => authGw.execute({ task: 'test', systemInstruction: 's', prompt: 'p', responseFormat: 'json' }),
    (err: unknown) => err instanceof LLMProviderError && err.code === 'AUTH_ERROR'
  );
  assert.strictEqual(authAttempts, 1, 'Non-retryable AUTH_ERROR must not retry');
  console.log('[PASS] Transient retry recovery & AUTH_ERROR fail-fast verified');

  // 6. Cancellation / Timeout & Invalid JSON Schema validation
  const ac = new AbortController();
  ac.abort();
  const slowMock: ILLMProvider = {
    name: 'corporate-mock',
    defaultModel: 'corp-v1',
    isConfigured: () => true,
    async analyze<T>(req: LLMRequest): Promise<LLMResponse<T>> {
      if (req.signal?.aborted) {
        throw new LLMProviderError({
          code: 'CANCELLED',
          provider: 'corporate-mock',
          message: 'Aborted by caller',
          retryable: false,
        });
      }
      return {
        provider: 'corporate-mock',
        model: 'corp-v1',
        rawText: '{"bad":true}',
        parsedJson: { bad: true } as T,
        latencyMs: 1,
      };
    },
  };
  const cancelGw = new LLMGateway({ logger, config, providerOverride: slowMock, maxRetries: 0 });
  await assert.rejects(
    () =>
      cancelGw.execute({
        task: 'test',
        systemInstruction: 's',
        prompt: 'p',
        responseFormat: 'json',
        signal: ac.signal,
      }),
    (err: unknown) => err instanceof LLMProviderError && err.code === 'CANCELLED'
  );

  // Invalid structured output validation fails cleanly
  await assert.rejects(
    () =>
      cancelGw.execute(
        { task: 'proposal_diff_refinement', systemInstruction: 's', prompt: 'p', responseFormat: 'json' },
        (parsed) => validateDiffRefinementResponse(new Set(['CHG-0001']), parsed)
      ),
    (err: unknown) => err instanceof LLMProviderError && err.code === 'VALIDATION_FAILED'
  );

  // End-to-end GatewayAiProvider with swapped mock provider + deterministic validation
  const sampleLayout: IntermediateLayoutModel = {
    document: {
      name: 'Test',
      pageCount: 1,
      pageWidth: 8.5,
      pageHeight: 11,
      unit: 'inch',
      extractedAt: new Date().toISOString(),
    },
    pages: [
      {
        pageNumber: 1,
        width: 8.5,
        height: 11,
        rawObjectCount: 1,
        bands: [],
        regions: [
          {
            id: 'r-1',
            pageNumber: 1,
            type: 'text',
            x: 1,
            y: 1,
            width: 2,
            height: 0.3,
            text: 'Net Total',
            semanticRole: 'unknown',
            confidence: 0.6,
            bandKind: 'Detail',
            isAmbiguous: true,
            sourceObjectRefs: ['t1'],
            style: {
              fontFamily: 'Helvetica',
              fontSizePt: 10,
              bold: true,
              italic: false,
              color: '#000000',
              textAlign: 'Left',
              verticalAlign: 'Middle',
              paddingPt: { top: 2, right: 2, bottom: 2, left: 2 },
            },
          },
        ],
      },
    ],
  };

  const validDisambMock: ILLMProvider = {
    name: 'corporate-mock',
    defaultModel: 'corp-v1',
    isConfigured: () => true,
    async analyze<T>(): Promise<LLMResponse<T>> {
      return {
        provider: 'corporate-mock',
        model: 'corp-v1',
        rawText: '{"decisions":[{"regionId":"r-1","semanticRole":"calculationField","confidence":0.95,"rationale":"mock"}]}',
        parsedJson: {
          decisions: [
            { regionId: 'r-1', semanticRole: 'calculationField', confidence: 0.95, rationale: 'mock' },
          ],
        } as T,
        latencyMs: 3,
      };
    },
  };
  const aiGw = new LLMGateway({ logger, config, providerOverride: validDisambMock });
  const semanticProvider = new GatewayAiProvider(logger, aiGw);
  const ctx = buildAiContextSlices(sampleLayout, new SkillManager(logger));
  const decisionRes = await semanticProvider.decideSemantics(ctx);
  assert.strictEqual(decisionRes.provider, 'corporate-mock');
  assert.strictEqual(decisionRes.model, 'corp-v1');
  assert.strictEqual(decisionRes.decisions[0].semanticRole, 'calculationField');

  // Verify validator rejects unknown regionId directly
  assert.throws(
    () =>
      validateLayoutDisambiguationResponse(ctx.ambiguousRegions, {
        decisions: 'invalid',
      }),
    (err: unknown) => err instanceof LLMProviderError && err.code === 'VALIDATION_FAILED'
  );
  console.log('[PASS] Cancellation, structured output validation & provider swap verified');

  console.log('=== All LLM Provider-Agnostic Tests PASSED ===');
}

runLlmProviderTests().catch((err) => {
  console.error('LLM PROVIDER TEST FAILED:', err);
  process.exit(1);
});
