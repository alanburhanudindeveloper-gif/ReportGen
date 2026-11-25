import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { ReportGenAgent } from '../src/engine/agent/reportGenAgent.ts';
import { loadConfig } from '../src/engine/core/config.ts';
import { createReportGenServices } from '../src/engine/mcp/mcpTools.ts';
import {
  buildVerificationFixtureExcel,
  buildVerificationFixturePdf,
  SAMPLE_EXISTING_RDLC,
  SAMPLE_EXISTING_VB,
} from '../src/samples/fixtureGenerator.ts';

function assertV3FullTablixStructure(rdlcXml: string, label: string) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
  });
  const parsed = parser.parse(rdlcXml);
  const report = parsed?.Report;
  const section = Array.isArray(report?.ReportSections?.ReportSection)
    ? report.ReportSections.ReportSection[0]
    : report?.ReportSections?.ReportSection;
  const bodyItems = section?.Body?.ReportItems ?? {};
  const page = section?.Page ?? {};

  assert.ok(!bodyItems.Rectangle, `${label}: Body must contain 0 top-level <Rectangle> elements`);
  assert.ok(!bodyItems.Textbox, `${label}: Body must contain 0 top-level <Textbox> elements`);
  assert.ok(!bodyItems.Image, `${label}: Body must contain 0 top-level <Image> elements`);
  assert.ok(!bodyItems.Line, `${label}: Body must contain 0 top-level <Line> elements`);

  const tablixes = Array.isArray(bodyItems.Tablix)
    ? bodyItems.Tablix
    : bodyItems.Tablix
    ? [bodyItems.Tablix]
    : [];
  assert.ok(tablixes.length >= 1, `${label}: Body must contain at least 1 <Tablix>`);
  for (const t of tablixes) {
    assert.ok(
      /^Tablix_\d{2}_/i.test(String(t?.['@_Name'] ?? '')),
      `${label}: Top-level Body Tablix "${String(t?.['@_Name'])}" must match Tablix_{NN}_{Slug}`
    );
  }

  assert.ok(!rdlcXml.includes('PageContainer_'), `${label}: Legacy PageContainer_ must not exist`);
  assert.ok(!rdlcXml.includes('<Rectangle Name="Section_'), `${label}: Legacy Section_ Rectangle must not exist`);
  assert.ok(!rdlcXml.includes('Img_Layer0_'), `${label}: Legacy Img_Layer0_ must not exist`);

  const headers = Array.isArray(page.PageHeader) ? page.PageHeader : page.PageHeader ? [page.PageHeader] : [];
  const footers = Array.isArray(page.PageFooter) ? page.PageFooter : page.PageFooter ? [page.PageFooter] : [];
  assert.ok(headers.length <= 1, `${label}: At most 1 <PageHeader>`);
  assert.ok(footers.length <= 1, `${label}: At most 1 <PageFooter>`);
}

