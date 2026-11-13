import fs from 'fs';
import path from 'path';
import { ReportGenConfig, resolveSafeSubpath } from '../core/config.ts';
import { ReportGenError, ReportGenErrorCode, StructuredLogger } from '../core/types.ts';

export interface ProjectWriteRequest {
  projectRoot: string;
  relativeOutputDir: string;
  reportName: string;
  force: boolean;
  files: {
    rdlcXml: string;
    vbCode: string;
    dummyJson: string;
    reportDefinitionJson: string;
  };
}

export interface ProjectWriteResult {
  targetDirectory: string;
  writtenFiles: string[];
  skippedFiles: string[];
}

export class ProjectIntegrator {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public writeArtifacts(req: ProjectWriteRequest, _config: ReportGenConfig): ProjectWriteResult {
    const resolvedProjectRoot = path.resolve(req.projectRoot);
    const targetDir = resolveSafeSubpath(resolvedProjectRoot, req.relativeOutputDir);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const safeName = req.reportName.replace(/[^A-Za-z0-9_-]/g, '') || 'GeneratedReport';
    const artifactMap: Array<{ fileName: string; content: string }> = [
      { fileName: `${safeName}.rdlc`, content: req.files.rdlcXml },
      { fileName: `${safeName}.vb`, content: req.files.vbCode },
      { fileName: 'dummy.json', content: req.files.dummyJson },
      { fileName: 'report-definition.json', content: req.files.reportDefinitionJson },
    ];

    const writtenFiles: string[] = [];
    const skippedFiles: string[] = [];

    for (const item of artifactMap) {
      const fullPath = resolveSafeSubpath(targetDir, item.fileName);
      if (fs.existsSync(fullPath) && !req.force) {
        throw new ReportGenError(
          ReportGenErrorCode.PROJECT_INTEGRATION_FAILED,
          `Refusing to overwrite existing file "${fullPath}" without --force`
        );
      }
      fs.writeFileSync(fullPath, item.content, 'utf-8');
      writtenFiles.push(fullPath);
    }

    this.logger.info('ProjectIntegration', `Wrote ${writtenFiles.length} artifact(s) to ${targetDir}`, {
      force: req.force,
    });

    return {
      targetDirectory: targetDir,
      writtenFiles,
      skippedFiles,
    };
  }
}
