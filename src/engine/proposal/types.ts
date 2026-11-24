import {
  IntermediateLayoutModel,
  RdlcValidationResult,
  RenderStatus,
  VisualDiffReport,
} from '../core/types.ts';

export type ConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW';
export type DataSourceMode = 'RealProductEngine' | 'SampleData' | 'DummyData' | 'ReferencePdfExtract';
export type ChangeAction = 'REUSE' | 'RENAME' | 'MODIFY' | 'ADD' | 'REMOVE' | 'REQUIRES_REVIEW';
export type SampleProvenance = 'extracted' | 'inferred' | 'unavailable' | 'manually_supplied';
export type SampleScenarioKind =
  | 'Normal'
  | 'EmptyNull'
  | 'MultipleRows'
  | 'LongText'
  | 'DifferentStatus'
  | 'LargeNumeric';

export interface VbAstMethod {
  name: string;
  kind: 'Function' | 'Sub' | 'Property';
  signature: string;
  startLine: number;
  endLine: number;
  bodyText: string;
  instantiations: string[];
  rdlcReferences: string[];
  productEngineCalls: string[];
  elementCalls: string[];
  referencedFields: string[];
  tableColumns: string[];
}

export interface VbAstType {
  name: string;
  kind: 'Class' | 'Module' | 'Interface';
  namespaceName: string;
  inherits: string[];
  implementsList: string[];
  methods: VbAstMethod[];
}

export interface VbAstFile {
  filePath: string;
  fileName: string;
  imports: string[];
  namespaces: string[];
  types: VbAstType[];
  planCodes: string[];
  datasetNames: string[];
  rdlcReferences: string[];
  productEngineCalls: string[];
}

export interface TechnologyProfile {
  language: 'VB.NET' | 'C#';
  languageVersion: string;
  projectType: string;
  targetFramework: string;
  projectFormat:
    | 'SDK-style .vbproj'
    | 'Legacy .vbproj'
    | 'SDK-style .csproj'
    | 'Legacy .csproj'
    | 'Directory';
  buildTool: string;
  compiler: string;
  rdlcVersion: '2008' | '2016' | 'mixed' | 'unknown';
  reportRuntime: string;
  optionStrict?: string;
  rootNamespace?: string;
  references: string[];
  packages: string[];
  compilerAvailableInEnvironment: boolean;
  reportRuntimeAvailableInEnvironment: boolean;
  detectedAt: string;
}

export interface UnresolvedReference {
  productCode: string;
  kind: 'Element' | 'RDLC' | 'Method';
  symbolOrName: string;
  referencedFrom: string;
  reason: string;
}

export interface ProposalDependencyGraph {
  productCode: string;
  builderFile: string;
  builderClass: string;
  elements: Array<{
    className: string;
    filePath: string;
    usedByMethods: string[];
    rdlcFiles: string[];
    methods: string[];
    productEngineCalls: string[];
  }>;
  rdlcFiles: Array<{
    name: string;
    resolvedPath?: string;
    referencedFrom: string;
    classification: 'direct' | 'indirect' | 'shared';
    datasets: string[];
  }>;
  datasets: string[];
  parameters: string[];
  productEngineCalls: string[];
  unresolvedReferences: UnresolvedReference[];
}

export interface ProductCatalogueEntry {
  productCode: string;
  planCodes: string[];
  rootDirectory: string;
  builderPath?: string;
  elementPath?: string;
  elementPaths?: string[];
  layoutPath?: string;
  layoutPaths?: string[];
  relatedFiles: string[];
  projectFilePath?: string;
  datasets: string[];
  parameters: string[];
  elementSymbols: string[];
  expressions: string[];
  dependencies: string[];
  hasProductEngineDependency: boolean;
  discoveryReason: string;
  dependencyGraph?: ProposalDependencyGraph;
}

export type ProjectFileInclusion =
  | 'explicit_compile'
  | 'explicit_embedded_resource'
  | 'explicit_content'
  | 'sdk_default_glob'
  | 'filesystem_fallback';

export interface ParsedProjectMember {
  relativePath: string;
  absolutePath: string;
  itemType: 'Compile' | 'EmbeddedResource' | 'Content' | 'None';
  inclusionSource: ProjectFileInclusion;
  existsOnDisk: boolean;
}

