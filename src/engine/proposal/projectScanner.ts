import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { LLMGateway } from '../ai/llmGateway.ts';
import {
  BenchmarkRankingItem,
  buildBenchmarkRankingPrompt,
  validateBenchmarkRankingResponse,
} from '../ai/prompts.ts';
import { ReportGenConfig } from '../core/config.ts';
import { StructuredLogger } from '../core/types.ts';
import { ProjectStructureParser } from './projectStructureParser.ts';
import { ReportGenProjectScanner } from './reportGenProjectScanner.ts';
import {
  BenchmarkCandidate,
  DeterministicProductCatalog,
  IBenchmarkDiscovery,
  IReportGenProjectScanner,
  ParsedDotNetProject,
  ProductCatalogueEntry,
  ProjectScanResult,
  TemplateAnalysis,
} from './types.ts';

export { ProjectStructureParser, ReportGenProjectScanner };

export class ProjectScanner implements IReportGenProjectScanner {
  private readonly scanner: ReportGenProjectScanner;

  constructor(logger: StructuredLogger) {
    this.scanner = new ReportGenProjectScanner(logger);
  }

  public parseProjectStructures(projectRoot: string): ParsedDotNetProject[] {
    return this.scanner.parseProjectStructures(projectRoot);
  }

  public buildCatalog(projectRoot: string): DeterministicProductCatalog {
    return this.scanner.buildCatalog(projectRoot);
  }

  public scanProject(projectRoot: string): ProjectScanResult {
    return this.scanner.scanProject(projectRoot);
  }
}

export class DeterministicBenchmarkDiscovery implements IBenchmarkDiscovery {
  public async rankCandidates(
    products: ProductCatalogueEntry[],
    pdfA: TemplateAnalysis
  ): Promise<BenchmarkCandidate[]> {
    const pdfText = pdfA.layoutModel.pages
      .flatMap((p) => p.regions.map((r) => (r.text ?? '').toLowerCase()))
      .join(' ');

    const pdfTables = pdfA.pages.reduce((s, p) => s + p.tablesDetected, 0);

    return products
      .map((entry) => {
        const reasons: string[] = [];
        let score = 0.45;

        const completeness =
          [entry.builderPath, entry.elementPath, entry.layoutPath].filter(Boolean).length / 3;
        score += completeness * 0.25;
        reasons.push(`Pattern completeness ${(completeness * 100).toFixed(0)}%`);

        if ((entry.layoutPaths?.length ?? 0) > 1) {
          score += 0.05;
          reasons.push(`Multi-RDLC modular pattern (${entry.layoutPaths!.length} RDLCs)`);
        }

        if (entry.elementSymbols.length > 0) {
          score += Math.min(0.15, entry.elementSymbols.length * 0.03);
          reasons.push(`${entry.elementSymbols.length} AST element symbol(s) available`);
        }

        const candidateTerms = [
          entry.productCode.toLowerCase(),
          ...entry.elementSymbols.map((s) => s.replace(/^Build|Element$/gi, '').toLowerCase()),
          ...entry.parameters.map((p) => p.toLowerCase()),
        ];
        const overlapCount = candidateTerms.filter((term) => term.length >= 3 && pdfText.includes(term)).length;
        if (overlapCount > 0) {
          score += Math.min(0.12, overlapCount * 0.04);
          reasons.push(`${overlapCount} semantic term overlap(s) with PDF A template`);
        }

        if (pdfTables > 0 && entry.datasets.length > 0) {
          score += 0.05;
          reasons.push('Tabular DataSet bindings present for multi-column tables');
        }

        const clamped = Math.round(Math.min(0.99, score) * 1000) / 1000;
        return {
          productCode: entry.productCode,
          score: clamped,
          deterministicScore: clamped,
          semanticScore: clamped,
          strategy: 'Deterministic' as const,
          reasons,
        };
      })
      .sort((a, b) => b.score - a.score);
  }
}

export class HybridBenchmarkDiscovery implements IBenchmarkDiscovery {
  private readonly logger: StructuredLogger;
  private readonly gateway: LLMGateway;
  private readonly fallback = new DeterministicBenchmarkDiscovery();

  constructor(logger: StructuredLogger, config?: ReportGenConfig, gateway?: LLMGateway) {
    this.logger = logger;
    this.gateway = gateway ?? new LLMGateway({ logger, config });
  }

  public async rankCandidates(
    products: ProductCatalogueEntry[],
    pdfA: TemplateAnalysis
  ): Promise<BenchmarkCandidate[]> {
    const deterministic = await this.fallback.rankCandidates(products, pdfA);
    if (!this.gateway.isAvailable() || products.length <= 1) {
      return deterministic;
    }

    try {
      const sampleHeadings = pdfA.layoutModel.pages
        .flatMap((p) => p.regions.filter((r) => r.style.bold && r.text).map((r) => r.text!))
        .slice(0, 15);

      const request = buildBenchmarkRankingPrompt({
        pdfHeadings: sampleHeadings,
        pdfPageCount: pdfA.pageCount,
        candidates: products.map((p) => ({
          productCode: p.productCode,
          elementSymbols: p.elementSymbols,
          datasets: p.datasets,
          parameters: p.parameters,
          rdlcCount: p.layoutPaths?.length ?? (p.layoutPath ? 1 : 0),
        })),
      });

      const { validated } = await this.gateway.execute<BenchmarkRankingItem[]>(
        request,
        (parsed) => validateBenchmarkRankingResponse(parsed)
      );

      const map = new Map(validated.map((r) => [r.productCode.toUpperCase(), r]));
      return deterministic
        .map((d) => {
          const sem = map.get(d.productCode.toUpperCase());
          if (!sem) return d;
          const semanticScore = Math.max(0, Math.min(1, Number(sem.semanticScore) || d.deterministicScore));
          const combined = Math.round((d.deterministicScore * 0.6 + semanticScore * 0.4) * 1000) / 1000;
          return {
            ...d,
            score: combined,
            semanticScore,
            strategy: 'Hybrid' as const,
            reasons: [...d.reasons, `AI semantic fit: ${sem.reason}`],
          };
        })
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      this.logger.warn('BenchmarkDiscovery', 'LLM semantic ranking fell back to deterministic', {
        error: err instanceof Error ? err.message : String(err),
      });
      return deterministic;
    }
  }
}

export function computeProductFilesHash(entry: ProductCatalogueEntry): string {
  const hash = crypto.createHash('sha256');
  const files = Array.from(
    new Set([
      ...(entry.builderPath ? [entry.builderPath] : []),
      ...(entry.elementPaths ?? (entry.elementPath ? [entry.elementPath] : [])),
      ...(entry.layoutPaths ?? (entry.layoutPath ? [entry.layoutPath] : [])),
    ])
  ).sort();
  for (const file of files) {
    if (fs.existsSync(file)) {
      hash.update(path.basename(file));
      hash.update(fs.readFileSync(file));
    }
  }
  return hash.digest('hex').slice(0, 16);
}
