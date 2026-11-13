import { ReportGenConfig } from '../core/config.ts';
import { ReportDefinition, StructuredLogger } from '../core/types.ts';
import { RdlcValidator } from '../rdlc/rdlcValidator.ts';
import { ReportViewerRenderer, VisualDiffEngine } from '../testing/visualDiff.ts';
import { MinimalMutationPatcher } from './minimalMutationPatcher.ts';
import { ProposalRdlcGenerator } from './proposalRdlcGenerator.ts';
import { ProposalVbGenerator } from './proposalVbGenerator.ts';
import {
  BenchmarkAnalysis,
  MinimalMutationDiffItem,
  MinimalMutationReport,
  ProposalDefinition,
  ReportTestHarnessResult,
  TemplateAnalysis,
  TestCheckResult,
} from './types.ts';

export class ReportTestHarness {
  private readonly logger: StructuredLogger;
  private readonly validator: RdlcValidator;
  private readonly renderer: ReportViewerRenderer;
  private readonly visualDiff: VisualDiffEngine;
  private readonly config: ReportGenConfig;

  constructor(logger: StructuredLogger, config: ReportGenConfig) {
    this.logger = logger;
    this.validator = new RdlcValidator(logger);
    this.renderer = new ReportViewerRenderer(logger);
    this.visualDiff = new VisualDiffEngine(logger);
    this.config = config;
  }

  public async runWithDiagnosis(input: {
    definition: ProposalDefinition;
    benchmark: BenchmarkAnalysis;
    pdfA: TemplateAnalysis;
    pdfABytes: Uint8Array;
    pdfBBytes?: Uint8Array;
    initialBuilderVb: string;
    initialElementVb: string;
    initialRdlcXml: string;
    initialAdditionalRdlcFiles?: Array<{ fileName: string; xml: string }>;
    initialDiffItems?: MinimalMutationDiffItem[];
  }): Promise<{
    harnessResult: ReportTestHarnessResult;
    definition: ProposalDefinition;
    builderVbCode: string;
    elementVbCode: string;
    rdlcXml: string;
    additionalRdlcFiles: Array<{ fileName: string; xml: string }>;
    diffReport: MinimalMutationReport;
    reportDefinition?: ReportDefinition;
  }> {
    let currentDef = JSON.parse(JSON.stringify(input.definition)) as ProposalDefinition;
    let builderVb = input.initialBuilderVb;
    let elementVb = input.initialElementVb;
    let rdlcXml = input.initialRdlcXml;
    let additionalRdlcFiles = input.initialAdditionalRdlcFiles ?? [];
    let diffItems = input.initialDiffItems ?? [];
    let reportDef: ReportDefinition | undefined;

    const patcher = new MinimalMutationPatcher(this.logger);
    const diagnosisHistory: ReportTestHarnessResult['diagnosisHistory'] = [];
    const maxRetries = Math.max(1, this.config.validation.maxDiagnosisRetries);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const checkOut = await this.evaluateOnce({
        definition: currentDef,
        benchmark: input.benchmark,
        pdfA: input.pdfA,
        pdfABytes: input.pdfABytes,
        pdfBBytes: input.pdfBBytes,
        builderVb,
        elementVb,
        rdlcXml,
        additionalRdlcFiles,
        diagnosisHistory,
      });

      if (checkOut.fatalErrors.length === 0 || attempt === maxRetries) {
        return {
          harnessResult: checkOut,
          definition: currentDef,
          builderVbCode: builderVb,
          elementVbCode: elementVb,
          rdlcXml,
          additionalRdlcFiles,
          diffReport: patcher.buildDiffReport(diffItems),
          reportDefinition: reportDef,
        };
      }

      // Bounded DiagnosisAgent repair loop
      const issue = checkOut.fatalErrors[0];
      let actionTaken = 'Re-synchronized RDLC 2008 DataSet fields and Tablix cell expressions.';

      const missingFieldMatch = issue.match(/undefined DataSet field "([A-Za-z0-9_]+)"/i);
      if (missingFieldMatch) {
        const missingName = missingFieldMatch[1];
        currentDef.dataBindings.push({
          field: missingName,
          dataType: 'System.String',
          mode: 'DummyData',
          dummyValue: `${currentDef.productCode}-AUTO`,
          productionSource: `ProductEngine.Resolve${missingName}("${currentDef.productCode}", "${currentDef.planCode}")`,
          isStatusField: false,
          confidence: 0.75,
          confirmed: false,
        });
        actionTaken = `Added missing DataSet field "${missingName}" to ProposalDefinition and patched VB/RDLC 2008.`;
      }

      const vbGen = new ProposalVbGenerator(this.logger);
      const vbOut = vbGen.generate(currentDef, input.benchmark);
      builderVb = vbOut.builderVbCode;
      elementVb = vbOut.elementVbCode;

      const rdlcGen = new ProposalRdlcGenerator(this.logger);
      const rdlcOut = rdlcGen.generate(currentDef, input.pdfA.layoutModel, input.benchmark);
      rdlcXml = rdlcOut.rdlcXml;
      additionalRdlcFiles = rdlcOut.additionalRdlcFiles;
      reportDef = rdlcOut.reportDefinition;
      diffItems = [...vbOut.diffItems, ...rdlcOut.diffItems];

      const recheck = this.validator.validate(rdlcXml, { requireRdlc2008: true });
      diagnosisHistory.push({
        attempt,
        issue,
        actionTaken,
        resolved: recheck.valid,
      });

      this.logger.warn('DiagnosisAgent', `Repair attempt ${attempt}/${maxRetries}`, {
        issue,
        actionTaken,
        resolved: recheck.valid,
      });
    }

