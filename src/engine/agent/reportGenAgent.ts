import crypto from 'crypto';
import {
  buildAiContextSlices,
  DeterministicFallbackAiProvider,
  GeminiAiProvider,
  IAiProvider,
  validateAiDecisions,
} from '../ai/aiProvider.ts';
import {
  AiDecisionResponse,
  ExistingProjectPattern,
  LogicTestCase,
  PipelineRunResult,
  StructuredLogger,
} from '../core/types.ts';
import { ReportGenServices } from '../mcp/mcpTools.ts';
import { RdlcValidator } from '../rdlc/rdlcValidator.ts';

export interface AgentRunInput {
  documentName: string;
  pdfBytes: Uint8Array;
  existingRdlcXml?: string;
  existingRdlcFileName?: string;
  existingVbSource?: string;
  existingVbFileName?: string;
  excelBytes?: Buffer;
  customJsonTestCases?: LogicTestCase[];
  comparisonPdfBytes?: Uint8Array;
  useAi?: boolean;
}

/**
 * Constrained Orchestrator Agent:
 * - Bounded maxAgentIterations
 * - Allowed tools strictly scoped to ReportGenServices
 * - Validation gates (RDLC 10-point validation + Logic test gate)
 * - Stop conditions on pass or max iterations
 */
export class ReportGenAgent {
  private readonly services: ReportGenServices;
  private readonly logger: StructuredLogger;

  constructor(services: ReportGenServices) {
    this.services = services;
    this.logger = services.logger;
  }

  public async execute(input: AgentRunInput): Promise<PipelineRunResult> {
    const runId = crypto.randomUUID().slice(0, 8);
    const { config } = this.services;

    // Step 1: Analyze PDF deterministically
    const rawLayout = await this.services.pdfAnalyzer.analyzeBuffer(
      input.pdfBytes,
      input.documentName,
      config.pdf.dpi
    );

    // Step 2: Inspect existing RDLC/VB project artifacts if provided
    let existingPattern: ExistingProjectPattern | undefined;
    if (input.existingRdlcXml || input.existingVbSource) {
      existingPattern = this.services.projectInspector.inspect({
        rdlcXml: input.existingRdlcXml,
        rdlcFileName: input.existingRdlcFileName,
        vbSource: input.existingVbSource,
        vbFileName: input.existingVbFileName,
      });
    }

    // Step 3: Reconstruct deterministic coordinate grids & bands
    const layoutModel = this.services.gridReconstructor.reconstruct(
      rawLayout,
      config.pdf.coordinateTolerance
    );

    // Step 4: AI reasoning ONLY on ambiguous regions using selective skills
    const aiEnabled = input.useAi ?? config.ai.enabled;
    let aiResult: AiDecisionResponse | undefined;
    const totalAmbiguous = layoutModel.pages.reduce(
      (sum, p) => sum + p.regions.filter((r) => r.isAmbiguous).length,
      0
    );

    if (totalAmbiguous > 0) {
      const context = buildAiContextSlices(layoutModel, this.services.skillManager, existingPattern);
      const provider: IAiProvider = aiEnabled
        ? new GeminiAiProvider(this.logger, config.ai.model)
        : new DeterministicFallbackAiProvider(this.logger);

      aiResult = await provider.decideSemantics(context);
      validateAiDecisions(layoutModel, aiResult);

      const lowConfidence = aiResult.decisions.filter(
        (d) => d.confidence < config.ai.confidenceThreshold
      );
      if (lowConfidence.length > 0) {
        this.logger.warn('AgentGate', `${lowConfidence.length} AI decision(s) below confidence threshold ${config.ai.confidenceThreshold}`);
      }
    }

    // Step 5: Bounded generation + validation loop
    const rdlcValidator = new RdlcValidator(this.logger);
    let iterations = 0;
    let reportDefinition = this.services.tablixBuilder.buildReportDefinition(
      layoutModel,
      aiResult,
      existingPattern
    );
    let vbArtifacts = this.services.vbGenerator.generate(reportDefinition, existingPattern);
    let rdlcXml = this.services.rdlcGenerator.generate(reportDefinition, vbArtifacts.embeddedRdlcCode);
    let rdlcValidation = rdlcValidator.validate(rdlcXml);

    while (!rdlcValidation.valid && iterations < config.validation.maxAgentIterations - 1) {
      iterations++;
      this.logger.warn('AgentLoop', `Validation gate triggered retry iteration ${iterations}`);
      reportDefinition = this.services.tablixBuilder.buildReportDefinition(
        layoutModel,
        aiResult,
        existingPattern
      );
      vbArtifacts = this.services.vbGenerator.generate(reportDefinition, existingPattern);
      rdlcXml = this.services.rdlcGenerator.generate(reportDefinition, vbArtifacts.embeddedRdlcCode);
      rdlcValidation = rdlcValidator.validate(rdlcXml);
    }

    // Step 6: Excel Oracle / Dummy JSON & Logic Tests
    const dummyJson = this.services.excelOracle.generateDummyJson(reportDefinition);
    let externalCases: LogicTestCase[] = input.customJsonTestCases ?? [];
    let ambiguousOracleWarnings: string[] = [];

    if (input.excelBytes) {
      const excelResult = this.services.excelOracle.readBuffer(input.excelBytes);
      externalCases = [...excelResult.testCases, ...externalCases];
      ambiguousOracleWarnings = excelResult.ambiguousWarnings;
    }

    const logicTests = this.services.logicTestRunner.run(
      vbArtifacts.fullVbClass,
      reportDefinition,
      externalCases,
      ambiguousOracleWarnings
    );

    // Step 7: Attempt ReportViewer rendering (honestly reports unavailable in Linux sandbox)
    const renderStatus = await this.services.renderer.renderToPdf(rdlcXml);

    // Step 8: Optional visual diff if comparison PDF was supplied
    let visualDiff;
    if (input.comparisonPdfBytes) {
      visualDiff = await this.services.visualDiff.comparePdfs(
        input.pdfBytes,
        input.comparisonPdfBytes,
        config.validation.visualSimilarityTarget,
        undefined,
        110
      );
    }

    const finalized =
      rdlcValidation.valid &&
      (!config.validation.requirePassingLogicTests || logicTests.status === 'PASS');

    if (finalized) {
      this.logger.info('AgentFinalize', 'Report finalized (RDLC & Logic gates passed)');
    } else {
      this.logger.warn('AgentFinalize', 'Report NOT finalized due to failed validation or logic gate');
    }

    return {
      runId,
      documentName: input.documentName,
      layoutModel,
      existingPattern,
      aiResult,
      reportDefinition,
      rdlcXml,
      vbCode: vbArtifacts.fullVbClass,
      dummyJson,
      rdlcValidation,
      logicTests,
      renderStatus,
      visualDiff,
      logs: this.logger.getEntries(),
      finalized,
      agentIterations: iterations + 1,
    };
  }
}