export interface ParsedDotNetProject {
  projectFilePath: string;
  projectFileName: string;
  projectDirectory: string;
  projectKind: 'vbproj' | 'csproj';
  isSdkStyle: boolean;
  enableDefaultItems: boolean;
  targetFramework: string;
  assemblyName?: string;
  rootNamespace?: string;
  optionStrict?: string;
  compileItems: ParsedProjectMember[];
  embeddedResources: ParsedProjectMember[];
  rdlcResources: ParsedProjectMember[];
  projectReferences: string[];
  excludedPatterns: string[];
}

export interface DeterministicProductCatalogEntry {
  productCode: string;
  planCodes: string[];
  entryPointClass: string;
  entryPointFile: string;
  entryPointRelativePath: string;
  projectFilePath?: string;
  registeredInProjectFile: boolean;
  elementClasses: string[];
  elementFiles: string[];
  rdlcFiles: string[];
  datasets: string[];
  parameters: string[];
  hasProductEngineDependency: boolean;
  catalogHash: string;
}

export interface DeterministicProductCatalog {
  service: 'ReportGen.Project.Scanner';
  projectRoot: string;
  projectFiles: string[];
  catalogDigest: string;
  entryPointCount: number;
  entries: DeterministicProductCatalogEntry[];
}

export interface ProjectScanResult {
  projectRoot: string;
  projectFilePath?: string;
  scannedAt: string;
  totalFilesScanned: number;
  technologyProfile: TechnologyProfile;
  parsedProjects?: ParsedDotNetProject[];
  deterministicCatalog?: DeterministicProductCatalog;
  unregisteredVbFiles?: string[];
  products: ProductCatalogueEntry[];
  sharedRdlcs: Array<{ name: string; resolvedPath?: string; usedByProducts: string[] }>;
  unusedRdlcCandidates: string[];
  unresolvedReferences: UnresolvedReference[];
}

export interface BenchmarkCandidate {
  productCode: string;
  score: number;
  deterministicScore: number;
  semanticScore: number;
  strategy: 'Deterministic' | 'Semantic' | 'Hybrid';
  reasons: string[];
}

export interface BenchmarkElementMeta {
  symbolName: string;
  className?: string;
  labelHint: string;
  referencedFields: string[];
  visibilityExpression?: string;
  usesProductEngine: boolean;
  sourceFile: string;
  lineNumber: number;
  startLine?: number;
  endLine?: number;
}

export interface BenchmarkAnalysis {
  productCode: string;
  planCodes: string[];
  cacheKey: string;
  analyzedAt: string;
  builderClassName: string;
  elementClassName: string;
  namespaceName: string;
  dataSourceName: string;
  dataSetName: string;
  fields: Array<{ name: string; dataType: string }>;
  parameters: string[];
  methods: Array<{ name: string; signature: string; sourceFile: string; lineNumber: number }>;
  elements: BenchmarkElementMeta[];
  expressions: string[];
  visibilityRules: string[];
  tablixNames: string[];
  pageSettings: {
    pageWidthIn: number;
    pageHeightIn: number;
    marginsIn: { top: number; right: number; bottom: number; left: number };
  };
  productEngineBindings: Array<{ field: string; expression: string; lineNumber: number }>;
  mockCommentMarkers: string[];
  rawBuilderSource?: string;
  rawElementSource?: string;
  rawElementSources?: Array<{ fileName: string; filePath: string; source: string }>;
  rawLayoutXml?: string;
  rawLayoutXmls?: Array<{ fileName: string; filePath: string; xml: string; rdlcSchemaVersion: '2008' | '2016' | 'unknown' }>;
  dependencyGraph?: ProposalDependencyGraph;
  builderAst?: VbAstFile;
  elementAsts?: VbAstFile[];
}

export interface TemplateAnalysis {
  role: 'PDF_A_TEMPLATE' | 'PDF_B_REFERENCE';
  fileName: string;
  pageCount: number;
  pages: Array<{
    pageNumber: number;
    widthIn: number;
    heightIn: number;
    orientation: 'Portrait' | 'Landscape';
    regionCount: number;
    tablesDetected: number;
    dynamicFieldCandidates: number;
    statusFieldCandidates: number;
  }>;
  layoutModel: IntermediateLayoutModel;
}

export interface ExtractedFieldValue {
  id: string;
  field: string;
  label: string;
  value: string | number;
  inferredType: 'String' | 'Decimal' | 'Date' | 'Status';
  isStatusField: boolean;
  candidateStates?: string[];
  provenance: SampleProvenance;
  extractionMethod: 'label_colon_inline' | 'label_adjacent' | 'table_cell' | 'manual' | 'deterministic_dummy';
  traceability: {
    pdfFile: string;
    page: number;
    bbox: { x: number; y: number; width: number; height: number };
    labelContext: string;
  };
  confidence: number;
  status: 'CONFIRMED' | 'UNCERTAIN';
}

