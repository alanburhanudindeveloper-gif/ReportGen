import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadConfig, ReportGenConfig } from '../core/config.ts';
import { ReportGenError, ReportGenErrorCode, StructuredLogger } from '../core/types.ts';
import { GridReconstructor } from '../pdf/gridReconstructor.ts';
import { PdfAnalyzer } from '../pdf/pdfAnalyzer.ts';
import { SkillManager } from '../skills/skillManager.ts';
import { BenchmarkInspector } from './benchmarkInspector.ts';
import { DifferentialAnalyzer } from './differentialAnalyzer.ts';
import { applyManualFieldConfirmations, DummyDataExtractor } from './dummyDataExtractor.ts';
import { HybridBenchmarkDiscovery, ProjectScanner } from './projectScanner.ts';
import { ProposalDefinitionBuilder } from './proposalDefinitionBuilder.ts';
import { ProposalRdlcGenerator } from './proposalRdlcGenerator.ts';
import { ProposalVbGenerator } from './proposalVbGenerator.ts';
import { ReportTestHarness } from './reportTestHarness.ts';
import { sanitizeProductCode, StagingManager } from './stagingManager.ts';
import { TechnologyDetector } from './technologyDetector.ts';
import {
  BenchmarkCandidate,
  DeterministicProductCatalog,
  ParsedDotNetProject,
  ProductCatalogueEntry,
  ProjectScanResult,
  ProposalAdaptationRunResult,
  ReferenceDataExtract,
  TechnologyProfile,
  TemplateAnalysis,
} from './types.ts';

export class ProposalOrchestrator {
  private readonly logger: StructuredLogger;
  private readonly config: ReportGenConfig;
  private readonly scanner: ProjectScanner;
  private readonly discovery: HybridBenchmarkDiscovery;
  private readonly inspector: BenchmarkInspector;
  private readonly pdfAnalyzer: PdfAnalyzer;
  private readonly gridReconstructor: GridReconstructor;
  private readonly dummyExtractor: DummyDataExtractor;
  private readonly diffAnalyzer: DifferentialAnalyzer;
  private readonly defBuilder: ProposalDefinitionBuilder;
  private readonly vbGenerator: ProposalVbGenerator;
  private readonly rdlcGenerator: ProposalRdlcGenerator;
  private readonly testHarness: ReportTestHarness;
  private readonly stagingManager: StagingManager;

  constructor(config?: ReportGenConfig, echoLogs = false) {
    this.config = config ?? loadConfig();
    this.logger = new StructuredLogger(echoLogs);
    const skillManager = new SkillManager(this.logger);

    this.scanner = new ProjectScanner(this.logger);
    this.discovery = new HybridBenchmarkDiscovery(this.logger, this.config);
    this.inspector = new BenchmarkInspector(this.logger);
    this.pdfAnalyzer = new PdfAnalyzer(this.logger);
    this.gridReconstructor = new GridReconstructor(this.logger);
    this.dummyExtractor = new DummyDataExtractor(this.logger, this.config.validation.confidenceThreshold);
    this.diffAnalyzer = new DifferentialAnalyzer(this.logger, skillManager, this.config);
    this.defBuilder = new ProposalDefinitionBuilder(this.logger);
    this.vbGenerator = new ProposalVbGenerator(this.logger);
    this.rdlcGenerator = new ProposalRdlcGenerator(this.logger);
    this.testHarness = new ReportTestHarness(this.logger, this.config);
    this.stagingManager = new StagingManager(this.logger);
  }

