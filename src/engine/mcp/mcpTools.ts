import { ReportGenConfig } from '../core/config.ts';
import { ReportGenError, ReportGenErrorCode, StructuredLogger } from '../core/types.ts';
import { ExcelOracleReader } from '../excel/excelOracle.ts';
import { GridReconstructor } from '../pdf/gridReconstructor.ts';
import { PdfAnalyzer } from '../pdf/pdfAnalyzer.ts';
import { ProjectInspector } from '../project/projectInspector.ts';
import { ProjectIntegrator } from '../project/projectIntegrator.ts';
import { RdlcGenerator } from '../rdlc/rdlcGenerator.ts';
import { RdlcVisualPreviewRenderer } from '../rdlc/rdlcPreviewRenderer.ts';
import { TablixBuilder } from '../rdlc/tablixBuilder.ts';
import { SkillManager } from '../skills/skillManager.ts';
import { LogicTestRunner } from '../testing/logicTestRunner.ts';
import { ReportViewerRenderer, VisualDiffEngine } from '../testing/visualDiff.ts';
import { VbGenerator } from '../vb/vbGenerator.ts';

export type AgentToolCategory = 'READ_ONLY' | 'VALIDATION' | 'PROPOSAL' | 'MUTATION';
export type AgentToolRisk = 'low' | 'medium' | 'high';

export interface McpToolDescriptor {
  name: string;
  description: string;
  readOnly: boolean;
  category: AgentToolCategory;
  riskLevel: AgentToolRisk;
  approvalRequired: boolean;
  handlerName: string;
  command?: string;
}

