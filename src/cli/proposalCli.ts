#!/usr/bin/env node
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../engine/core/config.ts';
import { StructuredLogger } from '../engine/core/types.ts';
import { wrapUntrustedData } from '../engine/core/untrustedContent.ts';
import { MCP_TOOL_CATALOG } from '../engine/mcp/mcpTools.ts';
import { BenchmarkInspector } from '../engine/proposal/benchmarkInspector.ts';
import { ProjectInserter } from '../engine/proposal/projectInserter.ts';
import { ProposalOrchestrator } from '../engine/proposal/proposalOrchestrator.ts';
import { StagingManager } from '../engine/proposal/stagingManager.ts';
import { buildProposalTemplatePdfA, buildReferenceSystemPdfB } from '../samples/proposalFixtures.ts';

dotenv.config({ quiet: true });

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function printHelp(): void {
  console.log(`proposal-cli - Deterministic-First Proposal Adaptation CLI

Commands (READ_ONLY):
  tools [--category <READ_ONLY|VALIDATION|PROPOSAL|MUTATION>]
      List machine-readable Agent tools with risk level and approval requirements.

  tech-profile --project <dir>
      Inspect target .vbproj/.vb/.rdlc files and output deterministic TechnologyProfile JSON.

  catalog --project <dir>
      Run ReportGen.Project.Scanner to parse .vbproj/.csproj structures, identify ProposalBuilder.vb
      entry points, and output a deterministic SHA-256 indexed product catalog.

  scan --project <dir>
      Recursively discover benchmark proposal products, TechnologyProfile, and DependencyGraph.

  inspect --project <dir> --product <CODE>
      Extract compact element symbols, datasets, parameters, and RDLC structure for a benchmark product.

  preview --generated <stagingDir>
      Read-only preview of staged diff summary, affected files, test status, and approval state.

Commands (PROPOSAL / VALIDATION):
  generate --project <dir> --product <CODE> [--plan <PLAN>] [--benchmark <CODE>]
           [--pdf-a <template.pdf>] [--pdf-b <reference.pdf>] [--no-ai] [--fixture]
      Analyze PDF A (+ PDF B), diff against benchmark, run Report Test Harness & DiagnosisAgent,
      and write staged artifacts into output/<CODE>/ (never writes into target project).

  test --generated <stagingDir>
      Inspect staged test-results.json and validation-report.json status.

Commands (MUTATION — EXPLICIT APPROVAL REQUIRED):
  approve --generated <stagingDir> --by <reviewer> [--reject] [--notes <text>] [--override-warnings]
      Record explicit human approval or rejection into <stagingDir>/approval.json.

  insert --project <dir> --generated <stagingDir> (--dry-run | --confirm) [--allow-overwrite]
      Verify approval + SHA-256 hashes, check collisions, backup targets, and copy artifacts.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
  }

  const config = loadConfig();
  const logger = new StructuredLogger(false);

  if (cmd === 'tools') {
    const category = getArg(argv, '--category')?.toUpperCase();
    const list = category
      ? MCP_TOOL_CATALOG.filter((t) => t.category === category)
      : MCP_TOOL_CATALOG;
    console.log(JSON.stringify({ tools: list }, null, 2));
    return;
  }

  if (cmd === 'tech-profile') {
    const projectDir = getArg(argv, '--project') || 'samples/SampleProposalProject';
    const orch = new ProposalOrchestrator(config, false);
    const profile = orch.detectTechnology(projectDir);
    console.log(JSON.stringify(profile, null, 2));
    return;
  }

  if (cmd === 'catalog') {
    const projectDir = getArg(argv, '--project') || 'samples/SampleProposalProject';
    const orch = new ProposalOrchestrator(config, false);
    const catalog = orch.buildCatalog(projectDir);
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }

  if (cmd === 'scan') {
    const projectDir = getArg(argv, '--project') || 'samples/SampleProposalProject';
    const orch = new ProposalOrchestrator(config, false);
    const result = orch.scanProject(projectDir);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'inspect') {
    const projectDir = getArg(argv, '--project') || 'samples/SampleProposalProject';
    const productCode = getArg(argv, '--product');
    if (!productCode) {
      console.error('inspect requires --product <CODE>');
      process.exit(1);
    }
    const orch = new ProposalOrchestrator(config, false);
    const scan = orch.scanProject(projectDir);
    const entry = scan.products.find(
      (p) => p.productCode.toUpperCase() === productCode.trim().toUpperCase()
    );
    if (!entry) {
      console.error(`Product "${productCode}" not found in ${projectDir}`);
      process.exit(1);
    }
    const inspector = new BenchmarkInspector(logger);
    const cacheDir = path.resolve(process.cwd(), '.reportgen-cache', 'benchmarks');
    const details = inspector.inspect(entry, cacheDir);
    const compact = {
      ...details,
      rawBuilderSource: undefined,
      rawElementSource: undefined,
      rawElementSources: undefined,
      rawLayoutXml: undefined,
      rawLayoutXmls: undefined,
    };
    console.log(
      JSON.stringify(wrapUntrustedData('mixed_project', `${projectDir}:${entry.productCode}`, compact), null, 2)
    );
    return;
  }

  if (cmd === 'preview') {
    const stagingDir = path.resolve(getArg(argv, '--generated') || '');
    if (!stagingDir || !fs.existsSync(stagingDir)) {
      console.error(`Staging directory not found: ${stagingDir}`);
      process.exit(1);
    }
    const readJson = (rel: string) => {
      const full = path.join(stagingDir, rel);
      return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf-8')) : null;
    };
    const modPlan = readJson('modification-plan.json');
    const tests = readJson('test-results.json');
    const validation = readJson('validation-report.json');
    const approval = readJson('approval.json');
    console.log(
      JSON.stringify(
        wrapUntrustedData('mixed_project', stagingDir, {
          stagingDir,
          approvalStatus: approval?.status ?? 'MISSING',
          overallTestStatus: tests?.overallStatus ?? 'UNKNOWN',
          rdlcValid: validation?.valid ?? false,
          rdlcSchemaVersion: modPlan?.rdlcSchemaVersion,
          diffSummary: modPlan?.diffReport ?? null,
          changesCount: Array.isArray(modPlan?.changes) ? modPlan.changes.length : 0,
        }),
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'generate') {
    const projectDir = getArg(argv, '--project') || 'samples/SampleProposalProject';
    const productCode = getArg(argv, '--product') || 'EGA';
    const planCode = getArg(argv, '--plan') || `${productCode}-EXEC-2026`;
    const benchmarkCode = getArg(argv, '--benchmark');
    const pdfAPath = getArg(argv, '--pdf-a');
    const pdfBPath = getArg(argv, '--pdf-b');
    const useFixture = hasFlag(argv, '--fixture') || !pdfAPath;
    const useAi = !hasFlag(argv, '--no-ai');

    const pdfABytes = useFixture
      ? await buildProposalTemplatePdfA()
      : new Uint8Array(fs.readFileSync(path.resolve(pdfAPath!)));
    const pdfAFileName = pdfAPath ? path.basename(pdfAPath) : `${productCode}-Template-PDFA.pdf`;

    const pdfBBytes = pdfBPath
      ? new Uint8Array(fs.readFileSync(path.resolve(pdfBPath)))
      : useFixture
      ? await buildReferenceSystemPdfB()
      : undefined;
    const pdfBFileName = pdfBPath ? path.basename(pdfBPath) : useFixture ? 'Reference-System-PDFB.pdf' : undefined;

    const orch = new ProposalOrchestrator(config, true);
    const run = await orch.runAdaptation({
      projectRoot: projectDir,
      productCode,
      planCode,
      benchmarkProductCode: benchmarkCode,
      pdfABytes,
      pdfAFileName,
      pdfBBytes,
      pdfBFileName,
      useAi,
    });

    console.log(
      JSON.stringify(
        {
          productCode: run.productCode,
          benchmark: run.benchmarkProductCode,
          stagingDir: run.staging.stagingDir,
          overallTestStatus: run.testHarness.overallStatus,
          approvalStatus: run.staging.approval.status,
          changesCount: run.proposalDefinition.changes.length,
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === 'test') {
    const stagingDir = path.resolve(getArg(argv, '--generated') || '');
    const testPath = path.join(stagingDir, 'test-results.json');
    if (!fs.existsSync(testPath)) {
      console.error(`Missing test-results.json in ${stagingDir}`);
      process.exit(1);
    }
    console.log(fs.readFileSync(testPath, 'utf-8'));
    return;
  }

  if (cmd === 'approve') {
    const stagingDir = path.resolve(getArg(argv, '--generated') || '');
    const by = getArg(argv, '--by') || 'cli-reviewer';
    const reject = hasFlag(argv, '--reject');
    const overrideWarnings = hasFlag(argv, '--override-warnings');
    const notes = getArg(argv, '--notes');

    const manager = new StagingManager(logger);
    const approval = manager.approveStaging({
      stagingDir,
      approvedBy: by,
      decision: reject ? 'REJECTED' : 'APPROVED',
      policyOverrideWarnings: overrideWarnings,
      notes,
    });
    console.log(JSON.stringify(approval, null, 2));
    return;
  }

  if (cmd === 'insert') {
    const projectDir = getArg(argv, '--project');
    const stagingDir = getArg(argv, '--generated');
    const dryRun = hasFlag(argv, '--dry-run');
    const confirm = hasFlag(argv, '--confirm');
    const allowOverwrite = hasFlag(argv, '--allow-overwrite');

    if (!projectDir || !stagingDir) {
      console.error('insert requires --project <dir> and --generated <stagingDir>');
      process.exit(1);
    }
    if (!dryRun && !confirm) {
      console.error('insert requires either --dry-run or explicit --confirm');
      process.exit(1);
    }

    const inserter = new ProjectInserter(logger);
    if (dryRun) {
      const plan = inserter.dryRun(projectDir, stagingDir, allowOverwrite);
      console.log(JSON.stringify(plan, null, 2));
      if (!plan.canInsert) process.exit(1);
      return;
    }

    const manifest = inserter.insert(projectDir, stagingDir, {
      confirm: true,
      allowOverwrite,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
