import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveSafeSubpath } from '../core/config.ts';
import { StructuredLogger } from '../core/types.ts';
import {
  BenchmarkAnalysis,
  MinimalMutationReport,
  ProjectScanResult,
  ProposalDefinition,
  ReferenceDataExtract,
  ReportTestHarnessResult,
  SampleScenarioDataset,
  StagingApprovalState,
  StagingWorkspaceSummary,
  TechnologyProfile,
  TemplateAnalysis,
} from './types.ts';

export function sha256Text(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function sanitizeProductCode(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
  if (!cleaned) {
    throw new Error(`Invalid productCode "${raw}"`);
  }
  return cleaned;
}

export class StagingManager {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public getStagingDir(baseOutputRoot: string, productCode: string): string {
    const safeCode = sanitizeProductCode(productCode);
    return resolveSafeSubpath(baseOutputRoot, safeCode);
  }

  public writeStaging(input: {
    baseOutputRoot: string;
    productCode: string;
    builderVbCode: string;
    elementVbCode: string;
    layoutRdlcXml: string;
    additionalRdlcFiles?: Array<{ fileName: string; xml: string }>;
    diffReport?: MinimalMutationReport;
    sampleScenarios?: SampleScenarioDataset[];
    proposalDefinition: ProposalDefinition;
    pdfAAnalysis: TemplateAnalysis;
    benchmarkAnalysis: BenchmarkAnalysis;
    technologyProfile?: TechnologyProfile;
    scanResult?: ProjectScanResult;
    referenceExtract?: ReferenceDataExtract;
    testHarness: ReportTestHarnessResult;
    dummyDataJson: Record<string, unknown>;
  }): StagingWorkspaceSummary {
    const prod = sanitizeProductCode(input.productCode);
    fs.mkdirSync(input.baseOutputRoot, { recursive: true });
    const stagingDir = this.getStagingDir(input.baseOutputRoot, prod);
    fs.mkdirSync(stagingDir, { recursive: true });

    // Create structured staging workspace subfolders alongside root files
    const subdirs = ['analysis', 'decision', 'generated', 'test', 'insert'] as const;
    for (const sd of subdirs) {
      fs.mkdirSync(path.join(stagingDir, sd), { recursive: true });
    }

    const builderFile = path.join(stagingDir, `${prod}ProposalBuilder.vb`);
    const elementFile = path.join(stagingDir, `${prod}ProposalElement.vb`);
    const layoutFile = path.join(stagingDir, `${prod}ProposalLayout.rdlc`);
    const proposalDefinitionFile = path.join(stagingDir, 'proposal-definition.json');
    const templateAnalysisFile = path.join(stagingDir, 'template-analysis.json');
    const benchmarkAnalysisFile = path.join(stagingDir, 'benchmark-analysis.json');
    const modificationPlanFile = path.join(stagingDir, 'modification-plan.json');
    const dummyDataFile = path.join(stagingDir, 'dummy-data.json');
    const validationReportFile = path.join(stagingDir, 'validation-report.json');
    const testResultsFile = path.join(stagingDir, 'test-results.json');
    const visualComparisonFile = path.join(stagingDir, 'visual-comparison.json');
    const approvalFile = path.join(stagingDir, 'approval.json');

    fs.writeFileSync(builderFile, input.builderVbCode, 'utf-8');
    fs.writeFileSync(elementFile, input.elementVbCode, 'utf-8');
    fs.writeFileSync(layoutFile, input.layoutRdlcXml, 'utf-8');

    // Mirror generated files under generated/
    fs.writeFileSync(path.join(stagingDir, 'generated', `${prod}ProposalBuilder.vb`), input.builderVbCode, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'generated', `${prod}ProposalElement.vb`), input.elementVbCode, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'generated', `${prod}ProposalLayout.rdlc`), input.layoutRdlcXml, 'utf-8');

    const additionalRdlcFiles: string[] = [];
    const additionalRdlcHashes: Record<string, string> = {};
    for (const extra of input.additionalRdlcFiles ?? []) {
      const safeName = path.basename(extra.fileName);
      const extraPath = path.join(stagingDir, safeName);
      fs.writeFileSync(extraPath, extra.xml, 'utf-8');
      fs.writeFileSync(path.join(stagingDir, 'generated', safeName), extra.xml, 'utf-8');
      additionalRdlcFiles.push(extraPath);
      additionalRdlcHashes[safeName] = sha256File(extraPath);
    }

    const defJsonStr = JSON.stringify(input.proposalDefinition, null, 2);
    fs.writeFileSync(proposalDefinitionFile, defJsonStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'decision', 'proposal-definition.json'), defJsonStr, 'utf-8');

    const slimTemplate: TemplateAnalysis = {
      ...input.pdfAAnalysis,
      layoutModel: {
        ...input.pdfAAnalysis.layoutModel,
        pages: input.pdfAAnalysis.layoutModel.pages.map((p) => ({
          ...p,
          rasterPreviewBase64: undefined,
          regions: p.regions.map((r) => ({
            ...r,
            imageAssetBase64: r.imageAssetBase64 ? '[embedded-image]' : undefined,
          })),
        })),
      },
    };
    const templateStr = JSON.stringify(slimTemplate, null, 2);
    fs.writeFileSync(templateAnalysisFile, templateStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'analysis', 'template-analysis.json'), templateStr, 'utf-8');

    const slimBenchmark: BenchmarkAnalysis = {
      ...input.benchmarkAnalysis,
      rawBuilderSource: undefined,
      rawElementSource: undefined,
      rawElementSources: undefined,
      rawLayoutXml: undefined,
      rawLayoutXmls: undefined,
    };
    const benchStr = JSON.stringify(slimBenchmark, null, 2);
    fs.writeFileSync(benchmarkAnalysisFile, benchStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'analysis', 'benchmark-analysis.json'), benchStr, 'utf-8');

    const technologyProfileFile = path.join(stagingDir, 'analysis', 'technology-profile.json');
    if (input.technologyProfile) {
      fs.writeFileSync(
        technologyProfileFile,
        JSON.stringify(input.technologyProfile, null, 2),
        'utf-8'
      );
    }

    const projectAnalysisFile = path.join(stagingDir, 'analysis', 'project-analysis.json');
    if (input.scanResult) {
      fs.writeFileSync(
        projectAnalysisFile,
        JSON.stringify(input.scanResult, null, 2),
        'utf-8'
      );
    }

    const modPlanStr = JSON.stringify(
      {
        productCode: prod,
        benchmarkProductCode: input.benchmarkAnalysis.productCode,
        rdlcSchemaVersion: input.proposalDefinition.rdlcSchemaVersion,
        confidenceSummary: input.proposalDefinition.confidenceSummary,
        diffReport: input.diffReport ?? null,
        changes: input.proposalDefinition.changes,
      },
      null,
      2
    );
    fs.writeFileSync(modificationPlanFile, modPlanStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'decision', 'modification-plan.json'), modPlanStr, 'utf-8');

    const dummyStr = JSON.stringify(
      {
        dummyData: input.dummyDataJson,
        referenceExtract: input.referenceExtract ?? null,
        bindings: input.proposalDefinition.dataBindings,
        scenarios: input.sampleScenarios ?? input.proposalDefinition.sampleScenarios ?? [],
      },
      null,
      2
    );
    fs.writeFileSync(dummyDataFile, dummyStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'test', 'dummy-data.json'), dummyStr, 'utf-8');

    const valStr = JSON.stringify(input.testHarness.rdlcValidation, null, 2);
    fs.writeFileSync(validationReportFile, valStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'test', 'validation-report.json'), valStr, 'utf-8');

    const testStr = JSON.stringify(
      {
        overallStatus: input.testHarness.overallStatus,
        executedAt: input.testHarness.executedAt,
        checks: input.testHarness.checks,
        warnings: input.testHarness.warnings,
        fatalErrors: input.testHarness.fatalErrors,
        renderStatus: input.testHarness.renderStatus,
        diagnosisHistory: input.testHarness.diagnosisHistory,
      },
      null,
      2
    );
    fs.writeFileSync(testResultsFile, testStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'test', 'test-results.json'), testStr, 'utf-8');

    const visualPayload = input.testHarness.visualDiff
      ? {
          available: input.testHarness.visualDiff.available,
          targetSimilarity: input.testHarness.visualDiff.targetSimilarity,
          overallSimilarity: input.testHarness.visualDiff.overallSimilarity,
          note: input.testHarness.visualDiff.note,
          pages: input.testHarness.visualDiff.pages.map((p) => ({
            page: p.page,
            similarity: p.similarity,
            mismatchPixels: p.mismatchPixels,
            totalPixels: p.totalPixels,
          })),
        }
      : {
          available: false,
          note: input.testHarness.renderStatus.message,
          pages: [],
        };
    const visualStr = JSON.stringify(visualPayload, null, 2);
    fs.writeFileSync(visualComparisonFile, visualStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'test', 'visual-comparison.json'), visualStr, 'utf-8');

    const approval: StagingApprovalState = {
      productCode: prod,
      status: 'PENDING',
      policyOverrideWarnings: false,
      artifactHashes: {
        builderSha256: sha256File(builderFile),
        elementSha256: sha256File(elementFile),
        layoutSha256: sha256File(layoutFile),
        additionalRdlcHashes:
          Object.keys(additionalRdlcHashes).length > 0 ? additionalRdlcHashes : undefined,
      },
    };
    const approvalStr = JSON.stringify(approval, null, 2);
    fs.writeFileSync(approvalFile, approvalStr, 'utf-8');
    fs.writeFileSync(path.join(stagingDir, 'insert', 'approval.json'), approvalStr, 'utf-8');

    this.logger.info('StagingManager', `Wrote structured staged workspace to ${stagingDir}`);

    return {
      stagingDir,
      productCode: prod,
      files: {
        builderFile,
        elementFile,
        layoutFile,
        additionalRdlcFiles,
        proposalDefinitionFile,
        templateAnalysisFile,
        benchmarkAnalysisFile,
        technologyProfileFile: input.technologyProfile ? technologyProfileFile : undefined,
        projectAnalysisFile: input.scanResult ? projectAnalysisFile : undefined,
        modificationPlanFile,
        dummyDataFile,
        validationReportFile,
        testResultsFile,
        visualComparisonFile,
        approvalFile,
      },
      approval,
    };
  }

  public approveStaging(input: {
    stagingDir: string;
    approvedBy: string;
    decision: 'APPROVED' | 'REJECTED';
    policyOverrideWarnings?: boolean;
    notes?: string;
  }): StagingApprovalState {
    const approvalPath = path.join(input.stagingDir, 'approval.json');
    const testResultsPath = path.join(input.stagingDir, 'test-results.json');

    if (!fs.existsSync(approvalPath) || !fs.existsSync(testResultsPath)) {
      throw new Error(`Staging workspace is incomplete at ${input.stagingDir}`);
    }

    const existing = JSON.parse(fs.readFileSync(approvalPath, 'utf-8')) as StagingApprovalState;
    const tests = JSON.parse(fs.readFileSync(testResultsPath, 'utf-8')) as {
      overallStatus: string;
      fatalErrors: string[];
    };

    if (input.decision === 'APPROVED' && tests.fatalErrors && tests.fatalErrors.length > 0) {
      throw new Error(
        `Approval blocked: staged artifacts have ${tests.fatalErrors.length} fatal error(s): ${tests.fatalErrors.join('; ')}`
      );
    }

    const prod = existing.productCode;
    const builderFile = path.join(input.stagingDir, `${prod}ProposalBuilder.vb`);
    const elementFile = path.join(input.stagingDir, `${prod}ProposalElement.vb`);
    const layoutFile = path.join(input.stagingDir, `${prod}ProposalLayout.rdlc`);

    const currentHashes = {
      builderSha256: sha256File(builderFile),
      elementSha256: sha256File(elementFile),
      layoutSha256: sha256File(layoutFile),
      additionalRdlcHashes: existing.artifactHashes.additionalRdlcHashes,
    };

    if (
      currentHashes.builderSha256 !== existing.artifactHashes.builderSha256 ||
      currentHashes.elementSha256 !== existing.artifactHashes.elementSha256 ||
      currentHashes.layoutSha256 !== existing.artifactHashes.layoutSha256
    ) {
      throw new Error(
        'Artifact integrity check failed: staged .vb/.rdlc files changed since staging was created. Re-run staging before approving.'
      );
    }

    const updated: StagingApprovalState = {
      ...existing,
      status: input.decision,
      approvedBy: input.approvedBy || 'reviewer',
      approvedAt: new Date().toISOString(),
      policyOverrideWarnings: Boolean(input.policyOverrideWarnings),
      notes: input.notes,
      artifactHashes: currentHashes,
    };

    const approvalStr = JSON.stringify(updated, null, 2);
    fs.writeFileSync(approvalPath, approvalStr, 'utf-8');
    const insertApprovalPath = path.join(input.stagingDir, 'insert', 'approval.json');
    if (fs.existsSync(path.dirname(insertApprovalPath))) {
      fs.writeFileSync(insertApprovalPath, approvalStr, 'utf-8');
    }
    this.logger.info('StagingManager', `Staging ${input.decision} by ${updated.approvedBy}`, {
      productCode: prod,
    });
    return updated;
  }
}