export const MCP_TOOL_CATALOG: McpToolDescriptor[] = [
  // READ_ONLY tools
  {
    name: 'list_agent_tools',
    description: 'List ReportGen Agent tools with risk levels and explicit approval requirements.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'MCP_TOOL_CATALOG',
    command: 'npm run proposal-cli -- tools',
  },
  {
    name: 'detect_technology',
    description: 'Inspect target .vbproj/.csproj/.vb/.rdlc files and detect deterministic TechnologyProfile.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'TechnologyDetector.detect',
    command: 'npm run proposal-cli -- tech-profile --project <dir>',
  },
  {
    name: 'build_catalog',
    description: 'Parse .vbproj/.csproj structures and build a deterministic SHA-256 product catalog.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'ReportGenProjectScanner.buildCatalog',
    command: 'npm run proposal-cli -- catalog --project <dir>',
  },
  {
    name: 'scan_project',
    description: 'Scan proposal products, VB.NET AST call graphs, datasets, and unresolved references.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'ReportGenProjectScanner.scanProject',
    command: 'npm run proposal-cli -- scan --project <dir>',
  },
  {
    name: 'inspect_benchmark',
    description: 'Extract compact symbol, element, dataset, parameter, and RDLC structure for one product.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'BenchmarkInspector.inspect',
    command: 'npm run proposal-cli -- inspect --project <dir> --product <CODE>',
  },
  {
    name: 'analyze_pdf',
    description: 'Extract pages, text, geometry, vectors, and images from PDF into structured layout JSON.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'PdfAnalyzer.analyzeBuffer',
    command: 'npm run reportgen -- analyze <input.pdf>',
  },
  {
    name: 'inspect_rdlc',
    description: 'Extract DataSets, Fields, Parameters, and expressions from existing RDLC.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'ProjectInspector.inspect',
    command: 'npm run reportgen -- inspect --rdlc <file.rdlc>',
  },
  {
    name: 'inspect_vb',
    description: 'Extract VB class conventions, namespaces, and reusable calculation functions.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'ProjectInspector.inspect',
    command: 'npm run reportgen -- inspect --vb <file.vb>',
  },
  {
    name: 'inspect_excel',
    description: 'Parse Excel calculation oracle test scenarios and tolerances.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'ExcelOracleReader.readBuffer',
    command: 'npm run reportgen -- inspect --excel <file.xlsx>',
  },
  {
    name: 'find_report_pattern',
    description: 'Retrieve matching existing report patterns and conventions.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'SkillManager.retrieveRelevantSkills',
  },
  {
    name: 'load_skill',
    description: 'Selectively load a domain skill markdown rulebook.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'SkillManager.loadSkill',
  },
  {
    name: 'preview_proposal_diff',
    description: 'Read-only preview of staged diff report, preserved ratio, affected files, and test status.',
    readOnly: true,
    category: 'READ_ONLY',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'StagingManager.preview',
    command: 'npm run proposal-cli -- preview --generated <stagingDir>',
  },

  // VALIDATION tools
  {
    name: 'validate_rdlc',
    description: 'Run deterministic 10-point RDLC structural and schema validation.',
    readOnly: true,
    category: 'VALIDATION',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'RdlcValidator.validate',
    command: 'npm run reportgen -- validate <rdlcOrDir>',
  },
  {
    name: 'run_logic_tests',
    description: 'Execute independent VB business calculation verification suite.',
    readOnly: true,
    category: 'VALIDATION',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'LogicTestRunner.run',
    command: 'npm run reportgen -- test <outputDir>',
  },
  {
    name: 'test_proposal_staging',
    description: 'Inspect and verify staged proposal test-results.json and validation-report.json.',
    readOnly: true,
    category: 'VALIDATION',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'ReportTestHarness.runWithDiagnosis',
    command: 'npm run proposal-cli -- test --generated <stagingDir>',
  },
  {
    name: 'render_rdlc',
    description: 'Invoke ReportViewer renderer into a temp PDF when dotnet/ReportViewer is available.',
    readOnly: true,
    category: 'VALIDATION',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'ReportViewerRenderer.renderToPdf',
    command: 'npm run reportgen -- render <report.rdlc>',
  },
  {
    name: 'preview_rdlc_visual',
    description: 'Programmatically parse RDLC XML into a 1:1 coordinate-locked HTML visual preview.',
    readOnly: true,
    category: 'VALIDATION',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'RdlcVisualPreviewRenderer.renderHtml',
    command: 'npm run reportgen -- render-preview <rdlcOrDir>',
  },
  {
    name: 'render_rdlc_pdf',
    description: 'Deterministically render RDLC XML coordinates, styles, tables, and embedded PNGs into a downloadable binary PDF.',
    readOnly: true,
    category: 'VALIDATION',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'RdlcVisualPreviewRenderer.renderPdf',
    command: 'npm run reportgen -- render-pdf <rdlcOrDir> --out <preview.pdf>',
  },
  {
    name: 'compare_pdf',
    description: 'Run Ghostscript + pixelmatch visual regression between two PDFs.',
    readOnly: true,
    category: 'VALIDATION',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'VisualDiffEngine.comparePdfs',
    command: 'npm run reportgen -- compare <original.pdf> <generated.pdf>',
  },

  // PROPOSAL tools (never mutate target .NET project)
  {
    name: 'generate_report_definition',
    description: 'Reconstruct grid & build Tablix-based intermediate ReportDefinition.',
    readOnly: true,
    category: 'PROPOSAL',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'TablixBuilder.buildReportDefinition',
  },
  {
    name: 'generate_rdlc',
    description: 'Deterministically serialize ReportDefinition to RDLC XML in memory.',
    readOnly: true,
    category: 'PROPOSAL',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'RdlcGenerator.generate',
  },
  {
    name: 'generate_vb',
    description: 'Deterministically generate VB.NET report class & embedded RDLC functions in memory.',
    readOnly: true,
    category: 'PROPOSAL',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'VbGenerator.generate',
  },
  {
    name: 'generate_proposal_staging',
    description: 'Generate minimal-mutation VB/RDLC proposal into isolated staging output/<CODE>/ only.',
    readOnly: false,
    category: 'PROPOSAL',
    riskLevel: 'medium',
    approvalRequired: false,
    handlerName: 'ProposalOrchestrator.runAdaptation',
    command: 'npm run proposal-cli -- generate --project <dir> --product <CODE> --pdf-a <a.pdf>',
  },
  {
    name: 'insert_dry_run',
    description: 'Simulate project insertion: check approval, SHA-256 hashes, collisions, and .vbproj diff without writing.',
    readOnly: true,
    category: 'PROPOSAL',
    riskLevel: 'low',
    approvalRequired: false,
    handlerName: 'ProjectInserter.dryRun',
    command: 'npm run proposal-cli -- insert --project <dir> --generated <stagingDir> --dry-run',
  },

  // MUTATION tools (EXPLICIT APPROVAL REQUIRED)
  {
    name: 'approve_staging',
    description: 'Record explicit human approval state and artifact SHA-256 hashes in staging workspace.',
    readOnly: false,
    category: 'MUTATION',
    riskLevel: 'high',
    approvalRequired: true,
    handlerName: 'StagingManager.approveStaging',
    command: 'npm run proposal-cli -- approve --generated <stagingDir> --by <reviewer>',
  },
  {
    name: 'insert_confirm',
    description: 'Copy approved staged artifacts into target .NET project and register in .vbproj after backup.',
    readOnly: false,
    category: 'MUTATION',
    riskLevel: 'high',
    approvalRequired: true,
    handlerName: 'ProjectInserter.insert',
    command: 'npm run proposal-cli -- insert --project <dir> --generated <stagingDir> --confirm',
  },
  {
    name: 'write_to_project',
    description: 'Write generated report artifacts into target .NET project directory.',
    readOnly: false,
    category: 'MUTATION',
    riskLevel: 'high',
    approvalRequired: true,
    handlerName: 'ProjectIntegrator.writeArtifacts',
    command: 'npm run reportgen -- generate <input.pdf> --project <dir>',
  },
];