export interface SampleScenarioDataset {
  scenario: SampleScenarioKind;
  description: string;
  rows: Array<Record<string, string | number | null>>;
}

export interface ReferenceDataExtract {
  sourcePdfFile: string;
  extractedAt: string;
  fields: ExtractedFieldValue[];
  datasetRows: Array<Record<string, string | number>>;
  scenarios?: SampleScenarioDataset[];
}

export interface ModificationChange {
  changeId: string;
  decision: ChangeAction;
  confidence: number;
  tier: ConfidenceTier;
  requiresReview: boolean;
  benchmarkElement?: string;
  targetElement: string;
  targetPdfRegion?: {
    pdf: 'PDF_A' | 'PDF_B';
    page: number;
    bbox: { x: number; y: number; width: number; height: number };
  };
  sourcePdfRegion?: {
    pdf: 'PDF_B';
    page: number;
    bbox: { x: number; y: number; width: number; height: number };
  };
  reason: string;
  changes: string[];
  generatedFile: string;
  generatedSymbol: string;
}

export interface FieldBindingSpec {
  field: string;
  dataType: 'System.String' | 'System.Decimal' | 'System.Int32' | 'System.DateTime';
  mode: DataSourceMode;
  dummyValue: string | number;
  productionSource: string;
  isStatusField: boolean;
  candidateStates?: string[];
  confidence: number;
  confirmed: boolean;
  traceabilityRef?: string;
}

export type DiffSymbolStatus =
  | 'UNCHANGED'
  | 'RENAMED'
  | 'MODIFIED'
  | 'ADDED'
  | 'REMOVED'
  | 'REQUIRES_REVIEW';

export interface MinimalMutationDiffItem {
  fileName: string;
  symbolName: string;
  symbolKind: 'Class' | 'Method' | 'RDLC' | 'Field' | 'Parameter' | 'Tablix';
  status: DiffSymbolStatus;
  reason: string;
}

export interface MinimalMutationReport {
  preservationPercent: number;
  unchangedCount: number;
  renamedCount: number;
  modifiedCount: number;
  addedCount: number;
  removedCount: number;
  requiresReviewCount: number;
  requiresReviewReasons: string[];
  items: MinimalMutationDiffItem[];
}

export interface ProposalSectionSpec {
  id: string;
  title: string;
  ordering: number;
  pageBreakBefore: boolean;
  sourceBenchmark: string;
  sourceElement?: string;
  targetRdlcFile: string;
  decision: ChangeAction;
  changes: string[];
}

export interface ProposalDefinition {
  productCode: string;
  planCode: string;
  benchmarkProductCode: string;
  createdAt: string;
  rdlcSchemaVersion: '2008';
  confidenceSummary: {
    highCount: number;
    mediumCount: number;
    lowCount: number;
    requiresUserReview: boolean;
  };
  sections: ProposalSectionSpec[];
  changes: ModificationChange[];
  dataBindings: FieldBindingSpec[];
  sampleScenarios?: SampleScenarioDataset[];
  parameters: Array<{ name: string; dataType: string; defaultValue: string }>;
  dataSourceName: string;
  dataSetName: string;
  layoutPageSettings: {
    pageWidthIn: number;
    pageHeightIn: number;
    marginsIn: { top: number; right: number; bottom: number; left: number };
  };
}

export interface TestCheckResult {
  category: 'VB_LOGIC' | 'DATA_BINDING' | 'RDLC_STRUCTURE' | 'RDLC_RENDERING' | 'VISUAL_REGRESSION';
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'NOT_VERIFIED_IN_ENVIRONMENT';
  details: string;
  assertionsPassed: number;
  assertionsTotal: number;
}

export interface ReportTestHarnessResult {
  overallStatus: 'PASS' | 'WARN' | 'FAIL';
  executedAt: string;
  checks: TestCheckResult[];
  warnings: string[];
  fatalErrors: string[];
  rdlcValidation: RdlcValidationResult;
  renderStatus: RenderStatus;
  visualDiff?: VisualDiffReport;
  diagnosisHistory: Array<{
    attempt: number;
    issue: string;
    actionTaken: string;
    resolved: boolean;
  }>;
}

