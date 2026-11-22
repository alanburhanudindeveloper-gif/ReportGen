import { ReportGenConfig } from '../core/config.ts';
import { StructuredLogger } from '../core/types.ts';
import { SkillManager } from '../skills/skillManager.ts';
import {
  BenchmarkAnalysis,
  ConfidenceTier,
  ModificationChange,
  ReferenceDataExtract,
  TemplateAnalysis,
} from './types.ts';

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveTier(confidence: number, config: ReportGenConfig): ConfidenceTier {
  if (confidence >= config.ai.confidenceTiers.high) return 'HIGH';
  if (confidence >= config.ai.confidenceTiers.medium) return 'MEDIUM';
  return 'LOW';
}

/** Deterministic PDF-to-benchmark structural comparison for proposal adaptation. */
export class DifferentialAnalyzer {
  private readonly logger: StructuredLogger;
  private readonly skillManager: SkillManager;
  private readonly config: ReportGenConfig;

  // Legacy parameters are accepted temporarily for callers compiled against the old API,
  // but are deliberately ignored and never used to make external requests.
  constructor(
    logger: StructuredLogger,
    skillManager: SkillManager,
    config: ReportGenConfig,
    _legacyProvider?: unknown
  ) {
    this.logger = logger;
    this.skillManager = skillManager;
    this.config = config;
  }

  public async analyze(input: {
    productCode: string;
    pdfA: TemplateAnalysis;
    benchmark: BenchmarkAnalysis;
    referenceExtract?: ReferenceDataExtract;
    useAi?: boolean;
  }): Promise<{ changes: ModificationChange[]; usedSkills: string[]; aiProvider: string }> {
    const skills = this.skillManager.retrieveRelevantSkills({
      taskType: 'proposal-adaptation',
      hasFinancialTerms: true,
      hasExistingProject: true,
      hasComplexGraphics: false,
      keywords: [input.productCode, input.benchmark.productCode],
    });
    const changes = this.buildDeterministicDiff(input);
    this.logger.info('DifferentialAnalyzer', 'Completed deterministic differential analysis', {
      changes: changes.length,
      requiresReview: changes.filter((change) => change.requiresReview).length,
    });
    return {
      changes,
      usedSkills: skills.map((skill) => skill.name),
      aiProvider: 'deterministic-only',
    };
  }

