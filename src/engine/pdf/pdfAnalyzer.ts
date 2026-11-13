import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  BandKind,
  IntermediateLayoutModel,
  LayoutPage,
  LayoutRegion,
  RegionStyle,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
} from '../core/types.ts';

const execFileAsync = promisify(execFile);

interface PdfTextItem {
  str: string;
  dir?: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
}

interface RawVectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor?: string;
  fillColor?: string;
  lineWidthPt: number;
}

const PT_PER_INCH = 72;

function roundIn(val: number): number {
  return Math.round(val * 1000) / 1000;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n <= 1 ? n * 255 : n)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function defaultStyle(): RegionStyle {
  return {
    fontFamily: 'Segoe UI',
    fontSizePt: 10,
    bold: false,
    italic: false,
    color: '#0F172A',
    textAlign: 'Left',
    verticalAlign: 'Middle',
    paddingPt: { top: 2, right: 4, bottom: 2, left: 4 },
  };
}

function inferFontFlags(fontName: string, loadedFontName?: string): {
  family: string;
  bold: boolean;
  italic: boolean;
} {
  const combined = `${fontName} ${loadedFontName ?? ''}`.toLowerCase();
  const bold = combined.includes('bold') || combined.includes('bd') || combined.includes('black') || combined.includes('semibold');
  const italic = combined.includes('italic') || combined.includes('oblique');
  let family = 'Arial';
  if (combined.includes('times') || combined.includes('serif') || combined.includes('garamond')) {
    family = 'Times New Roman';
  } else if (combined.includes('courier') || combined.includes('mono') || combined.includes('consolas')) {
    family = 'Consolas';
  } else if (combined.includes('calibri')) {
    family = 'Calibri';
  } else if (combined.includes('segoe')) {
    family = 'Segoe UI';
  } else if (combined.includes('helvetica')) {
    family = 'Arial';
  }
  return { family, bold, italic };
}

function classifyBandHeuristic(yIn: number, pageHeightIn: number): BandKind {
  if (yIn < Math.min(1.4, pageHeightIn * 0.14)) return 'Header';
  if (yIn > pageHeightIn - Math.min(1.1, pageHeightIn * 0.1)) return 'Footer';
  return 'Detail';
}