export interface StagingApprovalState {
  productCode: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  approvedBy?: string;
  approvedAt?: string;
  policyOverrideWarnings: boolean;
  notes?: string;
  artifactHashes: {
    builderSha256: string;
    elementSha256: string;
    layoutSha256: string;
    additionalRdlcHashes?: Record<string, string>;
  };
}

export interface StagingWorkspaceSummary {
  stagingDir: string;
  productCode: string;
  files: {
    builderFile: string;
    elementFile: string;
    layoutFile: string;
    additionalRdlcFiles?: string[];
    proposalDefinitionFile: string;
    templateAnalysisFile: string;
    benchmarkAnalysisFile: string;
    technologyProfileFile?: string;
    projectAnalysisFile?: string;
    modificationPlanFile: string;
    dummyDataFile: string;
    validationReportFile: string;
    testResultsFile: string;
    visualComparisonFile: string;
    approvalFile: string;
  };
  approval: StagingApprovalState;
}

export interface InsertDryRunPlan {
  productCode: string;
  targetProjectRoot: string;
  stagingDir: string;
  canInsert: boolean;
  blockingReasons: string[];
  collisions: Array<{ targetPath: string; exists: boolean }>;
  wouldAdd: Array<{ source: string; target: string; sha256: string }>;
  wouldModify: Array<{ target: string; reason: string }>;
}

export interface InsertManifest {
  operation: 'INSERT';
  productCode: string;
  planCode: string;
  benchmark: string;
  timestamp: string;
  dryRun: boolean;
  status: 'SUCCESS' | 'ABORTED' | 'ROLLED_BACK';
  approval: StagingApprovalState;
  validationStatus: 'PASS' | 'WARN' | 'FAIL';
  backupDirectory?: string;
  files: Array<{
    source: string;
    target: string;
    sha256: string;
    action: 'ADDED' | 'OVERWRITTEN';
  }>;
  modifiedFiles: Array<{
    target: string;
    backupPath?: string;
    beforeSha256?: string;
    afterSha256: string;
  }>;
  warnings: string[];
}

export interface ProposalAdaptationRunResult {
  runId: string;
  productCode: string;
  planCode: string;
  benchmarkProductCode: string;
  technologyProfile: TechnologyProfile;
  pdfAAnalysis: TemplateAnalysis;
  pdfBAnalysis?: TemplateAnalysis;
  benchmarkAnalysis: BenchmarkAnalysis;
  referenceExtract?: ReferenceDataExtract;
  proposalDefinition: ProposalDefinition;
  builderVbCode: string;
  elementVbCode: string;
  layoutRdlcXml: string;
  additionalRdlcFiles?: Array<{ fileName: string; xml: string }>;
  diffReport: MinimalMutationReport;
  sampleScenarios: SampleScenarioDataset[];
  dummyDataJson: Record<string, unknown>;
  testHarness: ReportTestHarnessResult;
  staging: StagingWorkspaceSummary;
  usedSkills: string[];
  analysisMode: 'deterministic';
}

// Section 39 Clean Domain Interfaces
export interface IProjectScanner {
  scanProject(projectRoot: string): ProjectScanResult;
}

export interface IReportGenProjectScanner extends IProjectScanner {
  parseProjectStructures(projectRoot: string): ParsedDotNetProject[];
  buildCatalog(projectRoot: string): DeterministicProductCatalog;
}

export interface IBenchmarkDiscovery {
  rankCandidates(
    products: ProductCatalogueEntry[],
    pdfA: TemplateAnalysis
  ): Promise<BenchmarkCandidate[]>;
}

export interface IBenchmarkInspector {
  inspect(entry: ProductCatalogueEntry, cacheDir?: string): BenchmarkAnalysis;
}

export interface IDummyDataExtractor {
  extract(
    pdfB: TemplateAnalysis,
    benchmark: BenchmarkAnalysis
  ): ReferenceDataExtract;
}

export interface IProposalDefinitionBuilder {
  build(input: {
    productCode: string;
    planCode: string;
    benchmark: BenchmarkAnalysis;
    pdfA: TemplateAnalysis;
    pdfB?: TemplateAnalysis;
    referenceExtract?: ReferenceDataExtract;
    changes: ModificationChange[];
  }): ProposalDefinition;
}

export interface IProjectInserter {
  dryRun(projectRoot: string, stagingDir: string, allowOverwrite?: boolean): InsertDryRunPlan;
  insert(
    projectRoot: string,
    stagingDir: string,
    options: { confirm: boolean; allowOverwrite?: boolean }
  ): InsertManifest;
}
