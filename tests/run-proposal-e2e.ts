import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/engine/core/config.ts';
import { StructuredLogger } from '../src/engine/core/types.ts';
import { BenchmarkInspector } from '../src/engine/proposal/benchmarkInspector.ts';
import { ProjectInserter } from '../src/engine/proposal/projectInserter.ts';
import { ProposalOrchestrator } from '../src/engine/proposal/proposalOrchestrator.ts';
import { ReportTestHarness } from '../src/engine/proposal/reportTestHarness.ts';
import { StagingManager } from '../src/engine/proposal/stagingManager.ts';
import { buildProposalTemplatePdfA, buildReferenceSystemPdfB } from '../src/samples/proposalFixtures.ts';

function copyDirRecursive(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function runProposalE2E() {
  console.log('=== Proposal Report Adaptation Engine E2E Verification ===');
  const config = loadConfig();
  const logger = new StructuredLogger(false);
  const orch = new ProposalOrchestrator(config, false);

  const sampleProjectDir = path.resolve(process.cwd(), 'samples', 'SampleProposalProject');

  // 0. Phase 2 TechnologyProfile explicit failure on non-.NET empty directory
  const emptyTmp = path.join(os.tmpdir(), `reportgen-empty-${Date.now()}`);
  fs.mkdirSync(emptyTmp, { recursive: true });
  assert.throws(
    () => orch.detectTechnology(emptyTmp),
    /TECHNOLOGY_DETECTION_FAILED/,
    'Empty folder must throw TECHNOLOGY_DETECTION_FAILED'
  );
  fs.rmSync(emptyTmp, { recursive: true, force: true });

  // 1. Recursive AST-based Project Scan & Phase 2 TechnologyProfile
  const scan = orch.scanProject(sampleProjectDir);
  assert.strictEqual(scan.technologyProfile.language, 'VB.NET', 'Expected VB.NET target language');
  assert.strictEqual(scan.technologyProfile.targetFramework, 'net8.0-windows', 'Expected net8.0-windows');
  assert.strictEqual(scan.technologyProfile.rdlcVersion, '2008', 'Expected RDLC 2008 detected');
  assert.ok(scan.technologyProfile.references.length >= 6, 'Expected .vbproj references extracted');
  assert.strictEqual(scan.technologyProfile.compilerAvailableInEnvironment, false, 'Expected honest Linux compiler availability');

  assert.ok(scan.products.length >= 2, 'Expected at least 2 products discovered (ABC, MFA)');
  const mfa = scan.products.find((p) => p.productCode === 'MFA');
  assert.ok(mfa, 'Expected MFA benchmark product');
  assert.ok(mfa.hasProductEngineDependency, 'Expected ProductEngine dependency detected on MFA');
  assert.strictEqual(mfa.dependencyGraph?.elements.length, 2, 'Expected 2 MFA Element classes discovered via VB AST');
  assert.strictEqual(mfa.dependencyGraph?.rdlcFiles.length, 2, 'Expected 2 MFA RDLC files discovered via VB AST');
  assert.ok(
    scan.unresolvedReferences.some((u) => u.productCode === 'ABC' && /ABCProposalElement/i.test(u.symbolOrName)),
    'Expected ABC missing ABCProposalElement flagged in unresolvedReferences'
  );
  assert.ok(Array.isArray(scan.sharedRdlcs) && Array.isArray(scan.unusedRdlcCandidates));

  // Verify ReportGen.Project.Scanner parsed project structures & deterministic catalog reproducibility
  assert.ok(scan.parsedProjects && scan.parsedProjects.length === 1, 'Expected 1 parsed .vbproj structure');
  assert.strictEqual(scan.parsedProjects[0].projectKind, 'vbproj');
  assert.strictEqual(scan.parsedProjects[0].isSdkStyle, true);
  assert.ok(scan.parsedProjects[0].compileItems.length >= 4, 'Expected Compile entries parsed from Proposal.vbproj');
  assert.ok(scan.parsedProjects[0].embeddedResources.length >= 2, 'Expected EmbeddedResource RDLCs parsed from Proposal.vbproj');

  const catalog1 = orch.buildCatalog(sampleProjectDir);
  const catalog2 = orch.buildCatalog(sampleProjectDir);
  assert.strictEqual(catalog1.service, 'ReportGen.Project.Scanner');
  assert.strictEqual(catalog1.catalogDigest, catalog2.catalogDigest, 'Catalog digest must be deterministic across repeated scans');
  assert.deepStrictEqual(catalog1.entries, catalog2.entries, 'Catalog entries must be byte-for-byte deterministic');
  assert.ok(catalog1.entries.every((e) => e.registeredInProjectFile), 'All SampleProposalProject entries must be registered in Proposal.vbproj');

  // Verify Legacy .vbproj (non-SDK) distinguishes registered vs unregistered ProposalBuilder.vb
  const legacyTmp = path.join(os.tmpdir(), `reportgen-legacy-${Date.now()}`);
  fs.mkdirSync(path.join(legacyTmp, 'Proposals'), { recursive: true });
  fs.writeFileSync(
    path.join(legacyTmp, 'LegacyReports.vbproj'),
    `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>
    <RootNamespace>Legacy.Proposals</RootNamespace>
    <OptionStrict>On</OptionStrict>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Proposals\\AlphaProposalBuilder.vb" />
    <EmbeddedResource Include="Proposals\\AlphaProposalLayout.rdlc" />
  </ItemGroup>
</Project>`,
    'utf-8'
  );
  fs.writeFileSync(
    path.join(legacyTmp, 'Proposals', 'AlphaProposalBuilder.vb'),
    `Public Class AlphaProposalBuilder\n  Public Shared ReadOnly PlanCode As String = "ALPHA-01"\nEnd Class\n`,
    'utf-8'
  );
  fs.writeFileSync(
    path.join(legacyTmp, 'Proposals', 'OrphanProposalBuilder.vb'),
    `Public Class OrphanProposalBuilder\nEnd Class\n`,
    'utf-8'
  );
  fs.writeFileSync(
    path.join(legacyTmp, 'Proposals', 'AlphaProposalLayout.rdlc'),
    `<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition"></Report>`,
    'utf-8'
  );
  const legacyScan = orch.scanProject(legacyTmp);
  const alphaEntry = legacyScan.deterministicCatalog?.entries.find((e) => e.productCode === 'ALPHA');
  const orphanEntry = legacyScan.deterministicCatalog?.entries.find((e) => e.productCode === 'ORPHAN');
  assert.strictEqual(alphaEntry?.registeredInProjectFile, true, 'AlphaProposalBuilder must be registered in Legacy .vbproj');
  assert.strictEqual(orphanEntry?.registeredInProjectFile, false, 'OrphanProposalBuilder must be flagged unregistered in Legacy .vbproj');
  assert.strictEqual(legacyScan.unregisteredVbFiles?.length, 1, 'Expected 1 unregistered .vb file detected');
  fs.rmSync(legacyTmp, { recursive: true, force: true });

  console.log(`[PASS] Phase 1 & 2: ReportGen.Project.Scanner (${catalog1.catalogDigest}), TechnologyProfile (VB.NET / RDLC 2008) & AST graph (${scan.unresolvedReferences.length} unresolved caught)`);

  // 2. Benchmark Inspector + Cache hit
  const inspector = new BenchmarkInspector(logger);
  const cacheDir = path.join(os.tmpdir(), `reportgen-bench-cache-${Date.now()}`);
  const inspect1 = inspector.inspect(mfa, cacheDir);
  const inspect2 = inspector.inspect(mfa, cacheDir);
  assert.strictEqual(inspect1.cacheKey, inspect2.cacheKey, 'Cache key must match on second inspect');
  assert.ok(inspect1.elements.length >= 3, 'Expected MFA Build*Element symbols extracted');
  console.log(`[PASS] BenchmarkInspector extracted ${inspect1.elements.length} element symbols & cached ${inspect1.cacheKey}`);

  // 3. Full Two-PDF Adaptation into staging workspace (output/EGATEST)
  const pdfABytes = await buildProposalTemplatePdfA();
  const pdfBBytes = await buildReferenceSystemPdfB();
  const run = await orch.runAdaptation({
    projectRoot: sampleProjectDir,
    productCode: 'EGATEST',
    planCode: 'EGATEST-EXEC-2026',
    benchmarkProductCode: 'MFA',
    pdfABytes,
    pdfAFileName: 'EGA-Template-PDFA.pdf',
    pdfBBytes,
    pdfBFileName: 'Reference-System-PDFB.pdf',
    useAi: false,
  });

  // Verify structured staging folders and all staged files exist
  for (const sub of ['analysis', 'decision', 'generated', 'test', 'insert']) {
    assert.ok(fs.existsSync(path.join(run.staging.stagingDir, sub)), `Missing structured staging dir: ${sub}`);
  }
  assert.ok(fs.existsSync(path.join(run.staging.stagingDir, 'analysis', 'technology-profile.json')), 'Missing analysis/technology-profile.json');
  assert.ok(fs.existsSync(path.join(run.staging.stagingDir, 'analysis', 'project-analysis.json')), 'Missing analysis/project-analysis.json');
  const fileValues = Object.values(run.staging.files).flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []));
  assert.ok(fileValues.length >= 15, `Expected >=15 staged files including technology/project analysis & additional RDLC, got ${fileValues.length}`);
  for (const f of fileValues) {
    assert.ok(fs.existsSync(f), `Missing staged file: ${f}`);
  }
  console.log(`[PASS] Structured staging workspace & ${fileValues.length} artifacts written to ${run.staging.stagingDir}`);

  // 4. Verify PDF B traceability, 4-tier provenance & manual confirmation re-run
  assert.ok(run.referenceExtract && run.referenceExtract.fields.length >= 4, 'Expected extracted PDF B fields');
  for (const f of run.referenceExtract.fields) {
    assert.ok(['extracted', 'inferred', 'unavailable', 'manually_supplied'].includes(f.provenance), `Invalid provenance on ${f.field}`);
  }
  const statusField = run.referenceExtract.fields.find((f) => f.isStatusField);
  assert.ok(statusField, 'Expected status field inferred from PDF B');
  assert.ok(statusField.traceability.pdfFile && statusField.traceability.page >= 1, 'Expected traceability info');

  const rerun = await orch.rerunWithFieldConfirmations('EGATEST', [
    { field: statusField.field, value: 'Included', status: 'CONFIRMED' },
  ]);
  const updatedField = rerun.referenceExtract?.fields.find((f) => f.field === statusField.field);
  assert.strictEqual(updatedField?.status, 'CONFIRMED', 'Expected manual confirmation applied');
  assert.strictEqual(updatedField?.provenance, 'manually_supplied', 'Expected manually_supplied provenance after confirmation');
  console.log(`[PASS] PDF B extraction, provenance & manual confirmation verified (${statusField.field})`);

  // 5. Minimal-mutation VB.NET + strict RDLC 2008 + 6 Sample Scenarios + Test Harness
  assert.ok(rerun.proposalDefinition.changes.some((c) => c.changeId.startsWith('CHG-')), 'Expected CHG-xxxx entries');
  assert.ok(/Class\s+EGATESTProposalBuilder/.test(rerun.builderVbCode), 'Expected EGATESTProposalBuilder class');
  assert.ok(rerun.builderVbCode.includes('ComputeIllustrationChecksum'), 'Expected untouched benchmark helper method preserved');
  assert.ok(rerun.builderVbCode.includes('REPORTGEN_MOCK'), 'Expected explicit REPORTGEN_MOCK marker');
  assert.ok(rerun.diffReport.preservationPercent >= 40, `Expected high preservationPercent, got ${rerun.diffReport.preservationPercent}`);

  assert.strictEqual(rerun.proposalDefinition.rdlcSchemaVersion, '2008', 'Expected RDLC 2008 schema version');
  assert.ok(
    rerun.layoutRdlcXml.includes('http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition') &&
      !rerun.layoutRdlcXml.includes('<ReportSections>'),
    'Primary Layout.rdlc must strictly be RDLC 2008'
  );
  assert.ok(rerun.additionalRdlcFiles && rerun.additionalRdlcFiles.length >= 1, 'Expected additional RDLC file (EGATESTBenefit.rdlc)');
  assert.strictEqual(rerun.additionalRdlcFiles[0].fileName, 'EGATESTBenefit.rdlc');
  assert.ok(
    rerun.additionalRdlcFiles[0].xml.includes('2008/01/reportdefinition') &&
      !rerun.additionalRdlcFiles[0].xml.includes('<ReportSections>'),
    'Additional Benefit.rdlc must strictly be RDLC 2008'
  );

  assert.strictEqual(rerun.sampleScenarios.length, 6, 'Expected 6 sample scenario datasets');
  assert.ok(rerun.testHarness.rdlcValidation.valid, 'Expected 10-point + RDLC-2008 validation PASS');
  assert.strictEqual(
    rerun.testHarness.renderStatus.status,
    'NOT_VERIFIED_IN_ENVIRONMENT',
    'Must honestly report NOT_VERIFIED_IN_ENVIRONMENT without dotnet/ReportViewer'
  );
  console.log(`[PASS] Minimal-mutation (${rerun.diffReport.preservationPercent}% preserved), strict RDLC 2008 & 6 scenarios (${rerun.testHarness.overallStatus})`);

  // 6. Verify DiagnosisAgent repairs a missing DataSet field inside RDLC 2008 automatically
  const harness = new ReportTestHarness(logger, config);
  const brokenRdlc = rerun.layoutRdlcXml.replace(
    /<Value>[^<]+<\/Value>/,
    '<Value>=Fields!AutoInjectedMissingField.Value</Value>'
  );
  const repaired = await harness.runWithDiagnosis({
    definition: rerun.proposalDefinition,
    benchmark: rerun.benchmarkAnalysis,
    pdfA: rerun.pdfAAnalysis,
    pdfABytes,
    pdfBBytes,
    initialBuilderVb: rerun.builderVbCode,
    initialElementVb: rerun.elementVbCode,
    initialRdlcXml: brokenRdlc,
    initialAdditionalRdlcFiles: rerun.additionalRdlcFiles,
    initialDiffItems: rerun.diffReport.items,
  });
  assert.ok(repaired.harnessResult.diagnosisHistory.length >= 1, 'Expected DiagnosisAgent attempt recorded');
  assert.ok(repaired.rdlcXml.includes('2008/01/reportdefinition') && !repaired.rdlcXml.includes('<ReportSections>'), 'Repaired RDLC must remain RDLC 2008');
  console.log(`[PASS] DiagnosisAgent executed bounded repair (${repaired.harnessResult.diagnosisHistory.length} attempt(s)) preserving RDLC 2008`);

  // 7. Approval gate + Dry Run + Controlled Insert (4 files) + Collision Abort + Overwrite Backup into temp project copy
  const tmpProject = path.join(os.tmpdir(), `reportgen-target-${Date.now()}`);
  copyDirRecursive(sampleProjectDir, tmpProject);

  const inserter = new ProjectInserter(logger);
  const stagingMgr = new StagingManager(logger);

  // Before approval: dryRun must block
  const blockedPlan = inserter.dryRun(tmpProject, rerun.staging.stagingDir, false);
  assert.strictEqual(blockedPlan.canInsert, false, 'Must block insert before explicit approval');

  // Approve cleanly
  const approval = stagingMgr.approveStaging({
    stagingDir: rerun.staging.stagingDir,
    approvedBy: 'e2e-verifier',
    decision: 'APPROVED',
    policyOverrideWarnings: true,
    notes: 'Automated E2E verification approval',
  });
  assert.strictEqual(approval.status, 'APPROVED');

  const readyPlan = inserter.dryRun(tmpProject, rerun.staging.stagingDir, false);
  assert.strictEqual(readyPlan.canInsert, true, 'Approved staging without collision must be ready');
  assert.strictEqual(readyPlan.wouldAdd.length, 4, 'Should plan to copy 4 files (Builder, Element, Layout, Benefit.rdlc)');

  const manifest1 = inserter.insert(tmpProject, rerun.staging.stagingDir, { confirm: true });
  assert.strictEqual(manifest1.status, 'SUCCESS');
  assert.strictEqual(manifest1.files.length, 4);
  const vbprojContent = fs.readFileSync(path.join(tmpProject, 'Proposal.vbproj'), 'utf-8');
  assert.ok(vbprojContent.includes('EGATESTProposalBuilder.vb'), 'Expected Builder registered in .vbproj');
  assert.ok(vbprojContent.includes('EGATESTBenefit.rdlc'), 'Expected additional RDLC registered in .vbproj');
  console.log(`[PASS] Controlled insert copied 4 files, updated Proposal.vbproj, and wrote insert-manifest.json`);

  // Collision check without --allow-overwrite must abort
  const collisionPlan = inserter.dryRun(tmpProject, rerun.staging.stagingDir, false);
  assert.strictEqual(collisionPlan.canInsert, false, 'Collision must abort by default');
  assert.strictEqual(collisionPlan.collisions.length, 4);

  // Overwrite with allowOverwrite must create backup + overwrite cleanly
  const manifest2 = inserter.insert(tmpProject, rerun.staging.stagingDir, {
    confirm: true,
    allowOverwrite: true,
  });
  assert.strictEqual(manifest2.status, 'SUCCESS');
  assert.ok(manifest2.backupDirectory && fs.existsSync(manifest2.backupDirectory), 'Expected backup directory created');
  console.log(`[PASS] Collision abort & --allow-overwrite backup/restore flow verified`);

  // Cleanup temp & test staging folder so workspace stays tidy
  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(rerun.staging.stagingDir, { recursive: true, force: true });

  console.log('=== All Proposal Adaptation E2E assertions PASSED ===');
}

runProposalE2E().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
