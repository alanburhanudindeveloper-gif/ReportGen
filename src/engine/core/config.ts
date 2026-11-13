import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { ReportGenError, ReportGenErrorCode } from './types.ts';

export interface ReportGenConfig {
  project: {
    name: string;
    outputPath: string;
  };
  pdf: {
    coordinateTolerance: number;
    imageFallback: boolean;
    dpi: number;
  };
  ai: {
    enabled: boolean;
    provider: string;
    model: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    temperature?: number;
    confidenceThreshold: number;
    confidenceTiers: {
      high: number;
      medium: number;
    };
  };
  validation: {
    visualSimilarityTarget: number;
    maxAgentIterations: number;
    maxDiagnosisRetries: number;
    requirePassingLogicTests: boolean;
  };
  security: {
    allowedInputDirs: string[];
    allowedOutputDirs: string[];
    allowedExtensions: string[];
  };
}

const DEFAULT_CONFIG: ReportGenConfig = {
  project: {
    name: 'MyERP',
    outputPath: 'output',
  },
  pdf: {
    coordinateTolerance: 0.04,
    imageFallback: true,
    dpi: 144,
  },
  ai: {
    enabled: true,
    provider: 'none',
    model: 'deterministic-only',
    timeoutMs: 25000,
    maxRetries: 1,
    confidenceThreshold: 0.85,
    confidenceTiers: {
      high: 0.9,
      medium: 0.7,
    },
  },
  validation: {
    visualSimilarityTarget: 0.95,
    maxAgentIterations: 3,
    maxDiagnosisRetries: 3,
    requirePassingLogicTests: true,
  },
  security: {
    allowedInputDirs: ['samples', 'uploads', 'tmp', 'output'],
    allowedOutputDirs: ['output', 'samples', 'tmp'],
    allowedExtensions: ['.pdf', '.rdlc', '.vb', '.xlsx', '.json', '.vbproj', '.csproj'],
  },
};

export function loadConfig(workspaceRoot = process.cwd()): ReportGenConfig {
  const configPath = path.join(workspaceRoot, 'reportgen.config.yaml');
  const parsed = fs.existsSync(configPath)
    ? ((yaml.load(fs.readFileSync(configPath, 'utf-8')) ?? {}) as Partial<ReportGenConfig>)
    : {};

  const envProvider = process.env.LLM_PROVIDER?.trim();
  const envModel = process.env.LLM_MODEL?.trim();
  const envBaseUrl = process.env.LLM_BASE_URL?.trim();
  const envEnabled =
    process.env.LLM_ENABLED !== undefined
      ? process.env.LLM_ENABLED.toLowerCase() !== 'false'
      : undefined;
  const envTimeout = process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : undefined;
  const envRetries = process.env.LLM_MAX_RETRIES ? Number(process.env.LLM_MAX_RETRIES) : undefined;
  const envTemp = process.env.LLM_TEMPERATURE ? Number(process.env.LLM_TEMPERATURE) : undefined;

  return {
    project: { ...DEFAULT_CONFIG.project, ...parsed.project },
    pdf: { ...DEFAULT_CONFIG.pdf, ...parsed.pdf },
    ai: {
      ...DEFAULT_CONFIG.ai,
      ...parsed.ai,
      ...(envProvider ? { provider: envProvider } : {}),
      ...(envModel ? { model: envModel } : {}),
      ...(envBaseUrl ? { baseUrl: envBaseUrl } : {}),
      ...(envEnabled !== undefined ? { enabled: envEnabled } : {}),
      ...(envTimeout && !Number.isNaN(envTimeout) ? { timeoutMs: envTimeout } : {}),
      ...(envRetries !== undefined && !Number.isNaN(envRetries) ? { maxRetries: envRetries } : {}),
      ...(envTemp !== undefined && !Number.isNaN(envTemp) ? { temperature: envTemp } : {}),
      confidenceTiers: {
        ...DEFAULT_CONFIG.ai.confidenceTiers,
        ...parsed.ai?.confidenceTiers,
      },
    },
    validation: { ...DEFAULT_CONFIG.validation, ...parsed.validation },
    security: { ...DEFAULT_CONFIG.security, ...parsed.security },
  };
}

export function assertAllowedExtension(filePath: string, config: ReportGenConfig): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!config.security.allowedExtensions.includes(ext)) {
    throw new ReportGenError(
      ReportGenErrorCode.SECURITY_VIOLATION,
      `Disallowed file extension "${ext}" for ${path.basename(filePath)}`
    );
  }
}

export function resolveSafeSubpath(baseDir: string, relativeTarget: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativeTarget);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new ReportGenError(
      ReportGenErrorCode.SECURITY_VIOLATION,
      `Path traversal detected: "${relativeTarget}" escapes base "${resolvedBase}"`
    );
  }
  return resolvedTarget;
}
