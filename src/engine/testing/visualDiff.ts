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

  public async rasterizePdf(pdfBytes: Uint8Array, dpi = 150): Promise<Buffer[]> {
    return this.rasterize(pdfBytes, dpi);
  }

  public async comparePdfs(
    originalPdfBytes: Uint8Array,
    generatedPdfBytes: Uint8Array,
    targetSimilarity = 0.92,
    outputDir?: string,
    dpi = 150
  ): Promise<VisualDiffReport> {
    const origPngs = await this.rasterize(originalPdfBytes, dpi);
    const genPngs = await this.rasterize(generatedPdfBytes, dpi);

    if (origPngs.length === 0 || genPngs.length === 0) {
      return {
        available: false,
        targetSimilarity,
        overallSimilarity: 0,
        overallParityPercent: 0,
        meanAbsoluteError: 255,
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
          parityPercent: 0,
          meanAbsoluteError: 255,
          mismatchPixels: 0,
          totalPixels: 0,
        });
        continue;
      }

      const imgA = PNG.sync.read(aBuf);
      const imgB = PNG.sync.read(bBuf);

      const width = Math.min(imgA.width, imgB.width);
      const height = Math.min(imgA.height, imgB.height);

      const croppedA = this.cropPng(imgA, width, height);
      const croppedB = this.cropPng(imgB, width, height);
      const diff = new PNG({ width, height });

      const mismatchPixels = pixelmatch(croppedA.data, croppedB.data, diff.data, width, height, {
        threshold: 0.12,
      });

      const totalPixels = width * height;
      const similarity = Math.round((1 - mismatchPixels / totalPixels) * 10000) / 10000;
      const parityPercent = Math.round(similarity * 10000) / 100;

      // RGB Mean Absolute Error (0..255 channel scale)
      let absErrSum = 0;
      for (let p = 0; p < croppedA.data.length; p += 4) {
        absErrSum +=
          Math.abs(croppedA.data[p] - croppedB.data[p]) +
          Math.abs(croppedA.data[p + 1] - croppedB.data[p + 1]) +
          Math.abs(croppedA.data[p + 2] - croppedB.data[p + 2]);
      }
      const meanAbsoluteError =
        totalPixels > 0 ? Math.round((absErrSum / (totalPixels * 3)) * 1000) / 1000 : 0;

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
        parityPercent,
        meanAbsoluteError,
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
    const overallParityPercent = Math.round(overallSimilarity * 10000) / 100;
    const meanAbsoluteError =
      pages.length > 0
        ? Math.round((pages.reduce((s, p) => s + p.meanAbsoluteError, 0) / pages.length) * 1000) / 1000
        : 0;

    const report: VisualDiffReport = {
      available: true,
      targetSimilarity,
      overallSimilarity,
      overallParityPercent,
      meanAbsoluteError,
      note: `Computed pixel parity (${overallParityPercent.toFixed(2)}%, MAE ${meanAbsoluteError.toFixed(2)}) across ${pages.length} page(s).`,
      pages,
    };

    if (outputDir) {
      const cleanReport = {
        overallSimilarity: report.overallSimilarity,
        overallParityPercent: report.overallParityPercent,
        meanAbsoluteError: report.meanAbsoluteError,
        targetSimilarity: report.targetSimilarity,
        pages: report.pages.map((p) => ({
          page: p.page,
          similarity: p.similarity,
          parityPercent: p.parityPercent,
          meanAbsoluteError: p.meanAbsoluteError,
          mismatchPixels: p.mismatchPixels,
          totalPixels: p.totalPixels,
        })),
      };
      fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(cleanReport, null, 2), 'utf-8');
    }

    this.logger.info('VisualDiff', `Visual parity: ${overallParityPercent.toFixed(2)}% (MAE ${meanAbsoluteError.toFixed(2)})`, {
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
