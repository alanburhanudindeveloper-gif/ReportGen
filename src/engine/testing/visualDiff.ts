import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import {
  RenderStatus,
  StructuredLogger,
  VisualDiffPageResult,
  VisualDiffReport,
} from '../core/types.ts';

const execFileAsync = promisify(execFile);

export class ReportViewerRenderer {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public async renderToPdf(rdlcPathOrXml: string, outputPdfPath?: string): Promise<RenderStatus> {
    try {
      await execFileAsync('which', ['dotnet']);
    } catch {
      const msg = 'Rendering not verified in this environment.';
      this.logger.warn('Render', `${msg} (dotnet / Microsoft ReportViewer unavailable)`);
      return {
        executed: false,
        engine: 'Unavailable',
        status: 'NOT_VERIFIED_IN_ENVIRONMENT',
        message: msg,
      };
    }

    // If dotnet exists on a host machine, check for configured external ReportViewer runner
    const runnerPath = process.env.REPORTVIEWER_CLI_PATH;
    if (!runnerPath || !fs.existsSync(runnerPath)) {
      const msg = 'Rendering not verified in this environment.';
      this.logger.warn('Render', `${msg} (REPORTVIEWER_CLI_PATH not configured)`);
      return {
        executed: false,
        engine: 'Unavailable',
        status: 'NOT_VERIFIED_IN_ENVIRONMENT',
        message: msg,
      };
    }

    const outPdf = outputPdfPath ?? path.join(os.tmpdir(), `rendered-${Date.now()}.pdf`);
    await execFileAsync('dotnet', [runnerPath, rdlcPathOrXml, outPdf]);
    this.logger.info('Render', 'Render completed via ReportViewer', { outPdf });
    return {
      executed: true,
      engine: 'ReportViewer',
      status: 'RENDERED',
      message: 'RDLC rendered to PDF via ReportViewer.',
      renderedPdfPath: outPdf,
    };
  }
}

export class VisualDiffEngine {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public async comparePdfs(
    originalPdfBytes: Uint8Array,
    generatedPdfBytes: Uint8Array,
    targetSimilarity = 0.95,
    outputDir?: string,
    dpi = 120
  ): Promise<VisualDiffReport> {
    const origPngs = await this.rasterize(originalPdfBytes, dpi);
    const genPngs = await this.rasterize(generatedPdfBytes, dpi);

    if (origPngs.length === 0 || genPngs.length === 0) {
      return {
        available: false,
        targetSimilarity,
        overallSimilarity: 0,
        note: 'Ghostscript rasterization returned no pages for visual diff.',
        pages: [],
      };
    }

    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const pageCount = Math.max(origPngs.length, genPngs.length);
    const pages: VisualDiffPageResult[] = [];

    for (let i = 0; i < pageCount; i++) {
      const aBuf = origPngs[i];
      const bBuf = genPngs[i];
      if (!aBuf || !bBuf) {
        pages.push({
          page: i + 1,
          similarity: 0,
          mismatchPixels: 0,
          totalPixels: 0,
        });
        continue;
      }

      const imgA = PNG.sync.read(aBuf);
      const imgB = PNG.sync.read(bBuf);

      const width = Math.min(imgA.width, imgB.width);
      const height = Math.min(imgA.height, imgB.height);

      // Crop both to overlapping bounds cleanly if dimensions differ slightly
      const croppedA = this.cropPng(imgA, width, height);
      const croppedB = this.cropPng(imgB, width, height);
      const diff = new PNG({ width, height });

      const mismatchPixels = pixelmatch(croppedA.data, croppedB.data, diff.data, width, height, {
        threshold: 0.12,
      });

      const totalPixels = width * height;
      const similarity = Math.round((1 - mismatchPixels / totalPixels) * 10000) / 10000;
      const diffBuf = PNG.sync.write(diff);

      if (outputDir) {
        fs.writeFileSync(
          path.join(outputDir, `page-${String(i + 1).padStart(2, '0')}-diff.png`),
          diffBuf
        );
      }

      pages.push({
        page: i + 1,
        similarity,
        mismatchPixels,
        totalPixels,
        diffImageBase64: diffBuf.toString('base64'),
        originalImageBase64: aBuf.toString('base64'),
        comparedImageBase64: bBuf.toString('base64'),
      });
    }

    const overallSimilarity =
      pages.length > 0
        ? Math.round((pages.reduce((s, p) => s + p.similarity, 0) / pages.length) * 10000) / 10000
        : 0;

    const report: VisualDiffReport = {
      available: true,
      targetSimilarity,
      overallSimilarity,
      note: `Computed genuine pixel-by-pixel similarity across ${pages.length} page(s).`,
      pages,
    };

    if (outputDir) {
      const cleanReport = {
        overallSimilarity: report.overallSimilarity,
        targetSimilarity: report.targetSimilarity,
        pages: report.pages.map((p) => ({
          page: p.page,
          similarity: p.similarity,
          mismatchPixels: p.mismatchPixels,
          totalPixels: p.totalPixels,
        })),
      };
      fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(cleanReport, null, 2), 'utf-8');
    }

    this.logger.info('VisualDiff', `Visual similarity: ${(overallSimilarity * 100).toFixed(2)}%`, {
      pages: pages.length,
    });

    return report;
  }

  private cropPng(src: PNG, width: number, height: number): PNG {
    if (src.width === width && src.height === height) return src;
    const dst = new PNG({ width, height });
    PNG.bitblt(src, dst, 0, 0, width, height, 0, 0);
    return dst;
  }

  private async rasterize(pdfBytes: Uint8Array, dpi: number): Promise<Buffer[]> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportgen-diff-'));
    const inPdf = path.join(tmpDir, 'doc.pdf');
    const outPattern = path.join(tmpDir, 'p-%03d.png');
    try {
      fs.writeFileSync(inPdf, pdfBytes);
      await execFileAsync('gs', [
        '-dNOPAUSE',
        '-dBATCH',
        '-sDEVICE=png16m',
        `-r${dpi}`,
        `-sOutputFile=${outPattern}`,
        inPdf,
      ]);
      return fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('p-') && f.endsWith('.png'))
        .sort()
        .map((f) => fs.readFileSync(path.join(tmpDir, f)));
    } catch {
      return [];
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