export function getAgentToolDescriptor(toolName: string): McpToolDescriptor {
  const found = MCP_TOOL_CATALOG.find((t) => t.name === toolName);
  if (!found) {
    throw new ReportGenError(
      ReportGenErrorCode.SECURITY_VIOLATION,
      `Fail-closed: unknown ReportGen Agent tool "${toolName}" is not registered.`
    );
  }
  return found;
}

export function assertAgentToolApproval(
  toolName: string,
  options: { explicitApproval?: boolean } = {}
): McpToolDescriptor {
  const tool = getAgentToolDescriptor(toolName);
  if (tool.approvalRequired && !options.explicitApproval) {
    throw new ReportGenError(
      ReportGenErrorCode.SECURITY_VIOLATION,
      `Approval required before invoking "${tool.name}" (category=${tool.category}, risk=${tool.riskLevel}). Stopping fail-closed.`
    );
  }
  return tool;
}

export interface ReportGenServices {
  logger: StructuredLogger;
  config: ReportGenConfig;
  pdfAnalyzer: PdfAnalyzer;
  gridReconstructor: GridReconstructor;
  skillManager: SkillManager;
  projectInspector: ProjectInspector;
  projectIntegrator: ProjectIntegrator;
  tablixBuilder: TablixBuilder;
  rdlcGenerator: RdlcGenerator;
  rdlcPreviewRenderer: RdlcVisualPreviewRenderer;
  vbGenerator: VbGenerator;
  excelOracle: ExcelOracleReader;
  logicTestRunner: LogicTestRunner;
  renderer: ReportViewerRenderer;
  visualDiff: VisualDiffEngine;
}

export function createReportGenServices(config: ReportGenConfig, echoLogs = true): ReportGenServices {
  const logger = new StructuredLogger(echoLogs);
  return {
    logger,
    config,
    pdfAnalyzer: new PdfAnalyzer(logger),
    gridReconstructor: new GridReconstructor(logger),
    skillManager: new SkillManager(logger),
    projectInspector: new ProjectInspector(logger),
    projectIntegrator: new ProjectIntegrator(logger),
    tablixBuilder: new TablixBuilder(logger),
    rdlcGenerator: new RdlcGenerator(logger),
    rdlcPreviewRenderer: new RdlcVisualPreviewRenderer(logger),
    vbGenerator: new VbGenerator(logger),
    excelOracle: new ExcelOracleReader(logger),
    logicTestRunner: new LogicTestRunner(logger),
    renderer: new ReportViewerRenderer(logger),
    visualDiff: new VisualDiffEngine(logger),
  };
}
