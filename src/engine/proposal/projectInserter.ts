import fs from 'fs';
import path from 'path';
import { StructuredLogger } from '../core/types.ts';
import { sanitizeProductCode, sha256File } from './stagingManager.ts';
import {
  InsertDryRunPlan,
  InsertManifest,
  IProjectInserter,
  ProposalDefinition,
  StagingApprovalState,
} from './types.ts';

function findProjectFile(projectRoot: string): string | undefined {
  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.(vbproj|csproj)$/i.test(entry.name)) {
      return path.join(projectRoot, entry.name);
    }
  }
  return undefined;
}

function resolveProductTargetDir(projectRoot: string, productCode: string): string {
  const proposalBase = fs.existsSync(path.join(projectRoot, 'Proposal'))
    ? path.join(projectRoot, 'Proposal')
    : projectRoot;
  return path.join(proposalBase, productCode);
}

function addItemsToProjectXml(
  xml: string,
  vbRelPaths: string[],
  rdlcRelPaths: string[]
): { updatedXml: string; changed: boolean } {
  // SDK-style .NET projects include **/*.vb automatically; still skip duplicating if already listed
  const missingVb = vbRelPaths.filter((p) => !xml.includes(p));
  const missingRdlc = rdlcRelPaths.filter((p) => !xml.includes(p));

  if (missingVb.length === 0 && missingRdlc.length === 0) {
    return { updatedXml: xml, changed: false };
  }

  const lines: string[] = ['  <ItemGroup>'];
  for (const vb of missingVb) {
    lines.push(`    <Compile Include="${vb}" />`);
  }
  for (const rdlc of missingRdlc) {
    lines.push(`    <EmbeddedResource Include="${rdlc}" />`);
  }
  lines.push('  </ItemGroup>');
  const snippet = lines.join('\n');

  const closeTagIdx = xml.lastIndexOf('</Project>');
  if (closeTagIdx === -1) {
    return { updatedXml: xml, changed: false };
  }

  const updatedXml = `${xml.slice(0, closeTagIdx)}${snippet}\n${xml.slice(closeTagIdx)}`;
  return { updatedXml, changed: true };
}

