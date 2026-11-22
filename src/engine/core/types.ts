export enum ReportGenErrorCode {
  PDF_ANALYSIS_FAILED = 'PDF_ANALYSIS_FAILED',
  LAYOUT_RECONSTRUCTION_FAILED = 'LAYOUT_RECONSTRUCTION_FAILED',
  AI_DECISION_INVALID = 'AI_DECISION_INVALID',
  RDLC_GENERATION_FAILED = 'RDLC_GENERATION_FAILED',
  VB_GENERATION_FAILED = 'VB_GENERATION_FAILED',
  LOGIC_TEST_FAILED = 'LOGIC_TEST_FAILED',
  RDLC_RENDER_FAILED = 'RDLC_RENDER_FAILED',
  VISUAL_VALIDATION_FAILED = 'VISUAL_VALIDATION_FAILED',
  PROJECT_INTEGRATION_FAILED = 'PROJECT_INTEGRATION_FAILED',
  SECURITY_VIOLATION = 'SECURITY_VIOLATION',
  TECHNOLOGY_DETECTION_FAILED = 'TECHNOLOGY_DETECTION_FAILED',
  VB_PARSE_FAILED = 'VB_PARSE_FAILED',
  BENCHMARK_NOT_FOUND = 'BENCHMARK_NOT_FOUND',
  RDLC_REFERENCE_UNRESOLVED = 'RDLC_REFERENCE_UNRESOLVED',
  INSERT_COLLISION = 'INSERT_COLLISION',
  APPROVAL_REQUIRED = 'APPROVAL_REQUIRED',
}

export class ReportGenError extends Error {
  public readonly code: ReportGenErrorCode;
  public readonly details?: unknown;

  constructor(code: ReportGenErrorCode, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'ReportGenError';
    this.code = code;
    this.details = details;
  }
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

export class StructuredLogger {
  private readonly entries: LogEntry[] = [];
  private readonly echoToConsole: boolean;

  constructor(echoToConsole = true) {
    this.echoToConsole = echoToConsole;
  }

  public log(level: LogLevel, stage: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      data,
    };
    this.entries.push(entry);
    if (this.echoToConsole) {
      const suffix = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`[${level}] ${message}${suffix}`);
    }
  }

  public info(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log('INFO', stage, message, data);
  }

  public warn(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log('WARN', stage, message, data);
  }

  public error(stage: string, message: string, data?: Record<string, unknown>): void {
    this.log('ERROR', stage, message, data);
  }

  public getEntries(): LogEntry[] {
    return [...this.entries];
  }
}

export type RegionType =
  | 'text'
  | 'image'
  | 'vector_line'
  | 'vector_rect'
  | 'vector_complex'
  | 'table';

export type SemanticRole =
  | 'reportTitle'
  | 'sectionHeading'
  | 'fieldLabel'
  | 'fieldValue'
  | 'tableHeader'
  | 'tableCell'
  | 'cardContainer'
  | 'timelineStep'
  | 'numberedListItem'
  | 'paragraph'
  | 'headerText'
  | 'footerText'
  | 'logoOrGraphic'
  | 'calculationField'
  | 'unknown';

export type BandKind =
  | 'Header'
  | 'Information'
  | 'Detail'
  | 'Cards'
  | 'Timeline'
  | 'Notes'
  | 'Footer';

