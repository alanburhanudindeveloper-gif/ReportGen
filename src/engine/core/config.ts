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
    provider: 'gemini',
    model: 'gemini-3.8-flash',
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
  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = (yaml.load(raw) ?? {}) as Partial<ReportGenConfig>;
  return {
    project: { ...DEFAULT_CONFIG.project, ...parsed.project },
    pdf: { ...DEFAULT_CONFIG.pdf, ...parsed.pdf },
    ai: {
      ...DEFAULT_CONFIG.ai,
      ...parsed.ai,
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