  private buildDeterministicDiff(input: {
    productCode: string;
    pdfA: TemplateAnalysis;
    benchmark: BenchmarkAnalysis;
    referenceExtract?: ReferenceDataExtract;
  }): ModificationChange[] {
    const changes: ModificationChange[] = [];
    const matchedBenchmarkElements = new Set<string>();
    let seq = 1;
    const headings = input.pdfA.layoutModel.pages.flatMap((page) =>
      page.regions.filter(
        (region) =>
          region.type === 'text' &&
          region.text &&
          (region.style.bold ||
            region.semanticRole === 'sectionHeading' ||
            region.semanticRole === 'tableHeader' ||
            /summary|schedule|illustration|rider|disclaimer|benefit|cover/i.test(region.text))
      )
    );
    const uniqueTargets = new Map<string, (typeof headings)[number]>();
    for (const region of headings) {
      const label = region.text!.trim().slice(0, 60);
      const key = normalizeToken(label);
      if (key.length >= 4 && !uniqueTargets.has(key)) uniqueTargets.set(key, region);
    }

    for (const region of uniqueTargets.values()) {
      const label = region.text!.trim();
      const normalizedLabel = normalizeToken(label);
      const exact = input.benchmark.elements.find((element) => {
        const elementLabel = normalizeToken(element.labelHint);
        return elementLabel && (elementLabel === normalizedLabel || normalizedLabel.includes(elementLabel));
      });
      if (exact) {
        matchedBenchmarkElements.add(exact.symbolName);
        const confidence = 0.94;
        changes.push({
          changeId: `CHG-${String(seq++).padStart(4, '0')}`,
          decision: 'MODIFY', confidence, tier: resolveTier(confidence, this.config),
          requiresReview: resolveTier(confidence, this.config) !== 'HIGH',
          benchmarkElement: exact.symbolName, targetElement: label,
          targetPdfRegion: { pdf: 'PDF_A', page: region.pageNumber, bbox: { x: region.x, y: region.y, width: region.width, height: region.height } },
          reason: `Matched benchmark method ${exact.symbolName}; adapt labels, bindings, and Tablix columns to match PDF A.`,
          changes: [`Adapt ${exact.symbolName} for ${input.productCode}`, `Bind dynamic fields to ${input.productCode}ProposalDataSet`],
          generatedFile: `${input.productCode}ProposalElement.vb`, generatedSymbol: exact.symbolName,
        });
        continue;
      }

      const labelWords = new Set(label.toLowerCase().split(/\s+/).filter((word) => word.length >= 4));
      const partial = input.benchmark.elements.find((element) =>
        element.labelHint.toLowerCase().split(/\s+/).some((word) => word.length >= 4 && labelWords.has(word))
      );
      if (partial && !matchedBenchmarkElements.has(partial.symbolName)) {
        matchedBenchmarkElements.add(partial.symbolName);
        const confidence = 0.78;
        const tier = resolveTier(confidence, this.config);
        changes.push({
          changeId: `CHG-${String(seq++).padStart(4, '0')}`,
          decision: 'RENAME', confidence, tier, requiresReview: tier !== 'HIGH',
          benchmarkElement: partial.symbolName, targetElement: label,
          targetPdfRegion: { pdf: 'PDF_A', page: region.pageNumber, bbox: { x: region.x, y: region.y, width: region.width, height: region.height } },
          reason: `Partial match to benchmark symbol ${partial.symbolName}; verify section mapping and visibility rules.`,
          changes: [`Adapt and rename ${partial.symbolName} section content for "${label}"`],
          generatedFile: `${input.productCode}ProposalElement.vb`,
          generatedSymbol: `Build${label.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}Element`,
        });
      } else {
        const symbol = `Build${label.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'Section'}Element`;
        const confidence = 0.84;
        const tier = resolveTier(confidence, this.config);
        changes.push({
          changeId: `CHG-${String(seq++).padStart(4, '0')}`,
          decision: 'ADD', confidence, tier, requiresReview: tier !== 'HIGH', targetElement: label,
          targetPdfRegion: { pdf: 'PDF_A', page: region.pageNumber, bbox: { x: region.x, y: region.y, width: region.width, height: region.height } },
          reason: `New section "${label}" detected in PDF A with no equivalent in benchmark ${input.benchmark.productCode}.`,
          changes: [`Add ${symbol} in ${input.productCode}ProposalElement.vb`, `Add corresponding Tablix band in ${input.productCode}ProposalLayout.rdlc`],
          generatedFile: `${input.productCode}ProposalElement.vb`, generatedSymbol: symbol,
        });
      }
    }

    for (const field of (input.referenceExtract?.fields ?? []).filter((item) => item.isStatusField)) {
      const tier = resolveTier(field.confidence, this.config);
      changes.push({
        changeId: `CHG-${String(seq++).padStart(4, '0')}`,
        decision: 'MODIFY', confidence: field.confidence, tier, requiresReview: tier !== 'HIGH',
        targetElement: `${field.label} (${field.value})`,
        sourcePdfRegion: { pdf: 'PDF_B', page: field.traceability.page, bbox: field.traceability.bbox },
        reason: `Status field "${field.field}" extracted from PDF B with candidate states [${(field.candidateStates ?? []).join(', ')}].`,
        changes: [`Add DataSet field ${field.field} and status expression binding`, `Emit ProductEngine mock binding marker for ${field.field}`],
        generatedFile: `${input.productCode}ProposalBuilder.vb`, generatedSymbol: `Map${field.field}Status`,
      });
    }

    for (const element of input.benchmark.elements) {
      if (matchedBenchmarkElements.has(element.symbolName)) continue;
      const confidence = 0.66;
      const tier = resolveTier(confidence, this.config);
      changes.push({
        changeId: `CHG-${String(seq++).padStart(4, '0')}`,
        decision: 'REMOVE', confidence, tier, requiresReview: tier !== 'HIGH',
        benchmarkElement: element.symbolName, targetElement: element.labelHint || element.symbolName,
        reason: `Benchmark element ${element.symbolName} was not detected in PDF A; verify whether section is deprecated for ${input.productCode}.`,
        changes: [`Omit ${element.symbolName} call from ${input.productCode}ProposalBuilder.vb`],
        generatedFile: `${input.productCode}ProposalBuilder.vb`, generatedSymbol: element.symbolName,
      });
    }
    return changes;
  }
}