  public detectTechnology(projectRoot: string): TechnologyProfile {
    return new TechnologyDetector(this.logger).detect(projectRoot);
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

  public async rankBenchmarks(
    products: ProductCatalogueEntry[],
    pdfABytes: Uint8Array,
    pdfAName: string
  ): Promise<{ pdfAAnalysis: TemplateAnalysis; candidates: BenchmarkCandidate[] }> {
    const pdfAAnalysis = await this.analyzeTemplate(pdfABytes, pdfAName, 'PDF_A_TEMPLATE');
    const candidates = await this.discovery.rankCandidates(products, pdfAAnalysis);
    return { pdfAAnalysis, candidates };
  }

  public async analyzeTemplate(
    pdfBytes: Uint8Array,
    fileName: string,
    role: 'PDF_A_TEMPLATE' | 'PDF_B_REFERENCE'
  ): Promise<TemplateAnalysis> {
    const rawLayout = await this.pdfAnalyzer.analyzeBuffer(pdfBytes, fileName, this.config.pdf.dpi);
    const layoutModel = this.gridReconstructor.reconstruct(
      rawLayout,
      this.config.pdf.coordinateTolerance
    );

    const pages = layoutModel.pages.map((p) => {
      const textRegions = p.regions.filter((r) => r.type === 'text' && r.text);
      const dynamicFieldCandidates = textRegions.filter((r) => r.text!.includes(':')).length;
      const statusFieldCandidates = textRegions.filter((r) =>
        /\b(Active|Waived|Included|Excluded|Not Covered|Pending|Approved|Yes|No)\b/i.test(r.text!)
      ).length;
      const tablesDetected = p.bands.filter((b) => b.isRepeatingDetail || b.columnWidths.length >= 3).length;

      return {
        pageNumber: p.pageNumber,
        widthIn: p.width,
        heightIn: p.height,
        orientation: (p.width > p.height ? 'Landscape' : 'Portrait') as 'Portrait' | 'Landscape',
        regionCount: p.regions.length,
        tablesDetected,
        dynamicFieldCandidates,
        statusFieldCandidates,
      };
    });

    return {
      role,
      fileName,
      pageCount: layoutModel.document.pageCount,
      pages,
      layoutModel,
    };
  }

  public async runAdaptation(input: {
    projectRoot: string;
    productCode: string;
    planCode?: string;
    benchmarkProductCode?: string;
    pdfABytes: Uint8Array;
    pdfAFileName: string;
    pdfBBytes?: Uint8Array;
    pdfBFileName?: string;
    fieldConfirmations?: Array<{ id?: string; field: string; value?: string | number; status?: 'CONFIRMED' | 'UNCERTAIN' }>;
  }): Promise<ProposalAdaptationRunResult> {
    const productCode = sanitizeProductCode(input.productCode);
    const planCode = (input.planCode || `${productCode}-STD`).toUpperCase();

    const scan = this.scanner.scanProject(input.projectRoot);
    if (scan.technologyProfile.language !== 'VB.NET') {
      throw new ReportGenError(
        ReportGenErrorCode.TECHNOLOGY_DETECTION_FAILED,
        `Target project language detected as "${scan.technologyProfile.language}", expected VB.NET.`
      );
    }
    if (scan.products.length === 0) {
      throw new ReportGenError(
        ReportGenErrorCode.BENCHMARK_NOT_FOUND,
        `No benchmark proposal products discovered in ${input.projectRoot}`
      );
    }

    const pdfAAnalysis = await this.analyzeTemplate(input.pdfABytes, input.pdfAFileName, 'PDF_A_TEMPLATE');
    const pdfBAnalysis = input.pdfBBytes
      ? await this.analyzeTemplate(input.pdfBBytes, input.pdfBFileName || 'reference-pdf-b.pdf', 'PDF_B_REFERENCE')
      : undefined;

    let chosenEntry = input.benchmarkProductCode
      ? scan.products.find((p) => p.productCode.toUpperCase() === input.benchmarkProductCode!.toUpperCase())
      : undefined;
    if (!chosenEntry) {
      const ranked = await this.discovery.rankCandidates(scan.products, pdfAAnalysis);
      chosenEntry =
        scan.products.find((p) => p.productCode === ranked[0]?.productCode) ?? scan.products[0];
    }

    const cacheDir = path.resolve(process.cwd(), '.reportgen-cache', 'benchmarks');
    const benchmarkAnalysis = this.inspector.inspect(chosenEntry, cacheDir);

    let referenceExtract: ReferenceDataExtract | undefined = pdfBAnalysis
      ? this.dummyExtractor.extract(pdfBAnalysis, benchmarkAnalysis)
      : undefined;
    if (referenceExtract && input.fieldConfirmations?.length) {
      referenceExtract = applyManualFieldConfirmations(referenceExtract, input.fieldConfirmations);
    }

    const diffOut = await this.diffAnalyzer.analyze({
      productCode,
      pdfA: pdfAAnalysis,
      benchmark: benchmarkAnalysis,
      referenceExtract,
    });

    let proposalDefinition = this.defBuilder.build({
      productCode,
      planCode,
      benchmark: benchmarkAnalysis,
      pdfA: pdfAAnalysis,
      pdfB: pdfBAnalysis,
      referenceExtract,
      changes: diffOut.changes,
    });

    if (referenceExtract) {
      referenceExtract.scenarios = proposalDefinition.sampleScenarios;
    }

    const vbOut = this.vbGenerator.generate(proposalDefinition, benchmarkAnalysis);
    const rdlcOut = this.rdlcGenerator.generate(
      proposalDefinition,
      pdfAAnalysis.layoutModel,
      benchmarkAnalysis
    );
    const initialDiffItems = [...vbOut.diffItems, ...rdlcOut.diffItems];

    const tested = await this.testHarness.runWithDiagnosis({
      definition: proposalDefinition,
      benchmark: benchmarkAnalysis,
      pdfA: pdfAAnalysis,
      pdfABytes: input.pdfABytes,
      pdfBBytes: input.pdfBBytes,
      initialBuilderVb: vbOut.builderVbCode,
      initialElementVb: vbOut.elementVbCode,
      initialRdlcXml: rdlcOut.rdlcXml,
      initialAdditionalRdlcFiles: rdlcOut.additionalRdlcFiles,
      initialDiffItems,
    });

    proposalDefinition = tested.definition;
    const sampleScenarios = proposalDefinition.sampleScenarios ?? [];

    const dummyDataJson: Record<string, unknown> = {
      DataSetName: proposalDefinition.dataSetName,
      Parameters: Object.fromEntries(
        proposalDefinition.parameters.map((p) => [p.name, p.defaultValue])
      ),
      Row: Object.fromEntries(
        proposalDefinition.dataBindings.map((b) => [
          b.field,
          {
            value: b.dummyValue,
            mode: b.mode,
            confirmed: b.confirmed,
            productionSource: b.productionSource,
          },
        ])
      ),
      Scenarios: sampleScenarios,
    };

    const outputRoot = path.resolve(process.cwd(), this.config.project.outputPath || 'output');
    const staging = this.stagingManager.writeStaging({
      baseOutputRoot: outputRoot,
      productCode,
      builderVbCode: tested.builderVbCode,
      elementVbCode: tested.elementVbCode,
      layoutRdlcXml: tested.rdlcXml,
      additionalRdlcFiles: tested.additionalRdlcFiles,
      diffReport: tested.diffReport,
      sampleScenarios,
      proposalDefinition,
      pdfAAnalysis,
      benchmarkAnalysis,
      technologyProfile: scan.technologyProfile,
      scanResult: scan,
      referenceExtract,
      testHarness: tested.harnessResult,
      dummyDataJson,
    });

    const inputsDir = path.join(staging.stagingDir, '.inputs');
    fs.mkdirSync(inputsDir, { recursive: true });
    fs.writeFileSync(path.join(inputsDir, 'pdfA.pdf'), input.pdfABytes);
    if (input.pdfBBytes) {
      fs.writeFileSync(path.join(inputsDir, 'pdfB.pdf'), input.pdfBBytes);
    }
    fs.writeFileSync(
      path.join(inputsDir, 'run-meta.json'),
      JSON.stringify(
        {
          projectRoot: input.projectRoot,
          productCode,
          planCode,
          benchmarkProductCode: benchmarkAnalysis.productCode,
          pdfAFileName: input.pdfAFileName,
          pdfBFileName: input.pdfBFileName,
        },
        null,
        2
      ),
      'utf-8'
    );

    return {
      runId: crypto.randomUUID(),
      productCode,
      planCode,
      benchmarkProductCode: benchmarkAnalysis.productCode,
      technologyProfile: scan.technologyProfile,
      pdfAAnalysis,
      pdfBAnalysis,
      benchmarkAnalysis,
      referenceExtract,
      proposalDefinition,
      builderVbCode: tested.builderVbCode,
      elementVbCode: tested.elementVbCode,
      layoutRdlcXml: tested.rdlcXml,
      additionalRdlcFiles: tested.additionalRdlcFiles,
      diffReport: tested.diffReport,
      sampleScenarios,
      dummyDataJson,
      testHarness: tested.harnessResult,
      staging,
      usedSkills: diffOut.usedSkills,
      analysisMode: diffOut.analysisMode,
    };
  }

  public async rerunWithFieldConfirmations(
    productCode: string,
    confirmations: Array<{ id?: string; field: string; value?: string | number; status?: 'CONFIRMED' | 'UNCERTAIN' }>
  ): Promise<ProposalAdaptationRunResult> {
    const outputRoot = path.resolve(process.cwd(), this.config.project.outputPath || 'output');
    const stagingDir = this.stagingManager.getStagingDir(outputRoot, productCode);
    const metaPath = path.join(stagingDir, '.inputs', 'run-meta.json');
    const pdfAPath = path.join(stagingDir, '.inputs', 'pdfA.pdf');
    const pdfBPath = path.join(stagingDir, '.inputs', 'pdfB.pdf');

    if (!fs.existsSync(metaPath) || !fs.existsSync(pdfAPath)) {
      throw new Error(`Cannot locate stored staging inputs for product "${productCode}".`);
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
      projectRoot: string;
      productCode: string;
      planCode: string;
      benchmarkProductCode: string;
      pdfAFileName: string;
      pdfBFileName?: string;
    };

    const pdfABytes = new Uint8Array(fs.readFileSync(pdfAPath));
    const pdfBBytes = fs.existsSync(pdfBPath) ? new Uint8Array(fs.readFileSync(pdfBPath)) : undefined;

    return this.runAdaptation({
      projectRoot: meta.projectRoot,
      productCode: meta.productCode,
      planCode: meta.planCode,
      benchmarkProductCode: meta.benchmarkProductCode,
      pdfABytes,
      pdfAFileName: meta.pdfAFileName,
      pdfBBytes,
      pdfBFileName: meta.pdfBFileName,
      fieldConfirmations: confirmations,
    });
  }
}
