import { ReportGenConfig } from '../core/config.ts';
import { StructuredLogger } from '../core/types.ts';
import { ExcelOracleReader } from '../excel/excelOracle.ts';
import { GridReconstructor } from '../pdf/gridReconstructor.ts';
import { PdfAnalyzer } from '../pdf/pdfAnalyzer.ts';
import { ProjectInspector } from '../project/projectInspector.ts';
import { ProjectIntegrator } from '../project/projectIntegrator.ts';
import { RdlcGenerator } from '../rdlc/rdlcGenerator.ts';
import { TablixBuilder } from '../rdlc/tablixBuilder.ts';
import { SkillManager } from '../skills/skillManager.ts';
import { LogicTestRunner } from '../testing/logicTestRunner.ts';
import { ReportViewerRenderer, VisualDiffEngine } from '../testing/visualDiff.ts';
import { VbGenerator } from '../vb/vbGenerator.ts';

export interface McpToolDescriptor {
  name: string;
  description: string;
  readOnly: boolean;
  handlerName: string;
}

export const MCP_TOOL_CATALOG: McpToolDescriptor[] = [
  { name: 'analyze_pdf', description: 'Extract pages, text, geometry, vectors, and images from PDF.', readOnly: true, handlerName: 'PdfAnalyzer.analyzeBuffer' },
  { name: 'inspect_rdlc', description: 'Extract DataSets, Fields, Parameters, and expressions from existing RDLC.', readOnly: true, handlerName: 'ProjectInspector.inspect' },
  { name: 'inspect_vb', description: 'Extract VB class conventions, namespaces, and reusable calculation functions.', readOnly: true, handlerName: 'ProjectInspector.inspect' },
  { name: 'inspect_excel', description: 'Parse Excel calculation oracle test scenarios and tolerances.', readOnly: true, handlerName: 'ExcelOracleReader.readBuffer' },
  { name: 'find_report_pattern', description: 'Retrieve matching existing report patterns and conventions.', readOnly: true, handlerName: 'SkillManager.retrieveRelevantSkills' },
  { name: 'load_skill', description: 'Selectively load a domain skill markdown rulebook.', readOnly: true, handlerName: 'SkillManager.loadSkill' },
  { name: 'generate_report_definition', description: 'Reconstruct grid & build Tablix-based intermediate ReportDefinition.', readOnly: true, handlerName: 'TablixBuilder.buildReportDefinition' },
  { name: 'generate_rdlc', description: 'Deterministically serialize ReportDefinition to RDLC 2016 XML.', readOnly: true, handlerName: 'RdlcGenerator.generate' },
  { name: 'generate_vb', description: 'Deterministically generate VB.NET report class & embedded RDLC functions.', readOnly: true, handlerName: 'VbGenerator.generate' },
  { name: 'run_logic_tests', description: 'Execute independent VB business calculation verification suite.', readOnly: true, handlerName: 'LogicTestRunner.run' },
  { name: 'render_rdlc', description: 'Invoke ReportViewer renderer when available in environment.', readOnly: false, handlerName: 'ReportViewerRenderer.renderToPdf' },
  { name: 'compare_pdf', description: 'Run Ghostscript + pixelmatch visual regression between two PDFs.', readOnly: true, handlerName: 'VisualDiffEngine.comparePdfs' },
  { name: 'write_to_project', description: 'Safely write generated artifacts into target .NET project directory.', readOnly: false, handlerName: 'ProjectIntegrator.writeArtifacts' },
];

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
    vbGenerator: new VbGenerator(logger),
    excelOracle: new ExcelOracleReader(logger),
    logicTestRunner: new LogicTestRunner(logger),
    renderer: new ReportViewerRenderer(logger),
    visualDiff: new VisualDiffEngine(logger),
  };
}
