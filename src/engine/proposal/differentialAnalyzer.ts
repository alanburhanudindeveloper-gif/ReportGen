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
  if (confidence >= config.validation.confidenceTiers.high) return 'HIGH';
  if (confidence >= config.validation.confidenceTiers.medium) return 'MEDIUM';
  return 'LOW';
}

export class DifferentialAnalyzer {
  private readonly logger: StructuredLogger;
  private readonly skillManager: SkillManager;
  private readonly config: ReportGenConfig;

  constructor(
    logger: StructuredLogger,
    skillManager: SkillManager,
    config: ReportGenConfig
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
  }): Promise<{ changes: ModificationChange[]; usedSkills: string[]; analysisMode: 'deterministic' }> {
    const skills = this.skillManager.retrieveRelevantSkills({
      taskType: 'proposal-adaptation',
      hasFinancialTerms: true,
      hasExistingProject: true,
      hasComplexGraphics: false,
      keywords: [input.productCode, input.benchmark.productCode],
    });

    const deterministic = this.buildDeterministicDiff(input);

    this.logger.info('DifferentialAnalyzer', 'Completed deterministic differential analysis', {
      changes: deterministic.length,
      requiresReview: deterministic.filter((c) => c.requiresReview).length,
    });

    return {
      changes: deterministic,
      usedSkills: skills.map((s) => s.name),
      analysisMode: 'deterministic',
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

    const pdfHeadingsAndSections = input.pdfA.layoutModel.pages.flatMap((p) =>
      p.regions.filter(
        (r) =>
          r.type === 'text' &&
          r.text &&
          (r.style.bold ||
            r.semanticRole === 'sectionHeading' ||
            r.semanticRole === 'tableHeader' ||
            /summary|schedule|illustration|rider|disclaimer|benefit|cover/i.test(r.text))
      )
    );

    const uniqueTargets = new Map<string, (typeof pdfHeadingsAndSections)[number]>();
    for (const reg of pdfHeadingsAndSections) {
      const cleaned = reg.text!.trim().slice(0, 60);
      const key = normalizeToken(cleaned);
      if (key.length >= 4 && !uniqueTargets.has(key)) {
        uniqueTargets.set(key, reg);
      }
    }

    for (const reg of uniqueTargets.values()) {
      const label = reg.text!.trim();
      const normLabel = normalizeToken(label);

      const exactBench = input.benchmark.elements.find(
        (el) => normalizeToken(el.labelHint) === normLabel || normLabel.includes(normalizeToken(el.labelHint))
      );

      if (exactBench) {
        matchedBenchmarkElements.add(exactBench.symbolName);
        const confidence = 0.94;
        const tier = resolveTier(confidence, this.config);
        changes.push({
          changeId: `CHG-${String(seq++).padStart(4, '0')}`,
          decision: 'MODIFY',
          confidence,
          tier,
          requiresReview: tier !== 'HIGH',
          benchmarkElement: exactBench.symbolName,
          targetElement: label,
          targetPdfRegion: {
            pdf: 'PDF_A',
            page: reg.pageNumber,
            bbox: { x: reg.x, y: reg.y, width: reg.width, height: reg.height },
          },
          reason: `Matched benchmark method ${exactBench.symbolName}; adapt labels, bindings, and Tablix columns to match PDF A.`,
          changes: [
            `Adapt ${exactBench.symbolName} for ${input.productCode}`,
            `Bind dynamic fields to ${input.productCode}ProposalDataSet`,
          ],
          generatedFile: `${input.productCode}ProposalElement.vb`,
          generatedSymbol: exactBench.symbolName,
        });
        continue;
      }

      const partialBench = input.benchmark.elements.find((el) => {
        const words = el.labelHint.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
        return words.some((w) => label.toLowerCase().includes(w));
      });

      if (partialBench && !matchedBenchmarkElements.has(partialBench.symbolName)) {
        matchedBenchmarkElements.add(partialBench.symbolName);
        const confidence = 0.78;
        const tier = resolveTier(confidence, this.config);
        changes.push({
          changeId: `CHG-${String(seq++).padStart(4, '0')}`,
          decision: 'RENAME',
          confidence,
          tier,
          requiresReview: tier !== 'HIGH',
          benchmarkElement: partialBench.symbolName,
          targetElement: label,
          targetPdfRegion: {
            pdf: 'PDF_A',
            page: reg.pageNumber,
            bbox: { x: reg.x, y: reg.y, width: reg.width, height: reg.height },
          },
          reason: `Partial match to benchmark symbol ${partialBench.symbolName}; verify section mapping and visibility rules.`,
          changes: [`Adapt and rename ${partialBench.symbolName} section content for "${label}"`],
          generatedFile: `${input.productCode}ProposalElement.vb`,
          generatedSymbol: `Build${label.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}Element`,
        });
      } else {
        const cleanSym = `Build${label.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'Section'}Element`;
        const confidence = 0.84;
        const tier = resolveTier(confidence, this.config);
        changes.push({
          changeId: `CHG-${String(seq++).padStart(4, '0')}`,
          decision: 'ADD',
          confidence,
          tier,
          requiresReview: tier !== 'HIGH',
          targetElement: label,
          targetPdfRegion: {
            pdf: 'PDF_A',
            page: reg.pageNumber,
            bbox: { x: reg.x, y: reg.y, width: reg.width, height: reg.height },
          },
          reason: `New section "${label}" detected in PDF A with no equivalent in benchmark ${input.benchmark.productCode}.`,
          changes: [
            `Add ${cleanSym} in ${input.productCode}ProposalElement.vb`,
            `Add corresponding Tablix band in ${input.productCode}ProposalLayout.rdlc`,
          ],
          generatedFile: `${input.productCode}ProposalElement.vb`,
          generatedSymbol: cleanSym,
        });
      }
    }

    for (const f of (input.referenceExtract?.fields ?? []).filter((x) => x.isStatusField)) {
      const confidence = f.confidence;
      const tier = resolveTier(confidence, this.config);
      changes.push({
        changeId: `CHG-${String(seq++).padStart(4, '0')}`,
        decision: 'MODIFY',
        confidence,
        tier,
        requiresReview: tier !== 'HIGH',
        targetElement: `${f.label} (${f.value})`,
        sourcePdfRegion: {
          pdf: 'PDF_B',
          page: f.traceability.page,
          bbox: f.traceability.bbox,
        },
        reason: `Status field "${f.field}" extracted from PDF B with candidate states [${(f.candidateStates ?? []).join(', ')}].`,
        changes: [
          `Add DataSet field ${f.field} and status expression binding`,
          `Emit ProductEngine mock binding marker for ${f.field}`,
        ],
        generatedFile: `${input.productCode}ProposalBuilder.vb`,
        generatedSymbol: `Map${f.field}Status`,
      });
    }

    for (const el of input.benchmark.elements) {
      if (!matchedBenchmarkElements.has(el.symbolName)) {
        const confidence = 0.66;
        const tier = resolveTier(confidence, this.config);
        changes.push({
          changeId: `CHG-${String(seq++).padStart(4, '0')}`,
          decision: 'REMOVE',
          confidence,
          tier,
          requiresReview: tier !== 'HIGH',
          benchmarkElement: el.symbolName,
          targetElement: el.labelHint || el.symbolName,
          reason: `Benchmark element ${el.symbolName} was not detected in PDF A; verify whether section is deprecated for ${input.productCode}.`,
          changes: [`Omit ${el.symbolName} call from ${input.productCode}ProposalBuilder.vb`],
          generatedFile: `${input.productCode}ProposalBuilder.vb`,
          generatedSymbol: el.symbolName,
        });
      }
    }

    return changes;
  }
}