    throw new Error('Unexpected diagnosis loop termination');
  }

  private async evaluateOnce(input: {
    definition: ProposalDefinition;
    benchmark: BenchmarkAnalysis;
    pdfA: TemplateAnalysis;
    pdfABytes: Uint8Array;
    pdfBBytes?: Uint8Array;
    builderVb: string;
    elementVb: string;
    rdlcXml: string;
    additionalRdlcFiles: Array<{ fileName: string; xml: string }>;
    diagnosisHistory: ReportTestHarnessResult['diagnosisHistory'];
  }): Promise<ReportTestHarnessResult> {
    const checks: TestCheckResult[] = [];
    const warnings: string[] = [];
    const fatalErrors: string[] = [];

    // 1. VB.NET Logic Checks
    const hasBuilderClass = new RegExp(`Class\\s+${input.definition.productCode}ProposalBuilder\\b`, 'i').test(
      input.builderVb
    );
    const hasElementClass = new RegExp(`Class\\s+${input.definition.productCode}ProposalElement\\b`, 'i').test(
      input.elementVb
    );
    const hasRefTable = /Function\s+BuildReferenceDataTable\b/i.test(input.builderVb);
    const hasLeakedBenchClass =
      input.definition.productCode !== input.benchmark.productCode &&
      new RegExp(`Class\\s+${input.benchmark.productCode}Proposal(Builder|Element)\\b`, 'i').test(
        `${input.builderVb}\n${input.elementVb}`
      );
    const requiresReviewCount = input.definition.changes.filter(
      (c) => c.decision === 'REQUIRES_REVIEW'
    ).length;

    const vbPassCount = [hasBuilderClass, hasElementClass, hasRefTable, !hasLeakedBenchClass].filter(Boolean).length;
    if (vbPassCount < 4) {
      fatalErrors.push(
        `VB logic symbol check failed (Builder=${hasBuilderClass}, Element=${hasElementClass}, RefTable=${hasRefTable}, CleanNamespace=${!hasLeakedBenchClass}).`
      );
    }
    if (requiresReviewCount > 0) {
      warnings.push(
        `${requiresReviewCount} change(s) marked REQUIRES_REVIEW because unsafe automatic VB mutation was halted.`
      );
    }
    checks.push({
      category: 'VB_LOGIC',
      label: 'VB.NET Builder & Element Symbol Integrity',
      status: vbPassCount < 4 ? 'FAIL' : requiresReviewCount > 0 ? 'WARN' : 'PASS',
      details: `${vbPassCount}/4 checks passed for ${input.definition.productCode}ProposalBuilder & Element (${requiresReviewCount} REQUIRES_REVIEW).`,
      assertionsPassed: vbPassCount,
      assertionsTotal: 4,
    });

    // 2. Data Binding & Multi-Scenario Tests
    const unconfirmedFields = input.definition.dataBindings.filter((b) => !b.confirmed);
    const missingMockMarkers = input.definition.dataBindings.filter(
      (b) => b.mode !== 'RealProductEngine' && !input.builderVb.includes(`row("${b.field}")`)
    );
    const scenarioCount = input.definition.sampleScenarios?.length ?? 0;
    const bindingTotal = input.definition.dataBindings.length;
    const bindingPassed = bindingTotal - missingMockMarkers.length;

    if (missingMockMarkers.length > 0) {
      fatalErrors.push(
        `Data binding mismatch: missing VB row assignments for ${missingMockMarkers.map((m) => m.field).join(', ')}`
      );
    }
    if (unconfirmedFields.length > 0) {
      warnings.push(
        `${unconfirmedFields.length} extracted/auto-added binding(s) remain UNCERTAIN or unconfirmed: ${unconfirmedFields
          .map((u) => u.field)
          .join(', ')}`
      );
    }
    checks.push({
      category: 'DATA_BINDING',
      label: 'DataSet Fields, Parameters & 6 Sample Scenarios',
      status: missingMockMarkers.length > 0 ? 'FAIL' : unconfirmedFields.length > 0 ? 'WARN' : 'PASS',
      details: `${bindingPassed}/${bindingTotal} bindings wired; ${scenarioCount} stress scenario(s) prepared; ${unconfirmedFields.length} require manual confirmation.`,
      assertionsPassed: bindingPassed,
      assertionsTotal: bindingTotal,
    });

    // 3. RDLC 2008 Structural Validation across primary & additional RDLC files
    const rdlcValidation = this.validator.validate(input.rdlcXml, { requireRdlc2008: true });
    for (const err of rdlcValidation.errors) {
      fatalErrors.push(`${err.ruleId}: ${err.message}`);
    }
    for (const w of rdlcValidation.warnings) {
      warnings.push(`${w.ruleId}: ${w.message}`);
    }
    for (const extra of input.additionalRdlcFiles) {
      const extraVal = this.validator.validate(extra.xml, { requireRdlc2008: true });
      for (const err of extraVal.errors) {
        fatalErrors.push(`${extra.fileName} (${err.ruleId}): ${err.message}`);
      }
      for (const w of extraVal.warnings) {
        warnings.push(`${extra.fileName} (${w.ruleId}): ${w.message}`);
      }
    }

    const totalRdlcCount = 1 + input.additionalRdlcFiles.length;
    checks.push({
      category: 'RDLC_STRUCTURE',
      label: `RDLC 2008 XML & Tablix Validation (${totalRdlcCount} file(s))`,
      status:
        fatalErrors.some((e) => e.includes('RDLC-'))
          ? 'FAIL'
          : rdlcValidation.warnings.length > 0
          ? 'WARN'
          : 'PASS',
      details:
        !fatalErrors.some((e) => e.includes('RDLC-'))
          ? `Strict RDLC 2008 & 10-point Tablix rules passed across ${totalRdlcCount} RDLC file(s).`
          : `${rdlcValidation.errors.length} RDLC 2008 validation error(s) detected.`,
      assertionsPassed: !fatalErrors.some((e) => e.includes('RDLC-')) ? 10 : Math.max(0, 10 - rdlcValidation.errors.length),
      assertionsTotal: 10,
    });

    // 4. RDLC Rendering Check (Strict honesty rule - never fabricate rendered PDF)
    const renderStatus = await this.renderer.renderToPdf(input.rdlcXml);
    if (renderStatus.status === 'NOT_VERIFIED_IN_ENVIRONMENT') {
      warnings.push(renderStatus.message);
    }
    checks.push({
      category: 'RDLC_RENDERING',
      label: 'ReportViewer LocalReport Execution',
      status: renderStatus.executed ? 'PASS' : 'NOT_VERIFIED_IN_ENVIRONMENT',
      details: renderStatus.message,
      assertionsPassed: renderStatus.executed ? 1 : 0,
      assertionsTotal: 1,
    });

    // 5. Visual Regression Checks
    let visualDiff;
    if (input.pdfBBytes && input.pdfBBytes.length > 0) {
      visualDiff = await this.visualDiff.comparePdfs(
        input.pdfABytes,
        input.pdfBBytes,
        this.config.validation.visualSimilarityTarget
      );
      const dimMatch =
        Math.abs(input.pdfA.pages[0].widthIn - input.definition.layoutPageSettings.pageWidthIn) < 0.05 &&
        Math.abs(input.pdfA.pages[0].heightIn - input.definition.layoutPageSettings.pageHeightIn) < 0.05;
      checks.push({
        category: 'VISUAL_REGRESSION',
        label: 'Template (PDF A) vs Reference (PDF B) Structural & Pixel Comparison',
        status: visualDiff.available && dimMatch ? (visualDiff.overallSimilarity >= 0.7 ? 'PASS' : 'WARN') : 'WARN',
        details: visualDiff.available
          ? `PDF A vs PDF B Ghostscript similarity: ${(visualDiff.overallSimilarity * 100).toFixed(2)}% across ${visualDiff.pages.length} page(s). RDLC output render not executed in this environment.`
          : 'Ghostscript comparison unavailable; verified page dimensions against PDF A.',
        assertionsPassed: dimMatch ? 1 : 0,
        assertionsTotal: 1,
      });
    } else {
      checks.push({
        category: 'VISUAL_REGRESSION',
        label: 'Template Geometry & Page Dimension Fidelity',
        status: 'WARN',
        details: 'Page dimensions anchored to PDF A; supply PDF B and run ReportViewer on Windows for full visual diff.',
        assertionsPassed: 1,
        assertionsTotal: 1,
      });
    }

    const overallStatus: ReportTestHarnessResult['overallStatus'] =
      fatalErrors.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS';

    return {
      overallStatus,
      executedAt: new Date().toISOString(),
      checks,
      warnings,
      fatalErrors,
      rdlcValidation,
      renderStatus,
      visualDiff,
      diagnosisHistory: input.diagnosisHistory,
    };
  }
}
