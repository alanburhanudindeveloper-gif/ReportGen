#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { ReportGenAgent } from '../engine/agent/reportGenAgent.ts';
import { loadConfig } from '../engine/core/config.ts';
import { LogicTestCase, ReportGenError } from '../engine/core/types.ts';
import { createReportGenServices } from '../engine/mcp/mcpTools.ts';
import { RdlcValidator } from '../engine/rdlc/rdlcValidator.ts';

function printHelp(): void {
  console.log(`ReportGen CLI — AI-assisted PDF -> RDLC Tablix + VB.NET Report Generator

Usage:
  reportgen analyze <input.pdf> [--out <layout.json>]
  reportgen generate <input.pdf> [--project <dir>] [--output <relDir>] [--existing-rdlc <file>] [--existing-vb <file>] [--excel <file>] [--no-ai] [--force]
  reportgen validate <outputDirOrRdlcFile>
  reportgen test <outputDir> [--excel <file>] [--json <file>]
  reportgen render <report.rdlc>
  reportgen compare <original.pdf> <generated.pdf> [--out <visual-diff>]
  reportgen --help
`);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];
  const config = loadConfig();
  const services = createReportGenServices(config, true);

  if (command === 'analyze') {
    const pdfPath = args[1];
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      throw new Error(`Input PDF not found: ${pdfPath ?? '(missing)'}`);
    }
    const pdfBytes = new Uint8Array(fs.readFileSync(pdfPath));
    const docName = path.basename(pdfPath, path.extname(pdfPath));
    const rawLayout = await services.pdfAnalyzer.analyzeBuffer(pdfBytes, docName, config.pdf.dpi);
    const layout = services.gridReconstructor.reconstruct(rawLayout, config.pdf.coordinateTolerance);
    const outPath = getFlagValue(args, '--out') ?? path.join('output', `${docName}-layout.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // Omit heavy base64 previews in CLI JSON output
    const compact = {
      ...layout,
      pages: layout.pages.map((p) => ({ ...p, rasterPreviewBase64: undefined })),
    };
    fs.writeFileSync(outPath, JSON.stringify(compact, null, 2), 'utf-8');
    console.log(`Intermediate layout written to ${outPath}`);
    return;
  }

  if (command === 'generate') {
    const pdfPath = args[1];
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      throw new Error(`Input PDF not found: ${pdfPath ?? '(missing)'}`);
    }
    const projectRoot = getFlagValue(args, '--project') ?? process.cwd();
    const docName = path.basename(pdfPath, path.extname(pdfPath));
    const relOutput = getFlagValue(args, '--output') ?? path.join(config.project.outputPath, docName);
    const existingRdlcPath = getFlagValue(args, '--existing-rdlc');
    const existingVbPath = getFlagValue(args, '--existing-vb');
    const excelPath = getFlagValue(args, '--excel');
    const force = args.includes('--force');
    const useAi = !args.includes('--no-ai');

    const agent = new ReportGenAgent(services);
    const result = await agent.execute({
      documentName: docName,
      pdfBytes: new Uint8Array(fs.readFileSync(pdfPath)),
      existingRdlcXml: existingRdlcPath ? fs.readFileSync(existingRdlcPath, 'utf-8') : undefined,
      existingRdlcFileName: existingRdlcPath ? path.basename(existingRdlcPath) : undefined,
      existingVbSource: existingVbPath ? fs.readFileSync(existingVbPath, 'utf-8') : undefined,
      existingVbFileName: existingVbPath ? path.basename(existingVbPath) : undefined,
      excelBytes: excelPath ? fs.readFileSync(excelPath) : undefined,
      useAi,
    });

    if (!result.finalized) {
      throw new Error('Generation blocked: RDLC validation or Logic tests failed.');
    }

    const writeResult = services.projectIntegrator.writeArtifacts(
      {
        projectRoot,
        relativeOutputDir: relOutput,
        reportName: result.reportDefinition.reportName,
        force,
        files: {
          rdlcXml: result.rdlcXml,
          vbCode: result.vbCode,
          dummyJson: JSON.stringify(result.dummyJson, null, 2),
          reportDefinitionJson: JSON.stringify(result.reportDefinition, null, 2),
        },
      },
      config
    );
    console.log(`Artifacts written to: ${writeResult.targetDirectory}`);
    writeResult.writtenFiles.forEach((f) => console.log(`  - ${f}`));
    return;
  }

  if (command === 'validate') {
    const target = args[1];
    if (!target || !fs.existsSync(target)) {
      throw new Error(`Target not found: ${target ?? '(missing)'}`);
    }
    const rdlcFile = fs.statSync(target).isDirectory()
      ? fs.readdirSync(target).find((f) => f.endsWith('.rdlc'))
      : target;
    if (!rdlcFile) {
      throw new Error(`No .rdlc file found in ${target}`);
    }
    const fullPath = fs.statSync(target).isDirectory() ? path.join(target, rdlcFile) : target;
    const xml = fs.readFileSync(fullPath, 'utf-8');
    const validator = new RdlcValidator(services.logger);
    const res = validator.validate(xml);
    console.log(JSON.stringify(res, null, 2));
    if (!res.valid) process.exit(1);
    return;
  }

  if (command === 'test') {
    const dir = args[1];
    if (!dir || !fs.existsSync(dir)) {
      throw new Error(`Output directory not found: ${dir ?? '(missing)'}`);
    }
    const vbFile = fs.readdirSync(dir).find((f) => f.endsWith('.vb'));
    const defFile = fs.readdirSync(dir).find((f) => f === 'report-definition.json');
    if (!vbFile || !defFile) {
      throw new Error(`Directory ${dir} must contain a .vb file and report-definition.json`);
    }
    const vbCode = fs.readFileSync(path.join(dir, vbFile), 'utf-8');
    const definition = JSON.parse(fs.readFileSync(path.join(dir, defFile), 'utf-8'));

    const excelPath = getFlagValue(args, '--excel');
    const jsonPath = getFlagValue(args, '--json') ?? (fs.existsSync(path.join(dir, 'dummy.json')) ? path.join(dir, 'dummy.json') : undefined);
    let cases: LogicTestCase[] = [];
    let warnings: string[] = [];

    if (excelPath && fs.existsSync(excelPath)) {
      const ex = services.excelOracle.readBuffer(fs.readFileSync(excelPath));
      cases = ex.testCases;
      warnings = ex.ambiguousWarnings;
    } else if (jsonPath && fs.existsSync(jsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if (Array.isArray(parsed.LogicTestScenarios)) {
        cases = parsed.LogicTestScenarios.map((c: LogicTestCase) => ({ ...c, source: 'json' }));
      }
    }

    const summary = services.logicTestRunner.run(vbCode, definition, cases, warnings);
    console.log(JSON.stringify({ status: summary.status, total: summary.total, passed: summary.passed, failed: summary.failed, cases: summary.cases }, null, 2));
    if (summary.status !== 'PASS') process.exit(1);
    return;
  }

  if (command === 'render') {
    const rdlcPath = args[1];
    if (!rdlcPath || !fs.existsSync(rdlcPath)) {
      throw new Error(`RDLC file not found: ${rdlcPath ?? '(missing)'}`);
    }
    const status = await services.renderer.renderToPdf(rdlcPath);
    console.log(JSON.stringify(status, null, 2));
    if (!status.executed) process.exit(2);
    return;
  }

  if (command === 'compare') {
    const origPath = args[1];
    const genPath = args[2];
    if (!origPath || !genPath || !fs.existsSync(origPath) || !fs.existsSync(genPath)) {
      throw new Error('Both original.pdf and generated.pdf must exist.');
    }
    const outDir = getFlagValue(args, '--out') ?? 'visual-diff';
    const report = await services.visualDiff.comparePdfs(
      new Uint8Array(fs.readFileSync(origPath)),
      new Uint8Array(fs.readFileSync(genPath)),
      config.validation.visualSimilarityTarget,
      outDir
    );
    console.log(
      JSON.stringify(
        {
          overallSimilarity: report.overallSimilarity,
          targetSimilarity: report.targetSimilarity,
          pages: report.pages.map((p) => ({ page: p.page, similarity: p.similarity, mismatchPixels: p.mismatchPixels })),
          outputDir: outDir,
        },
        null,
        2
      )
    );
    return;
  }

  printHelp();
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof ReportGenError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