async function runTests() {
  const config = loadConfig();
  const services = createReportGenServices(config, false);
  const agent = new ReportGenAgent(services);

  const pdfBytes = await buildVerificationFixturePdf();
  const excelBytes = buildVerificationFixtureExcel();

  // 1. Determinism & v3 Full-Tablix RDLC 2016 pipeline on fixture PDF (compares Original PDF vs Rendered RDLC PDF)
  const req = {
    documentName: 'E2EVerificationReport',
    pdfBytes,
    existingRdlcXml: SAMPLE_EXISTING_RDLC,
    existingRdlcFileName: 'ExistingReport.rdlc',
    existingVbSource: SAMPLE_EXISTING_VB,
    existingVbFileName: 'ExistingReport.vb',
    excelBytes,
    schemaVersion: '2016' as const,
  };
  const result = await agent.execute(req);
  const result2 = await agent.execute(req);

  assert.strictEqual(result.rdlcSha256, result2.rdlcSha256, 'Repeated deterministic conversions must produce identical SHA-256');
  assert.strictEqual(result.rdlcXml, result2.rdlcXml, 'Repeated deterministic conversions must produce byte-identical RDLC XML');
  assert.strictEqual(result.layoutModel.document.pageCount, 2, 'Should parse all 2 pages');
  assert.ok(result.layoutModel.pages[0].regions.length > 10, 'Page 1 should extract text and vector regions');
  assert.ok(result.layoutModel.pages[0].bands.length >= 2, 'Page 1 should reconstruct multiple Tablix bands');
  assert.ok(result.existingPattern?.fields.includes('LineTotal'), 'Should inspect existing RDLC fields');
  assert.strictEqual(result.rdlcValidation.checkedRules, 15, 'Fixture must run full 15-point RDLC validation');
  assert.strictEqual(result.rdlcValidation.valid, true, `Generated RDLC XML must pass 15-point validation: ${JSON.stringify(result.rdlcValidation.errors)}`);
  assert.strictEqual(result.logicTests.status, 'PASS', 'Excel oracle logic tests must PASS');
  assert.strictEqual(result.logicTests.passed, 3, 'All 3 Excel oracle test scenarios must pass');
  assert.strictEqual(result.finalized, true, 'Pipeline must finalize when RDLC and Logic gates pass');
  assert.ok(result.rdlcXml.includes('http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition'), 'RDLC must target 2016 schema');
  assert.ok(result.rdlcXml.includes('<rd:ReportUnitType>Cm</rd:ReportUnitType>'), 'RDLC 2016 output must declare Cm unit type');
  assertV3FullTablixStructure(result.rdlcXml, 'Fixture');
  assert.strictEqual(result.conversionMetrics.collisionsCount, 0, 'Fixture must have 0 layout collisions');
  assert.strictEqual(result.conversionMetrics.renderedPageCount, 2, 'Fixture rendered page count must equal 2');
  assert.ok(result.vbCode.includes('Public Function CalculateLineTotal'), 'VB class must contain calculation function');
  assert.strictEqual(result.renderStatus.status, 'NOT_VERIFIED_IN_ENVIRONMENT', 'Must honestly report ReportViewer unavailability');
  assert.ok(result.visualDiff?.available, 'Ghostscript + pixelmatch visual parity check must execute');
  assert.strictEqual(result.visualDiff?.pages.length, 2, 'Visual diff must evaluate both pages');
  for (const p of result.visualDiff?.pages || []) {
    console.log(`[Fixture Parity] Page ${p.page}: parity=${p.parityPercent}% MAE=${p.meanAbsoluteError}`);
    assert.ok((p.parityPercent ?? 0) >= 95.0, `Fixture Page ${p.page} parity (${p.parityPercent}%) must be >= 95.0%`);
  }

  // 2. Live parameter extraction & override re-render directly from RDLC XML
  const params = services.rdlcPreviewRenderer.extractParameters(result.rdlcXml);
  assert.ok(result.reportDefinition.parameters.length > 0, 'Fixture PDF should auto-bind ReportParameters');
  assert.ok(result.rdlcXml.includes('<DefaultValue>'), 'Auto-bound ReportParameters must emit <DefaultValue>');
  if (params.length > 0) {
    const firstParam =
      params.find((p) => result.rdlcXml.includes(`Parameters!${p.name}.Value`)) ?? params[0];
    assert.ok(
      result.rdlcXml.includes(`Parameters!${firstParam.name}.Value`),
      'At least one ReportParameter must be bound in RDLC XML'
    );
    const basePdf = await services.rdlcPreviewRenderer.renderPdf(result.rdlcXml, {
      sampleFields: result.dummyJson,
    });
    const overriddenPdf = await services.rdlcPreviewRenderer.renderPdf(result.rdlcXml, {
      sampleFields: result.dummyJson,
      parameterOverrides: {
        [firstParam.name]: 'OVERRIDE-VALUE-999',
      },
    });
    assert.strictEqual(
      Buffer.from(overriddenPdf.subarray(0, 5)).toString('utf-8'),
      '%PDF-',
      'Parameter override render must emit valid PDF'
    );
    assert.notStrictEqual(
      Buffer.compare(overriddenPdf, basePdf),
      0,
      'Changing a ReportParameter override must update the rendered RDLC PDF'
    );
  }

  // 3. Real multi-page PDF parity verification (RIPLAY Hospital Cash Plan)
  const realPdfPath = path.resolve(
    process.cwd(),
    'public',
    'assets',
    'aistudio',
    'RIPLAY_Umum_Asuransi_Tambahan_Hospital_Cash_Plan-070426_ca7cb754.pdf'
  );
  if (fs.existsSync(realPdfPath)) {
    const realPdfBytes = fs.readFileSync(realPdfPath);
    const realResult = await agent.execute({
      documentName: 'RIPLAY_Hospital_Cash_Plan',
      pdfBytes: realPdfBytes,
      schemaVersion: '2016',
    });
    assert.strictEqual(realResult.rdlcValidation.checkedRules, 15, 'RIPLAY must run full 15-point RDLC validation');
    assert.strictEqual(realResult.rdlcValidation.valid, true, `Real RIPLAY PDF RDLC must pass 15-point validation: ${JSON.stringify(realResult.rdlcValidation.errors)}`);
    assert.ok(realResult.layoutModel.document.pageCount >= 1, 'Real RIPLAY PDF must parse pages');
    assertV3FullTablixStructure(realResult.rdlcXml, 'RIPLAY');
    assert.strictEqual(realResult.conversionMetrics.collisionsCount, 0, 'RIPLAY must have 0 layout collisions');
    assert.strictEqual(
      realResult.conversionMetrics.renderedPageCount,
      realResult.layoutModel.document.pageCount,
      'RIPLAY rendered page count must match source PDF page count'
    );
    assert.ok(realResult.visualDiff?.available, 'Real RIPLAY PDF visual parity diff must execute');
    assert.strictEqual(
      realResult.visualDiff?.pages.length,
      realResult.layoutModel.document.pageCount,
      'RIPLAY visual diff must match source page count'
    );
    for (const p of realResult.visualDiff?.pages || []) {
      console.log(`[RIPLAY Parity] Page ${p.page}: parity=${p.parityPercent}% MAE=${p.meanAbsoluteError}`);
      assert.ok((p.parityPercent ?? 0) >= 95.0, `RIPLAY Page ${p.page} parity (${p.parityPercent}%) must be >= 95.0%`);
    }
  }

  // 4. ProjectIntegrator overwrite protection test
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