export interface RegionStyle {
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  color: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidthPt?: number;
  textAlign: 'Left' | 'Center' | 'Right';
  verticalAlign: 'Top' | 'Middle' | 'Bottom';
  paddingPt: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export interface LayoutRegion {
  id: string;
  pageNumber: number;
  type: RegionType;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  style: RegionStyle;
  semanticRole: SemanticRole;
  confidence: number;
  bandKind: BandKind;
  isAmbiguous: boolean;
  ambiguityReason?: string;
  preferImageFallback?: boolean;
  imageAssetBase64?: string;
  imageAssetName?: string;
  sourceObjectRefs: string[];
  linkedField?: string;
  expression?: string;
}

export interface GridCellAssignment {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  regionIds: string[];
  primaryRegionId?: string;
  isMerged: boolean;
  isOverlapping: boolean;
}

export interface ReconstructedBand {
  id: string;
  pageNumber: number;
  name: string;
  bandKind: BandKind;
  x: number;
  y: number;
  width: number;
  height: number;
  columnBoundaries: number[];
  rowBoundaries: number[];
  columnWidths: number[];
  rowHeights: number[];
  cells: GridCellAssignment[];
  isRepeatingDetail: boolean;
  sourceRegionIds: string[];
}

export interface LayoutPage {
  pageNumber: number;
  width: number;
  height: number;
  rawObjectCount: number;
  regions: LayoutRegion[];
  bands: ReconstructedBand[];
  rasterPreviewBase64?: string;
}

export interface IntermediateLayoutModel {
  document: {
    name: string;
    pageCount: number;
    pageWidth: number;
    pageHeight: number;
    unit: 'inch';
    extractedAt: string;
  };
  pages: LayoutPage[];
}

export interface TablixTextboxContent {
  kind: 'Textbox';
  name: string;
  value: string;
  isExpression: boolean;
  style: RegionStyle;
  canGrow: boolean;
}

export interface TablixImageContent {
  kind: 'Image';
  name: string;
  mimeType: string;
  base64Data: string;
  sizing: 'FitProportional' | 'Fit' | 'Clip';
}

export interface TablixEmptyContent {
  kind: 'Empty';
  name: string;
  style?: Partial<RegionStyle>;
}

export type TablixCellContent = TablixTextboxContent | TablixImageContent | TablixEmptyContent;

export interface TablixCell {
  colIndex: number;
  rowIndex: number;
  colSpan: number;
  rowSpan: number;
  skipBecauseMerged: boolean;
  content: TablixCellContent;
}

export interface TablixRow {
  heightIn: number;
  isDetailRow: boolean;
  cells: TablixCell[];
}

export interface TablixRegion {
  id: string;
  name: string;
  pageNumber: number;
  bandKind: BandKind;
  topIn: number;
  leftIn: number;
  widthIn: number;
  heightIn: number;
  dataSetName?: string;
  isRepeatingDetail: boolean;
  columnWidthsIn: number[];
  rows: TablixRow[];
}

export interface ReportFieldDef {
  name: string;
  dataType: 'System.String' | 'System.Decimal' | 'System.Int32' | 'System.DateTime';
  sampleValue: string | number;
  isCalculated: boolean;
  formulaDescription?: string;
}

export interface ReportParameterDef {
  name: string;
  dataType: 'String' | 'Integer' | 'Float' | 'DateTime' | 'Boolean';
  prompt: string;
  defaultValue?: string;
}

export interface CalculationRuleDef {
  functionName: string;
  targetField: string;
  inputs: string[];
  operation: 'multiply' | 'subtract_percent' | 'sum' | 'tax' | 'custom_linear';
  expressionSummary: string;
  vbImplementation: string;
}

export interface VisualRectItem {
  kind: 'Rectangle';
  name: string;
  leftIn: number;
  topIn: number;
  widthIn: number;
  heightIn: number;
  backgroundColor?: string;
  borderColor?: string;
  borderWidthPt?: number;
}

export interface VisualImageItem {
  kind: 'Image';
  name: string;
  embeddedImageName: string;
  leftIn: number;
  topIn: number;
  widthIn: number;
  heightIn: number;
  sizing: 'FitProportional' | 'Fit' | 'Clip';
}

export interface VisualTextboxItem {
  kind: 'Textbox';
  name: string;
  leftIn: number;
  topIn: number;
  widthIn: number;
  heightIn: number;
  text: string;
  style: RegionStyle;
}

export interface VisualPageLayer {
  pageNumber: number;
  widthIn: number;
  heightIn: number;
  rectangles: VisualRectItem[];
  images: VisualImageItem[];
  textboxes: VisualTextboxItem[];
  tablixes: TablixRegion[];
}

export interface ReportDefinition {
  reportName: string;
  dataSourceName: string;
  dataSetName: string;
  pageWidthIn: number;
  pageHeightIn: number;
  marginsIn: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  fields: ReportFieldDef[];
  parameters: ReportParameterDef[];
  calculations: CalculationRuleDef[];
  tablixRegions: TablixRegion[];
  embeddedImages: Array<{ name: string; mimeType: string; base64Data: string }>;
  existingPatternUsed?: string;
  visualPages?: VisualPageLayer[];
}

export interface AiAmbiguousRegionSlice {
  regionId: string;
  pageNumber: number;
  text: string;
  bandHint: BandKind;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizePt: number;
  bold: boolean;
  hasBoxBorder: boolean;
  ambiguityReason: string;
  nearbyLabels: string[];
}

export interface AiDecisionItem {
  regionId: string;
  semanticRole: SemanticRole;
  linkedField?: string;
  bandOverride?: BandKind;
  preferImageFallback?: boolean;
  calculationHint?: string;
  confidence: number;
  rationale: string;
}

export interface AiDecisionResponse {
  provider: string;
  model: string;
  usedSkills: string[];
  tokenEstimate: {
    sentRegions: number;
    totalRegions: number;
    reductionPercent: number;
  };
  decisions: AiDecisionItem[];
}

export interface ExistingProjectPattern {
  sourceFiles: string[];
  dataSourceName: string;
  dataSetName: string;
  fields: string[];
  parameters: string[];
  vbClassName?: string;
  vbNamespace?: string;
  vbFunctions: Array<{ name: string; signature: string; bodyPreview: string }>;
  expressions: string[];
  conventions: string[];
}

export interface RdlcValidationDiagnostic {
  ruleId: string;
  severity: 'ERROR' | 'WARN';
  message: string;
  location?: string;
}

export interface RdlcValidationResult {
  valid: boolean;
  checkedRules: number;
  errors: RdlcValidationDiagnostic[];
  warnings: RdlcValidationDiagnostic[];
}

export interface LogicTestCase {
  scenario: string;
  inputs: Record<string, number | string>;
  expectedField: string;
  expectedValue: number;
  tolerance: number;
  source: 'excel' | 'json' | 'generated';
}

export interface LogicTestCaseResult {
  scenario: string;
  functionName: string;
  inputs: Record<string, number | string>;
  expected: number;
  actual: number;
  tolerance: number;
  passed: boolean;
  error?: string;
}

export interface LogicTestSummary {
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  total: number;
  passed: number;
  failed: number;
  cases: LogicTestCaseResult[];
  ambiguousOracleWarnings: string[];
}

export interface VisualDiffPageResult {
  page: number;
  similarity: number;
  mismatchPixels: number;
  totalPixels: number;
  diffImageBase64?: string;
  originalImageBase64?: string;
  comparedImageBase64?: string;
}

export interface VisualDiffReport {
  available: boolean;
  targetSimilarity: number;
  overallSimilarity: number;
  note: string;
  pages: VisualDiffPageResult[];
}

export interface RenderStatus {
  executed: boolean;
  engine: 'ReportViewer' | 'Unavailable';
  status: 'RENDERED' | 'NOT_VERIFIED_IN_ENVIRONMENT';
  message: string;
  renderedPdfPath?: string;
}

export interface PipelineRunResult {
  runId: string;
  documentName: string;
  layoutModel: IntermediateLayoutModel;
  existingPattern?: ExistingProjectPattern;
  aiResult?: AiDecisionResponse;
  reportDefinition: ReportDefinition;
  rdlcXml: string;
  vbCode: string;
  dummyJson: Record<string, unknown>;
  rdlcValidation: RdlcValidationResult;
  logicTests: LogicTestSummary;
  renderStatus: RenderStatus;
  visualDiff?: VisualDiffReport;
  logs: LogEntry[];
  finalized: boolean;
  agentIterations: number;
}
