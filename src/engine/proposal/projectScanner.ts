import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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

/**
 * Ranks benchmark products using reproducible structural and text-overlap signals.
 * Scores are intentionally local and deterministic; this class performs no network calls.
 */
export class DeterministicBenchmarkDiscovery implements IBenchmarkDiscovery {
  public async rankCandidates(
    products: ProductCatalogueEntry[],
    pdfA: TemplateAnalysis
  ): Promise<BenchmarkCandidate[]> {
    const pdfText = pdfA.layoutModel.pages
      .flatMap((page) => page.regions.map((region) => (region.text ?? '').toLowerCase()))
      .join(' ');
    const pdfTables = pdfA.pages.reduce((sum, page) => sum + page.tablesDetected, 0);

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

        const terms = [
          entry.productCode.toLowerCase(),
          ...entry.elementSymbols.map((symbol) => symbol.replace(/^Build|Element$/gi, '').toLowerCase()),
          ...entry.parameters.map((parameter) => parameter.toLowerCase()),
        ].filter((term) => term.length >= 3);
        const overlapCount = terms.filter((term) => pdfText.includes(term)).length;
        if (overlapCount > 0) {
          score += Math.min(0.12, overlapCount * 0.04);
          reasons.push(`${overlapCount} text overlap(s) with PDF A template`);
        }
        if (pdfTables > 0 && entry.datasets.length > 0) {
          score += 0.05;
          reasons.push('Tabular DataSet bindings present for multi-column tables');
        }

        const roundedScore = Math.round(Math.min(0.99, score) * 1000) / 1000;
        return {
          productCode: entry.productCode,
          score: roundedScore,
          deterministicScore: roundedScore,
          semanticScore: roundedScore,
          strategy: 'Deterministic' as const,
          reasons,
        };
      })
      // A stable tie-break avoids filesystem/discovery order affecting selections.
      .sort((a, b) => b.score - a.score || a.productCode.localeCompare(b.productCode));
  }
}

/**
 * Kept under its existing exported name for source compatibility. Ranking is now
 * always deterministic; the extra constructor arguments are ignored so callers
 * can migrate independently without retaining a provider dependency here.
 */
export class HybridBenchmarkDiscovery extends DeterministicBenchmarkDiscovery {
  constructor(_logger: StructuredLogger, _config?: unknown, _legacyProvider?: unknown) {
    super();
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
