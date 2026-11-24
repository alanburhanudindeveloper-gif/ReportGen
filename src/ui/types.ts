export interface FrontendLogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface FrontendLayoutRegion {
  id: string;
  pageNumber: number;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  semanticRole: string;
  confidence: number;
  bandKind: string;
  isAmbiguous: boolean;
  ambiguityReason?: string;
  preferImageFallback?: boolean;
  linkedField?: string;
}

export interface FrontendBand {
  id: string;
  pageNumber: number;
  name: string;
  bandKind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columnWidths: number[];
  rowHeights: number[];
  isRepeatingDetail: boolean;
  cells: Array<{
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
    primaryRegionId?: string;
    isMerged: boolean;
  }>;
}

export interface FrontendLayoutPage {
  pageNumber: number;
  width: number;
  height: number;
  rawObjectCount: number;
  regions: FrontendLayoutRegion[];
  bands: FrontendBand[];
  rasterPreviewBase64?: string;
}

export interface FrontendTablixRegion {
  id: string;
  name: string;
  pageNumber: number;
  bandKind: string;
  archetype?: 'A' | 'B' | 'C' | 'D';
  topIn: number;
  leftIn: number;
  widthIn: number;
  heightIn: number;
  isRepeatingDetail: boolean;
  columnWidthsIn: number[];
  rows: Array<{
    heightIn: number;
    isDetailRow: boolean;
    pageBreakBefore?: boolean;
    cells: Array<{
      colIndex: number;
      rowIndex: number;
      colSpan: number;
      rowSpan: number;
      skipBecauseMerged: boolean;
      content: {
        kind: string;
        name: string;
        value?: string;
        isExpression?: boolean;
        tablix?: FrontendTablixRegion;
        textboxes?: Array<{ name: string; text?: string }>;
        images?: Array<{ name: string }>;
      };
    }>;
  }>;
}

export interface FrontendPipelineResult {
  runId: string;
  documentName: string;
  layoutModel: {
    document: {
      name: string;
      pageCount: number;
      pageWidth: number;
      pageHeight: number;
      unit: string;
      extractedAt: string;
    };
    pages: FrontendLayoutPage[];
  };
  existingPattern?: {
    sourceFiles: string[];
    dataSourceName: string;
    dataSetName: string;
    fields: string[];
    parameters: string[];
    vbClassName?: string;
    vbNamespace?: string;
    vbFunctions: Array<{ name: string; signature: string; bodyPreview: string }>;
    conventions: string[];
  };
  rdlcSha256?: string;
  rdlcSchemaVersion?: '2008' | '2016';
  conversionMetrics?: {
    textboxes: number;
    tablixes: number;
    nestedTablixes?: number;
    layer0Pages: number;
    glyphFallbacks: number;
    deduplicatedFakeBold: number;
    parameters: number;
    sectionsCount?: number;
    dualColumnSections?: number;
    printOnFirstPage?: boolean;
    nativeHeaderPresent?: boolean;
    nativeFooterPresent?: boolean;
    archetypes?: { A: number; B: number; C: number; D: number };
    collisionsCount?: number;
    renderedPageCount?: number;
  };
  reportDefinition: {
    reportName: string;
    dataSourceName: string;
    dataSetName: string;
    pageWidthIn: number;
    pageHeightIn: number;
    fields: Array<{ name: string; dataType: string; sampleValue: string | number; isCalculated: boolean }>;
    parameters: Array<{ name: string; dataType: string; prompt: string; defaultValue?: string; matchedPattern?: string; pageNumber?: number }>;
    calculations: Array<{ functionName: string; targetField: string; expressionSummary: string }>;
    tablixRegions: FrontendTablixRegion[];
    bodyTablixes?: FrontendTablixRegion[];
    hierarchy?: {
      mode: 'v3-full-tablix-single-rdlc' | 'v2-hierarchical-single-rdlc';
      pageHeader?: {
        heightIn: number;
        printOnFirstPage: boolean;
        printOnLastPage: boolean;
        assetCount: number;
        textLabels: string[];
      };
      pageFooter?: {
        heightIn: number;
        printOnFirstPage: boolean;
        printOnLastPage: boolean;
        assetCount: number;
        textLabels: string[];
      };
      sections: Array<{
        name: string;
        slug: string;
        pageNumber: number;
        pageBreakStart: boolean;
        topIn: number;
        leftIn: number;
        widthIn: number;
        heightIn: number;
        layoutType:
          | 'Single-Column'
          | 'Dual-Column'
          | 'Multi-Column'
          | 'Tablix'
          | 'Clause-List'
          | 'Hybrid-Callout';
        archetype?: 'A' | 'B' | 'C' | 'D';
        rowCount?: number;
        colCount?: number;
        hasNestedTablixes?: boolean;
        columnCount?: number;
        hasHeaderBand: boolean;
        hasLeftColumn: boolean;
        hasRightColumn: boolean;
        hasFooterBand: boolean;
        childItemCount: number;
      }>;
    };
    bodySections?: Array<{
      name: string;
      leftIn: number;
      topIn: number;
      widthIn: number;
      heightIn: number;
      pageNumber?: number;
      role?: string;
      children?: {
        rectangles: Array<{
          name: string;
          leftIn: number;
          topIn: number;
          widthIn: number;
          heightIn: number;
          role?: string;
        }>;
      };
    }>;
  };
  rdlcXml: string;
  vbCode: string;
  dummyJson: Record<string, unknown>;
  rdlcValidation: {
    valid: boolean;
    checkedRules: number;
    errors: Array<{ ruleId: string; severity: string; message: string; location?: string }>;
    warnings: Array<{ ruleId: string; severity: string; message: string; location?: string }>;
  };
  logicTests: {
    status: 'PASS' | 'FAIL' | 'SKIPPED';
    total: number;
    passed: number;
    failed: number;
    ambiguousOracleWarnings: string[];
    cases: Array<{
      scenario: string;
      functionName: string;
      inputs: Record<string, number | string>;
      expected: number;
      actual: number;
      tolerance: number;
      passed: boolean;
      error?: string;
    }>;
  };
  renderStatus: {
    executed: boolean;
    engine: string;
    status: string;
    message: string;
  };
  visualDiff?: {
    available: boolean;
    targetSimilarity: number;
    overallSimilarity: number;
    overallParityPercent?: number;
    meanAbsoluteError?: number;
    note: string;
    pages: Array<{
      page: number;
      similarity: number;
      parityPercent?: number;
      meanAbsoluteError?: number;
      mismatchPixels: number;
      totalPixels: number;
      diffImageBase64?: string;
      originalImageBase64?: string;
      comparedImageBase64?: string;
    }>;
  };
  logs: FrontendLogEntry[];
  finalized: boolean;
  agentIterations: number;
}
