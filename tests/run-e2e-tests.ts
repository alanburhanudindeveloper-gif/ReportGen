import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ReportGenAgent } from '../src/engine/agent/reportGenAgent.ts';
import { loadConfig } from '../src/engine/core/config.ts';
import { createReportGenServices } from '../src/engine/mcp/mcpTools.ts';
import {
  buildVerificationFixtureExcel,
  buildVerificationFixturePdf,
  SAMPLE_EXISTING_RDLC,
  SAMPLE_EXISTING_VB,
} from '../src/samples/fixtureGenerator.ts';

async function runTests() {
  const config = loadConfig();
  const services = createReportGenServices(config, false);
  const agent = new ReportGenAgent(services);

  const pdfBytes = await buildVerificationFixturePdf();
  const excelBytes = buildVerificationFixtureExcel();

  // 1. Full end-to-end pipeline with deterministic fallback (no external API dependency in unit test)
  const result = await agent.execute({
    documentName: 'E2EVerificationReport',
    pdfBytes,
    existingRdlcXml: SAMPLE_EXISTING_RDLC,
    existingRdlcFileName: 'ExistingReport.rdlc',
    existingVbSource: SAMPLE_EXISTING_VB,
    existingVbFileName: 'ExistingReport.vb',
    excelBytes,
    comparisonPdfBytes: pdfBytes, // identical PDF baseline sanity check
    useAi: false,
  });

  assert.strictEqual(result.layoutModel.document.pageCount, 2, 'Should parse all 2 pages');
  assert.ok(result.layoutModel.pages[0].regions.length > 10, 'Page 1 should extract text and vector regions');
  assert.ok(result.layoutModel.pages[0].bands.length >= 2, 'Page 1 should reconstruct multiple Tablix bands');
  assert.ok(result.existingPattern?.fields.includes('LineTotal'), 'Should inspect existing RDLC fields');
  assert.strictEqual(result.rdlcValidation.valid, true, 'Generated RDLC XML must pass 10-point validation');
  assert.strictEqual(result.logicTests.status, 'PASS', 'Excel oracle logic tests must PASS');
  assert.strictEqual(result.logicTests.passed, 3, 'All 3 Excel oracle test scenarios must pass');
  assert.strictEqual(result.finalized, true, 'Pipeline must finalize when RDLC and Logic gates pass');
  assert.ok(result.rdlcXml.includes('<Tablix '), 'RDLC must use Tablix structures');
  assert.ok(result.vbCode.includes('Public Function CalculateLineTotal'), 'VB class must contain calculation function');
  assert.strictEqual(result.renderStatus.status, 'NOT_VERIFIED_IN_ENVIRONMENT', 'Must honestly report ReportViewer unavailability');
  assert.ok(result.visualDiff?.available, 'Ghostscript + pixelmatch visual diff must execute');
  assert.strictEqual(result.visualDiff?.overallSimilarity, 1, 'Self-comparison baseline must compute 1.0 similarity');

  // 2. ProjectIntegrator overwrite protection test
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'reportgen-proj-'));
  try {
    const writeReq = {
      projectRoot: tmpProject,
      relativeOutputDir: 'Reports/Generated/Invoice',
      reportName: 'Invoice',
      force: false,
      files: {
        rdlcXml: result.rdlcXml,
        vbCode: result.vbCode,
        dummyJson: JSON.stringify(result.dummyJson, null, 2),
        reportDefinitionJson: JSON.stringify(result.reportDefinition, null, 2),
      },
    };
    const firstWrite = services.projectIntegrator.writeArtifacts(writeReq, config);
    assert.strictEqual(firstWrite.writtenFiles.length, 4, 'Should write 4 artifact files');

    let blocked = false;
    try {
      services.projectIntegrator.writeArtifacts(writeReq, config);
    } catch {
      blocked = true;
    }
    assert.strictEqual(blocked, true, 'Must refuse silent overwrite when force=false');

    const forcedWrite = services.projectIntegrator.writeArtifacts({ ...writeReq, force: true }, config);
    assert.strictEqual(forcedWrite.writtenFiles.length, 4, 'Should overwrite cleanly when force=true');
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }

  console.log('ALL E2E TESTS PASSED');
}

runTests().catch((err) => {
  console.error('E2E TEST FAILED:', err);
  process.exit(1);
});