export class PdfAnalyzer {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public async analyzeBuffer(
    pdfBytes: Uint8Array,
    documentName: string,
    dpi = 144
  ): Promise<IntermediateLayoutModel> {
    this.logger.info('PdfAnalysis', `PDF analysis started for "${documentName}"`);
    try {
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBytes),
        useSystemFonts: true,
        verbosity: 0,
      });
      const pdfDoc = await loadingTask.promise;
      const numPages = pdfDoc.numPages;

      if (numPages === 0) {
        throw new Error('PDF contains 0 pages');
      }

      // Render raster previews via Ghostscript if available (non-fatal if unavailable)
      const pagePreviews = await this.rasterizePagesWithGhostscript(pdfBytes, dpi);

      const pages: LayoutPage[] = [];
      let regionSeq = 1;

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const widthIn = roundIn(viewport.width / PT_PER_INCH);
        const heightIn = roundIn(viewport.height / PT_PER_INCH);

        const textContent = await page.getTextContent();
        const opList = await page.getOperatorList();

        // Extract vector rectangles, lines, and image paint ops from operator list
        const { vectorRects, imageBoxes, complexClusterBoxes } = this.extractVectorsAndImages(
          opList,
          viewport.height
        );

        const regions: LayoutRegion[] = [];

        // Convert vector rectangles & lines into layout regions
        for (let idx = 0; idx < vectorRects.length; idx++) {
          const vr = vectorRects[idx];
          const isLine = vr.height <= 0.04 || vr.width <= 0.04;
          const style: RegionStyle = {
            ...defaultStyle(),
            backgroundColor: vr.fillColor,
            borderColor: vr.strokeColor,
            borderWidthPt: vr.lineWidthPt,
          };
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: isLine ? 'vector_line' : 'vector_rect',
            x: roundIn(vr.x),
            y: roundIn(vr.y),
            width: roundIn(Math.max(0.02, vr.width)),
            height: roundIn(Math.max(0.02, vr.height)),
            style,
            semanticRole: 'unknown',
            confidence: 0.95,
            bandKind: classifyBandHeuristic(vr.y, heightIn),
            isAmbiguous: false,
            sourceObjectRefs: [`p${pageNum}-vec-${idx}`],
          });
        }

        // Convert detected images or complex vector clusters into image fallback regions
        for (let idx = 0; idx < imageBoxes.length; idx++) {
          const box = imageBoxes[idx];
          const croppedBase64 = await this.cropPageRegionToBase64(
            pagePreviews[pageNum - 1],
            box,
            widthIn,
            heightIn
          );
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'image',
            x: roundIn(box.x),
            y: roundIn(box.y),
            width: roundIn(box.width),
            height: roundIn(box.height),
            style: defaultStyle(),
            semanticRole: 'logoOrGraphic',
            confidence: 0.96,
            bandKind: classifyBandHeuristic(box.y, heightIn),
            isAmbiguous: false,
            preferImageFallback: true,
            imageAssetBase64: croppedBase64,
            imageAssetName: `EmbeddedGraphic_P${pageNum}_${idx + 1}`,
            sourceObjectRefs: [`p${pageNum}-img-${idx}`],
          });
        }

        for (let idx = 0; idx < complexClusterBoxes.length; idx++) {
          const box = complexClusterBoxes[idx];
          const croppedBase64 = await this.cropPageRegionToBase64(
            pagePreviews[pageNum - 1],
            box,
            widthIn,
            heightIn
          );
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'vector_complex',
            x: roundIn(box.x),
            y: roundIn(box.y),
            width: roundIn(box.width),
            height: roundIn(box.height),
            style: defaultStyle(),
            semanticRole: 'logoOrGraphic',
            confidence: 0.88,
            bandKind: classifyBandHeuristic(box.y, heightIn),
            isAmbiguous: true,
            ambiguityReason: 'Complex vector illustration/timeline cluster; confirm image fallback vs native layout.',
            preferImageFallback: true,
            imageAssetBase64: croppedBase64,
            imageAssetName: `VectorCluster_P${pageNum}_${idx + 1}`,
            sourceObjectRefs: [`p${pageNum}-vc-${idx}`],
          });
        }

        // Group text spans on the same line into coherent text blocks
        const rawItems = (textContent.items as PdfTextItem[]).filter(
          (item) => typeof item.str === 'string' && item.str.trim().length > 0
        );

        const mergedLines = this.mergeTextSpansOnSameBaseline(rawItems, viewport.height, textContent.styles ?? {});

        for (let idx = 0; idx < mergedLines.length; idx++) {
          const line = mergedLines[idx];
          const bandKind = classifyBandHeuristic(line.y, heightIn);
          const fontInfo = inferFontFlags(line.fontName, line.fontLoadedName);
          const enclosingRect = vectorRects.find(
            (r) =>
              line.x >= r.x - 0.05 &&
              line.x + line.width <= r.x + r.width + 0.05 &&
              line.y >= r.y - 0.05 &&
              line.y + line.height <= r.y + r.height + 0.05 &&
              r.width > 0.15 &&
              r.height > 0.12
          );

          const style: RegionStyle = {
            fontFamily: fontInfo.family,
            fontSizePt: Math.round(line.fontSizePt * 10) / 10,
            bold: fontInfo.bold,
            italic: fontInfo.italic,
            color: '#0F172A',
            backgroundColor: enclosingRect?.fillColor,
            borderColor: enclosingRect?.strokeColor,
            borderWidthPt: enclosingRect?.lineWidthPt,
            textAlign: line.x > widthIn * 0.65 ? 'Right' : 'Left',
            verticalAlign: 'Middle',
            paddingPt: { top: 2, right: 4, bottom: 2, left: 4 },
          };

          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'text',
            x: roundIn(line.x),
            y: roundIn(line.y),
            width: roundIn(Math.max(0.08, line.width)),
            height: roundIn(Math.max(0.14, line.height)),
            text: line.text,
            style,
            semanticRole: 'unknown',
            confidence: 0.7,
            bandKind,
            isAmbiguous: false,
            sourceObjectRefs: [`p${pageNum}-txt-${idx}`],
          });
        }

        const rawObjectCount = rawItems.length + vectorRects.length + imageBoxes.length;
        this.logger.info('PdfAnalysis', `Page ${pageNum} analyzed`, {
          rawObjects: rawObjectCount,
          normalizedRegions: regions.length,
        });

        pages.push({
          pageNumber: pageNum,
          width: widthIn,
          height: heightIn,
          rawObjectCount,
          regions,
          bands: [],
          rasterPreviewBase64: pagePreviews[pageNum - 1]?.toString('base64'),
        });
      }

      const firstPage = pages[0];
      return {
        document: {
          name: documentName,
          pageCount: pages.length,
          pageWidth: firstPage.width,
          pageHeight: firstPage.height,
          unit: 'inch',
          extractedAt: new Date().toISOString(),
        },
        pages,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('PdfAnalysis', `PDF analysis failed: ${msg}`);
      throw new ReportGenError(ReportGenErrorCode.PDF_ANALYSIS_FAILED, msg, err);
    }
  }

  private mergeTextSpansOnSameBaseline(
    items: PdfTextItem[],
    pageHeightPt: number,
    styles: Record<string, { fontFamily?: string }>
  ): Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontSizePt: number;
    fontName: string;
    fontLoadedName?: string;
  }> {
    const normalized = items.map((it) => {
      const tx = it.transform;
      const fontSizePt = Math.max(6, Math.hypot(tx[0], tx[1]) || Math.hypot(tx[2], tx[3]) || 10);
      const xPt = tx[4];
      const yTopPt = pageHeightPt - tx[5] - fontSizePt * 0.85;
      const wPt = Math.max(it.width || it.str.length * fontSizePt * 0.5, 4);
      const hPt = Math.max(it.height || fontSizePt * 1.2, fontSizePt * 1.15);
      return {
        text: it.str,
        x: xPt / PT_PER_INCH,
        y: Math.max(0, yTopPt / PT_PER_INCH),
        width: wPt / PT_PER_INCH,
        height: hPt / PT_PER_INCH,
        fontSizePt,
        fontName: it.fontName,
        fontLoadedName: styles[it.fontName]?.fontFamily,
      };
    });

    normalized.sort((a, b) => (Math.abs(a.y - b.y) < 0.04 ? a.x - b.x : a.y - b.y));

    const merged: typeof normalized = [];
    for (const cur of normalized) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        Math.abs(prev.y - cur.y) <= 0.045 &&
        cur.x - (prev.x + prev.width) >= -0.04 &&
        cur.x - (prev.x + prev.width) <= 0.14 &&
        Math.abs(prev.fontSizePt - cur.fontSizePt) <= 1.2
      ) {
        const gap = cur.x - (prev.x + prev.width);
        const spacer = gap > 0.03 && !prev.text.endsWith(' ') && !cur.text.startsWith(' ') ? ' ' : '';
        prev.text = `${prev.text}${spacer}${cur.text}`.replace(/\s+/g, ' ').trim();
        prev.width = Math.max(prev.width, cur.x + cur.width - prev.x);
        prev.height = Math.max(prev.height, cur.height);
      } else {
        merged.push({ ...cur, text: cur.text.trim() });
      }
    }
    return merged;
  }

  private extractVectorsAndImages(
    opList: { fnArray: number[]; argsArray: unknown[][] },
    pageHeightPt: number
  ): {
    vectorRects: RawVectorRect[];
    imageBoxes: Array<{ x: number; y: number; width: number; height: number }>;
    complexClusterBoxes: Array<{ x: number; y: number; width: number; height: number }>;
  } {
    const OPS = pdfjsLib.OPS;
    const vectorRects: RawVectorRect[] = [];
    const imageBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const pathPoints: Array<{ x: number; y: number }> = [];

    let strokeColor = '#CBD5E1';
    let fillColor: string | undefined;
    let lineWidthPt = 0.75;
    let ctmStack: number[][] = [[1, 0, 0, 1, 0, 0]];

    const applyCtm = (m: number[], x: number, y: number): [number, number] => [
      m[0] * x + m[2] * y + m[4],
      m[1] * x + m[3] * y + m[5],
    ];

    const mulMatrix = (a: number[], b: number[]): number[] => [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];

    let pendingRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    let pendingLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    let curX = 0;
    let curY = 0;

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] ?? [];
      const ctm = ctmStack[ctmStack.length - 1];

      if (fn === OPS.save) {
        ctmStack.push([...ctm]);
      } else if (fn === OPS.restore) {
        if (ctmStack.length > 1) ctmStack.pop();
      } else if (fn === OPS.transform && args.length >= 6) {
        ctmStack[ctmStack.length - 1] = mulMatrix(ctm, args as number[]);
      } else if (fn === OPS.setLineWidth && typeof args[0] === 'number') {
        lineWidthPt = Math.max(0.5, args[0]);
      } else if (fn === OPS.setStrokeRGBColor && args.length >= 3) {
        strokeColor = rgbToHex(Number(args[0]), Number(args[1]), Number(args[2]));
      } else if (fn === OPS.setFillRGBColor && args.length >= 3) {
        fillColor = rgbToHex(Number(args[0]), Number(args[1]), Number(args[2]));
      } else if (fn === OPS.rectangle && args.length >= 4) {
        const [rx, ry, rw, rh] = args as number[];
        const [x1, y1] = applyCtm(ctm, rx, ry);
        const [x2, y2] = applyCtm(ctm, rx + rw, ry + rh);
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = pageHeightPt - Math.max(y1, y2);
        const maxY = pageHeightPt - Math.min(y1, y2);
        pendingRects.push({
          x: minX / PT_PER_INCH,
          y: minY / PT_PER_INCH,
          w: (maxX - minX) / PT_PER_INCH,
          h: (maxY - minY) / PT_PER_INCH,
        });
      } else if (fn === OPS.moveTo && args.length >= 2) {
        const [px, py] = applyCtm(ctm, Number(args[0]), Number(args[1]));
        curX = px;
        curY = pageHeightPt - py;
        pathPoints.push({ x: curX / PT_PER_INCH, y: curY / PT_PER_INCH });
      } else if (fn === OPS.lineTo && args.length >= 2) {
        const [px, py] = applyCtm(ctm, Number(args[0]), Number(args[1]));
        const nextX = px;
        const nextY = pageHeightPt - py;
        pendingLines.push({
          x1: curX / PT_PER_INCH,
          y1: curY / PT_PER_INCH,
          x2: nextX / PT_PER_INCH,
          y2: nextY / PT_PER_INCH,
        });
        curX = nextX;
        curY = nextY;
      } else if (fn === OPS.constructPath && Array.isArray(args[0]) && Array.isArray(args[1])) {
        const subOps = args[0] as number[];
        const coords = args[1] as number[];
        let ci = 0;
        for (const sop of subOps) {
          if (sop === OPS.moveTo) {
            const [px, py] = applyCtm(ctm, coords[ci], coords[ci + 1]);
            curX = px;
            curY = pageHeightPt - py;
            ci += 2;
          } else if (sop === OPS.lineTo) {
            const [px, py] = applyCtm(ctm, coords[ci], coords[ci + 1]);
            const nextX = px;
            const nextY = pageHeightPt - py;
            pendingLines.push({
              x1: curX / PT_PER_INCH,
              y1: curY / PT_PER_INCH,
              x2: nextX / PT_PER_INCH,
              y2: nextY / PT_PER_INCH,
            });
            curX = nextX;
            curY = nextY;
            ci += 2;
          } else if (sop === OPS.curveTo) {
            pathPoints.push({ x: curX / PT_PER_INCH, y: curY / PT_PER_INCH });
            ci += 6;
          } else if (sop === OPS.rectangle) {
            const rx = coords[ci];
            const ry = coords[ci + 1];
            const rw = coords[ci + 2];
            const rh = coords[ci + 3];
            const [x1, y1] = applyCtm(ctm, rx, ry);
            const [x2, y2] = applyCtm(ctm, rx + rw, ry + rh);
            pendingRects.push({
              x: Math.min(x1, x2) / PT_PER_INCH,
              y: (pageHeightPt - Math.max(y1, y2)) / PT_PER_INCH,
              w: Math.abs(x2 - x1) / PT_PER_INCH,
              h: Math.abs(y2 - y1) / PT_PER_INCH,
            });
            ci += 4;
          }
        }
      } else if (
        fn === OPS.stroke ||
        fn === OPS.closeStroke ||
        fn === OPS.fill ||
        fn === OPS.eoFill ||
        fn === OPS.fillStroke ||
        fn === OPS.eoFillStroke
      ) {
        const hasFill =
          fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke;
        const hasStroke =
          fn === OPS.stroke ||
          fn === OPS.closeStroke ||
          fn === OPS.fillStroke ||
          fn === OPS.eoFillStroke;

        for (const r of pendingRects) {
          if (r.w > 0.01 || r.h > 0.01) {
            vectorRects.push({
              x: Math.max(0, r.x),
              y: Math.max(0, r.y),
              width: r.w,
              height: r.h,
              strokeColor: hasStroke ? strokeColor : undefined,
              fillColor: hasFill ? fillColor : undefined,
              lineWidthPt,
            });
          }
        }
        for (const ln of pendingLines) {
          const w = Math.abs(ln.x2 - ln.x1);
          const h = Math.abs(ln.y2 - ln.y1);
          if (w > 0.05 || h > 0.05) {
            vectorRects.push({
              x: Math.max(0, Math.min(ln.x1, ln.x2)),
              y: Math.max(0, Math.min(ln.y1, ln.y2)),
              width: Math.max(0.015, w),
              height: Math.max(0.015, h),
              strokeColor: hasStroke ? strokeColor : fillColor,
              lineWidthPt,
            });
          }
        }
        pendingRects = [];
        pendingLines = [];
      } else if (fn === OPS.endPath) {
        pendingRects = [];
        pendingLines = [];
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        // CTM maps unit square [0,0]-[1,1] into page user space
        const [x1, y1] = applyCtm(ctm, 0, 0);
        const [x2, y2] = applyCtm(ctm, 1, 1);
        const minX = Math.min(x1, x2) / PT_PER_INCH;
        const maxX = Math.max(x1, x2) / PT_PER_INCH;
        const minY = (pageHeightPt - Math.max(y1, y2)) / PT_PER_INCH;
        const maxY = (pageHeightPt - Math.min(y1, y2)) / PT_PER_INCH;
        if (maxX - minX > 0.1 && maxY - minY > 0.1) {
          imageBoxes.push({
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: maxX - minX,
            height: maxY - minY,
          });
        }
      }
    }

    // Detect dense curve/complex vector regions as image fallback candidates
    const complexClusterBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    if (pathPoints.length >= 12) {
      const xs = pathPoints.map((p) => p.x);
      const ys = pathPoints.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      if (maxX - minX > 0.3 && maxY - minY > 0.3 && maxX - minX < 7.5 && maxY - minY < 4.5) {
        complexClusterBoxes.push({
          x: Math.max(0, minX),
          y: Math.max(0, minY),
          width: maxX - minX,
          height: maxY - minY,
        });
      }
    }

    return { vectorRects, imageBoxes, complexClusterBoxes };
  }

  public async rasterizePagesWithGhostscript(pdfBytes: Uint8Array, dpi = 144): Promise<Buffer[]> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportgen-gs-'));
    const inputPath = path.join(tmpDir, 'input.pdf');
    const outPattern = path.join(tmpDir, 'page-%03d.png');
    try {
      fs.writeFileSync(inputPath, pdfBytes);
      await execFileAsync('gs', [
        '-dNOPAUSE',
        '-dBATCH',
        '-sDEVICE=png16m',
        `-r${dpi}`,
        `-sOutputFile=${outPattern}`,
        inputPath,
      ]);
      const files = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
        .sort();
      return files.map((f) => fs.readFileSync(path.join(tmpDir, f)));
    } catch {
      return [];
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private async cropPageRegionToBase64(
    pagePngBuffer: Buffer | undefined,
    box: { x: number; y: number; width: number; height: number },
    pageWidthIn: number,
    pageHeightIn: number
  ): Promise<string | undefined> {
    if (!pagePngBuffer) return undefined;
    try {
      const { PNG } = await import('pngjs');
      const src = PNG.sync.read(pagePngBuffer);
      const px = Math.max(0, Math.floor((box.x / pageWidthIn) * src.width));
      const py = Math.max(0, Math.floor((box.y / pageHeightIn) * src.height));
      const pw = Math.max(8, Math.min(src.width - px, Math.ceil((box.width / pageWidthIn) * src.width)));
      const ph = Math.max(8, Math.min(src.height - py, Math.ceil((box.height / pageHeightIn) * src.height)));

      const dst = new PNG({ width: pw, height: ph });
      PNG.bitblt(src, dst, px, py, pw, ph, 0, 0);
      return PNG.sync.write(dst).toString('base64');
    } catch {
      return undefined;
    }
  }
}