export class ProjectInserter implements IProjectInserter {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public dryRun(
    projectRoot: string,
    stagingDir: string,
    allowOverwrite = false
  ): InsertDryRunPlan {
    const resolvedRoot = path.resolve(projectRoot);
    const resolvedStaging = path.resolve(stagingDir);
    const blockingReasons: string[] = [];

    if (!fs.existsSync(resolvedRoot)) {
      blockingReasons.push(`Target project root does not exist: ${resolvedRoot}`);
    }
    if (!fs.existsSync(resolvedStaging)) {
      blockingReasons.push(`Staging directory does not exist: ${resolvedStaging}`);
    }

    const approvalPath = path.join(resolvedStaging, 'approval.json');
    const defPath = path.join(resolvedStaging, 'proposal-definition.json');
    const testPath = path.join(resolvedStaging, 'test-results.json');

    let productCode = path.basename(resolvedStaging).toUpperCase();
    let approval: StagingApprovalState | null = null;

    if (fs.existsSync(defPath)) {
      const def = JSON.parse(fs.readFileSync(defPath, 'utf-8')) as ProposalDefinition;
      productCode = sanitizeProductCode(def.productCode);
    }

    if (!fs.existsSync(approvalPath)) {
      blockingReasons.push('Missing approval.json in staging directory.');
    } else {
      approval = JSON.parse(fs.readFileSync(approvalPath, 'utf-8')) as StagingApprovalState;
      productCode = sanitizeProductCode(approval.productCode);
      if (approval.status !== 'APPROVED') {
        blockingReasons.push(`Staging approval status is "${approval.status}" (must be "APPROVED").`);
      }
    }

    if (!fs.existsSync(testPath)) {
      blockingReasons.push('Missing test-results.json in staging directory.');
    } else {
      const tests = JSON.parse(fs.readFileSync(testPath, 'utf-8')) as {
        overallStatus: string;
        fatalErrors: string[];
      };
      if (tests.fatalErrors && tests.fatalErrors.length > 0) {
        blockingReasons.push(
          `Test harness has ${tests.fatalErrors.length} fatal error(s): ${tests.fatalErrors.join('; ')}`
        );
      }
    }

    const primaryLayoutName = `${productCode}ProposalLayout.rdlc`;
    const sourceFiles: Array<{ src: string; name: string; expectedHash?: string }> = [
      {
        src: path.join(resolvedStaging, `${productCode}ProposalBuilder.vb`),
        name: `${productCode}ProposalBuilder.vb`,
        expectedHash: approval?.artifactHashes.builderSha256,
      },
      {
        src: path.join(resolvedStaging, `${productCode}ProposalElement.vb`),
        name: `${productCode}ProposalElement.vb`,
        expectedHash: approval?.artifactHashes.elementSha256,
      },
      {
        src: path.join(resolvedStaging, primaryLayoutName),
        name: primaryLayoutName,
        expectedHash: approval?.artifactHashes.layoutSha256,
      },
    ];

    const extraRdlcEntries = Object.entries(approval?.artifactHashes.additionalRdlcHashes ?? {});
    if (extraRdlcEntries.length > 0) {
      for (const [extraName, expectedHash] of extraRdlcEntries) {
        const safeName = path.basename(extraName);
        if (safeName !== primaryLayoutName) {
          sourceFiles.push({
            src: path.join(resolvedStaging, safeName),
            name: safeName,
            expectedHash,
          });
        }
      }
    } else if (fs.existsSync(resolvedStaging)) {
      for (const entry of fs.readdirSync(resolvedStaging, { withFileTypes: true })) {
        if (entry.isFile() && /\.rdlc$/i.test(entry.name) && entry.name !== primaryLayoutName) {
          sourceFiles.push({
            src: path.join(resolvedStaging, entry.name),
            name: entry.name,
          });
        }
      }
    }

    const targetDir = resolveProductTargetDir(resolvedRoot, productCode);
    const collisions: InsertDryRunPlan['collisions'] = [];
    const wouldAdd: InsertDryRunPlan['wouldAdd'] = [];

    for (const sf of sourceFiles) {
      if (!fs.existsSync(sf.src)) {
        blockingReasons.push(`Missing staged artifact: ${sf.name}`);
        continue;
      }
      const actualHash = sha256File(sf.src);
      if (sf.expectedHash && actualHash !== sf.expectedHash) {
        blockingReasons.push(`Hash mismatch on staged file ${sf.name}; re-approve before inserting.`);
      }
      const targetPath = path.join(targetDir, sf.name);
      const exists = fs.existsSync(targetPath);
      if (exists) {
        collisions.push({ targetPath, exists: true });
        if (!allowOverwrite) {
          blockingReasons.push(
            `Target collision at ${targetPath} (re-run with --allow-overwrite to overwrite after backup).`
          );
        }
      }
      wouldAdd.push({ source: sf.src, target: targetPath, sha256: actualHash });
    }

    const wouldModify: InsertDryRunPlan['wouldModify'] = [];
    const projectFile = fs.existsSync(resolvedRoot) ? findProjectFile(resolvedRoot) : undefined;
    if (projectFile) {
      const xml = fs.readFileSync(projectFile, 'utf-8');
      const vbRels = sourceFiles
        .filter((f) => f.name.endsWith('.vb'))
        .map((f) => path.relative(resolvedRoot, path.join(targetDir, f.name)).replace(/\//g, '\\'));
      const rdlcRels = sourceFiles
        .filter((f) => f.name.endsWith('.rdlc'))
        .map((f) => path.relative(resolvedRoot, path.join(targetDir, f.name)).replace(/\//g, '\\'));
      const sim = addItemsToProjectXml(xml, vbRels, rdlcRels);
      if (sim.changed) {
        wouldModify.push({
          target: projectFile,
          reason: 'Register new <Compile> and <EmbeddedResource> entries in .vbproj/.csproj.',
        });
      }
    }

    return {
      productCode,
      targetProjectRoot: resolvedRoot,
      stagingDir: resolvedStaging,
      canInsert: blockingReasons.length === 0,
      blockingReasons,
      collisions,
      wouldAdd,
      wouldModify,
    };
  }

  public insert(
    projectRoot: string,
    stagingDir: string,
    options: { confirm: boolean; allowOverwrite?: boolean }
  ): InsertManifest {
    const plan = this.dryRun(projectRoot, stagingDir, Boolean(options.allowOverwrite));
    const def = JSON.parse(
      fs.readFileSync(path.join(plan.stagingDir, 'proposal-definition.json'), 'utf-8')
    ) as ProposalDefinition;
    const approval = JSON.parse(
      fs.readFileSync(path.join(plan.stagingDir, 'approval.json'), 'utf-8')
    ) as StagingApprovalState;
    const tests = JSON.parse(
      fs.readFileSync(path.join(plan.stagingDir, 'test-results.json'), 'utf-8')
    ) as { overallStatus: 'PASS' | 'WARN' | 'FAIL'; warnings: string[] };

    if (!options.confirm) {
      return {
        operation: 'INSERT',
        productCode: plan.productCode,
        planCode: def.planCode,
        benchmark: def.benchmarkProductCode,
        timestamp: new Date().toISOString(),
        dryRun: true,
        status: plan.canInsert ? 'SUCCESS' : 'ABORTED',
        approval,
        validationStatus: tests.overallStatus,
        files: [],
        modifiedFiles: [],
        warnings: [...plan.blockingReasons, ...(tests.warnings ?? [])],
      };
    }

    if (!plan.canInsert) {
      throw new Error(`Insert aborted: ${plan.blockingReasons.join(' | ')}`);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(plan.targetProjectRoot, '.reportgen-backup', `${stamp}-${plan.productCode}`);
    fs.mkdirSync(backupDir, { recursive: true });

    const backedUpTargets: Array<{ originalPath: string; backupPath: string; existed: boolean }> = [];
    const insertedFiles: InsertManifest['files'] = [];
    const modifiedFiles: InsertManifest['modifiedFiles'] = [];

    try {
      // 1. Backup existing colliding files & project file BEFORE mutating anything
      for (const item of plan.wouldAdd) {
        const existed = fs.existsSync(item.target);
        if (existed) {
          const bkp = path.join(backupDir, path.basename(item.target));
          fs.copyFileSync(item.target, bkp);
          backedUpTargets.push({ originalPath: item.target, backupPath: bkp, existed: true });
        } else {
          backedUpTargets.push({ originalPath: item.target, backupPath: '', existed: false });
        }
      }

      for (const mod of plan.wouldModify) {
        const bkp = path.join(backupDir, path.basename(mod.target));
        fs.copyFileSync(mod.target, bkp);
        backedUpTargets.push({ originalPath: mod.target, backupPath: bkp, existed: true });
      }

      // 2. Copy staged artifacts into target product folder & verify post-copy hashes
      for (const item of plan.wouldAdd) {
        fs.mkdirSync(path.dirname(item.target), { recursive: true });
        const existedBefore = fs.existsSync(item.target);
        fs.copyFileSync(item.source, item.target);
        const copiedHash = sha256File(item.target);
        if (copiedHash !== item.sha256) {
          throw new Error(`Post-copy SHA-256 verification failed for ${item.target}`);
        }
        insertedFiles.push({
          source: path.relative(process.cwd(), item.source),
          target: item.target,
          sha256: copiedHash,
          action: existedBefore ? 'OVERWRITTEN' : 'ADDED',
        });
      }

      // 3. Safely update .vbproj/.csproj if needed
      for (const mod of plan.wouldModify) {
        const beforeHash = sha256File(mod.target);
        const xml = fs.readFileSync(mod.target, 'utf-8');
        const vbRels = plan.wouldAdd
          .filter((a) => a.target.endsWith('.vb'))
          .map((a) => path.relative(plan.targetProjectRoot, a.target).replace(/\//g, '\\'));
        const rdlcRels = plan.wouldAdd
          .filter((a) => a.target.endsWith('.rdlc'))
          .map((a) => path.relative(plan.targetProjectRoot, a.target).replace(/\//g, '\\'));

        const { updatedXml, changed } = addItemsToProjectXml(xml, vbRels, rdlcRels);
        if (changed) {
          fs.writeFileSync(mod.target, updatedXml, 'utf-8');
        }
        const afterHash = sha256File(mod.target);
        modifiedFiles.push({
          target: mod.target,
          backupPath: path.join(backupDir, path.basename(mod.target)),
          beforeSha256: beforeHash,
          afterSha256: afterHash,
        });
      }

      const manifest: InsertManifest = {
        operation: 'INSERT',
        productCode: plan.productCode,
        planCode: def.planCode,
        benchmark: def.benchmarkProductCode,
        timestamp: new Date().toISOString(),
        dryRun: false,
        status: 'SUCCESS',
        approval,
        validationStatus: tests.overallStatus,
        backupDirectory: backupDir,
        files: insertedFiles,
        modifiedFiles,
        warnings: tests.warnings ?? [],
      };

      fs.writeFileSync(
        path.join(plan.stagingDir, 'insert-manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(backupDir, 'insert-manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      this.logger.info('ProjectInserter', `Inserted ${plan.productCode} artifacts safely into project`, {
        targetProjectRoot: plan.targetProjectRoot,
        filesCopied: insertedFiles.length,
        backupDir,
      });

      return manifest;
    } catch (err) {
      // Automatic rollback from backup on any mid-flight failure
      for (const b of backedUpTargets) {
        try {
          if (b.existed && b.backupPath && fs.existsSync(b.backupPath)) {
            fs.copyFileSync(b.backupPath, b.originalPath);
          } else if (!b.existed && fs.existsSync(b.originalPath)) {
            fs.unlinkSync(b.originalPath);
          }
        } catch {
          // Best-effort rollback per file
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('ProjectInserter', `Insert failed and rolled back cleanly: ${msg}`);
      throw new Error(`Insert failed and rolled back cleanly: ${msg}`);
    }
  }
}
