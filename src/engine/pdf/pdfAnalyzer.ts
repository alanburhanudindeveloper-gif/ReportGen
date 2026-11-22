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

interface TextColorEvent {
  x: number;
  y: number;
  color: string;
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

function normalizeColorArgs(args: unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  const a0 = args[0];
  if (typeof a0 === 'string') {
    const trimmed = a0.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
      const h = trimmed.slice(1);
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toUpperCase();
    }
    if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) return trimmed.slice(0, 7).toUpperCase();
  }
  if (args.length >= 3 && typeof args[0] === 'number') {
    return rgbToHex(Number(args[0]), Number(args[1]), Number(args[2]));
  }
  return undefined;
}

function grayToHex(gray: number): string {
  const v = Math.max(0, Math.min(1, gray));
  return rgbToHex(v, v, v);
}

function cmykToHex(c: number, m: number, y: number, k: number): string {
  const r = (1 - Math.min(1, Math.max(0, c))) * (1 - Math.min(1, Math.max(0, k)));
  const g = (1 - Math.min(1, Math.max(0, m))) * (1 - Math.min(1, Math.max(0, k)));
  const b = (1 - Math.min(1, Math.max(0, y))) * (1 - Math.min(1, Math.max(0, k)));
  return rgbToHex(r, g, b);
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
  const bold =
    combined.includes('bold') ||
    combined.includes('bd') ||
    combined.includes('black') ||
    combined.includes('semibold') ||
    combined.includes('heavy');
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

        const { vectorRects, imageBoxes, complexClusterBoxes, textColorEvents } =
          this.extractVectorsAndImages(opList, viewport.height, widthIn, heightIn);

        const regions: LayoutRegion[] = [];

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
            width: roundIn(Math.max(0.015, vr.width)),
            height: roundIn(Math.max(0.015, vr.height)),
            style,
            semanticRole: 'unknown',
            confidence: 0.95,
            bandKind: classifyBandHeuristic(vr.y, heightIn),
            isAmbiguous: false,
            sourceObjectRefs: [`p${pageNum}-vec-${idx}`],
          });
        }

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

        const rawItems = (textContent.items as PdfTextItem[]).filter(
          (item) => typeof item.str === 'string' && item.str.trim().length > 0
        );

        const mergedLines = this.mergeTextSpansOnSameBaseline(
          rawItems,
          viewport.height,
          textContent.styles ?? {},
          textColorEvents
        );

        // Filter out curved graphic clusters that enclose dense text (likely rounded UI cards/sections already captured as vector+text)
        const iconClusters = complexClusterBoxes.filter((box) => {
          const enclosedText = mergedLines.filter(
            (ln) =>
              ln.x >= box.x - 0.08 &&
              ln.x + ln.width <= box.x + box.width + 0.08 &&
              ln.y >= box.y - 0.08 &&
              ln.y + ln.height <= box.y + box.height + 0.08
          );
          if (box.width > 2.2 && enclosedText.length >= 2) return false;
          if (enclosedText.length >= 4) return false;
          return true;
        });

        for (let idx = 0; idx < iconClusters.length; idx++) {
          const box = iconClusters[idx];
          const croppedBase64 = await this.cropPageRegionToBase64(
            pagePreviews[pageNum - 1],
            box,
            widthIn,
            heightIn
          );
          if (!croppedBase64) continue;
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
            isAmbiguous: false,
            preferImageFallback: true,
            imageAssetBase64: croppedBase64,
            imageAssetName: `VectorCluster_P${pageNum}_${idx + 1}`,
            sourceObjectRefs: [`p${pageNum}-vc-${idx}`],
          });
        }

        for (let idx = 0; idx < mergedLines.length; idx++) {
          const line = mergedLines[idx];
          const bandKind = classifyBandHeuristic(line.y, heightIn);
          const fontInfo = inferFontFlags(line.fontName, line.fontLoadedName);
          const enclosingRect = vectorRects
            .filter(
              (r) =>
                line.x >= r.x - 0.08 &&
                line.x + line.width <= r.x + r.width + 0.08 &&
                line.y >= r.y - 0.08 &&
                line.y + line.height <= r.y + r.height + 0.08 &&
                r.width > 0.15 &&
                r.height > 0.12
            )
            .sort((a, b) => a.width * a.height - b.width * b.height)[0];

          let textAlign: 'Left' | 'Center' | 'Right' = 'Left';
          if (enclosingRect && enclosingRect.width > 0.8) {
            const lineCenter = line.x + line.width / 2;
            const rectCenter = enclosingRect.x + enclosingRect.width / 2;
            if (Math.abs(lineCenter - rectCenter) <= 0.18 && line.width < enclosingRect.width * 0.88) {
              textAlign = 'Center';
            } else if (
              enclosingRect.x + enclosingRect.width - (line.x + line.width) <= 0.16 &&
              line.x - enclosingRect.x > 0.25
            ) {
              textAlign = 'Right';
            }
          } else if (
            Math.abs(line.x + line.width / 2 - widthIn / 2) <= 0.2 &&
            line.width < widthIn * 0.72 &&
            bandKind === 'Header'
          ) {
            textAlign = 'Center';
          }

          const style: RegionStyle = {
            fontFamily: fontInfo.family,
            fontSizePt: Math.round(line.fontSizePt * 10) / 10,
            bold: fontInfo.bold,
            italic: fontInfo.italic,
            color: line.color,
            backgroundColor: enclosingRect?.fillColor,
            borderColor: enclosingRect?.strokeColor,
            borderWidthPt: enclosingRect?.lineWidthPt,
            textAlign,
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
    styles: Record<string, { fontFamily?: string }>,
    textColorEvents: TextColorEvent[]
  ): Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fontSizePt: number;
    fontName: string;
    fontLoadedName?: string;
    color: string;
  }> {
    const matchTextColor = (x: number, y: number): string => {
      let bestColor = '#0F172A';
      let bestDist = 0.25;
      for (const ev of textColorEvents) {
        const d = Math.hypot(ev.x - x, ev.y - y);
        if (d < bestDist) {
          bestDist = d;
          bestColor = ev.color;
        }
      }
      return bestColor;
    };

    const normalized = items.map((it) => {
      const tx = it.transform;
      const fontSizePt = Math.max(5.5, Math.hypot(tx[0], tx[1]) || Math.hypot(tx[2], tx[3]) || 10);
      const xPt = tx[4];
      const yBaselineIn = (pageHeightPt - tx[5]) / PT_PER_INCH;
      const yTopPt = pageHeightPt - tx[5] - fontSizePt * 0.85;
      const wPt = Math.max(it.width || it.str.length * fontSizePt * 0.5, 4);
      const hPt = Math.max(it.height || fontSizePt * 1.2, fontSizePt * 1.15);
      const xIn = xPt / PT_PER_INCH;
      return {
        text: it.str,
        x: xIn,
        y: Math.max(0, yTopPt / PT_PER_INCH),
        width: wPt / PT_PER_INCH,
        height: hPt / PT_PER_INCH,
        fontSizePt,
        fontName: it.fontName,
        fontLoadedName: styles[it.fontName]?.fontFamily,
        color: matchTextColor(xIn, yBaselineIn),
      };
    });

    normalized.sort((a, b) => (Math.abs(a.y - b.y) < 0.04 ? a.x - b.x : a.y - b.y));

    const merged: typeof normalized = [];
    for (const cur of normalized) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        Math.abs(prev.y - cur.y) <= 0.04 &&
        cur.x - (prev.x + prev.width) >= -0.04 &&
        cur.x - (prev.x + prev.width) <= 0.12 &&
        Math.abs(prev.fontSizePt - cur.fontSizePt) <= 1.2 &&
        prev.color === cur.color
      ) {
        const gap = cur.x - (prev.x + prev.width);
        const spacer = gap > 0.025 && !prev.text.endsWith(' ') && !cur.text.startsWith(' ') ? ' ' : '';
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
    pageHeightPt: number,
    pageWidthIn: number,
    pageHeightIn: number
  ): {
    vectorRects: RawVectorRect[];
    imageBoxes: Array<{ x: number; y: number; width: number; height: number }>;
    complexClusterBoxes: Array<{ x: number; y: number; width: number; height: number }>;
    textColorEvents: TextColorEvent[];
  } {
    const OPS = pdfjsLib.OPS;
    const vectorRects: RawVectorRect[] = [];
    const imageBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const curveBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const textColorEvents: TextColorEvent[] = [];

    interface GState {
      ctm: number[];
      strokeColor: string;
      fillColor?: string;
      lineWidthPt: number;
    }

    const gStack: GState[] = [
      {
        ctm: [1, 0, 0, 1, 0, 0],
        strokeColor: '#CBD5E1',
        fillColor: undefined,
        lineWidthPt: 0.75,
      },
    ];

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
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = [1, 0, 0, 1, 0, 0];
    let textLeading = 0;

    const emitPathShapes = (
      subpaths: Array<{ pts: Array<{ x: number; y: number }>; hasCurves: boolean }>,
      hasFill: boolean,
      hasStroke: boolean,
      fillCol: string | undefined,
      strokeCol: string,
      lw: number
    ) => {
      for (const sp of subpaths) {
        if (sp.pts.length < 2) continue;
        const xs = sp.pts.map((p) => p.x);
        const ys = sp.pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const w = maxX - minX;
        const h = maxY - minY;

        if (w <= 0.008 && h <= 0.008) continue;

        // Skip full-page white backdrop
        if (
          w > pageWidthIn - 0.15 &&
          h > pageHeightIn - 0.15 &&
          (!fillCol || fillCol === '#FFFFFF')
        ) {
          continue;
        }

        if (sp.hasCurves) {
          if (w >= 0.1 && h >= 0.1 && w <= 3.5 && h <= 3.5) {
            curveBoxes.push({ x: Math.max(0, minX), y: Math.max(0, minY), width: w, height: h });
          } else if (w > 0.2 && h > 0.12 && (hasFill || hasStroke)) {
            vectorRects.push({
              x: Math.max(0, minX),
              y: Math.max(0, minY),
              width: w,
              height: h,
              fillColor: hasFill ? fillCol : undefined,
              strokeColor: hasStroke ? strokeCol : undefined,
              lineWidthPt: lw,
            });
          }
          continue;
        }

        const isThinLine = h <= 0.035 || w <= 0.035;
        if (isThinLine) {
          vectorRects.push({
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: Math.max(0.015, w),
            height: Math.max(0.015, h),
            strokeColor: hasStroke ? strokeCol : fillCol,
            fillColor: hasFill ? fillCol : undefined,
            lineWidthPt: lw,
          });
        } else if (hasFill || hasStroke) {
          vectorRects.push({
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: w,
            height: h,
            strokeColor: hasStroke ? strokeCol : undefined,
            fillColor: hasFill ? fillCol : undefined,
            lineWidthPt: lw,
          });
        }
      }
    };

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] ?? [];
      const gs = gStack[gStack.length - 1];
      const ctm = gs.ctm;

      if (fn === OPS.save) {
        gStack.push({
          ctm: [...gs.ctm],
          strokeColor: gs.strokeColor,
          fillColor: gs.fillColor,
          lineWidthPt: gs.lineWidthPt,
        });
      } else if (fn === OPS.restore) {
        if (gStack.length > 1) gStack.pop();
      } else if (fn === OPS.transform && args.length >= 6) {
        gs.ctm = mulMatrix(ctm, args as number[]);
      } else if (fn === OPS.setLineWidth && typeof args[0] === 'number') {
        gs.lineWidthPt = Math.max(0.4, args[0]);
      } else if (fn === OPS.setStrokeRGBColor) {
        const c = normalizeColorArgs(args);
        if (c) gs.strokeColor = c;
      } else if (fn === OPS.setFillRGBColor) {
        const c = normalizeColorArgs(args);
        if (c) gs.fillColor = c;
      } else if (fn === OPS.setFillGray && typeof args[0] === 'number') {
        gs.fillColor = grayToHex(args[0]);
      } else if (fn === OPS.setStrokeGray && typeof args[0] === 'number') {
        gs.strokeColor = grayToHex(args[0]);
      } else if (fn === OPS.setFillCMYKColor && args.length >= 4) {
        gs.fillColor = cmykToHex(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
      } else if (fn === OPS.setStrokeCMYKColor && args.length >= 4) {
        gs.strokeColor = cmykToHex(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
      } else if (fn === OPS.beginText) {
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.setLeading && typeof args[0] === 'number') {
        textLeading = Number(args[0]);
      } else if (fn === OPS.setTextMatrix && args.length >= 1) {
        const rawMat =
          args.length >= 6
            ? args
            : args[0] && typeof (args[0] as Record<number, unknown>)[0] === 'number'
              ? Array.from({ length: 6 }, (_, idx) => Number((args[0] as Record<number, number>)[idx]))
              : null;
        if (rawMat && rawMat.length >= 6) {
          tm = [
            Number(rawMat[0]),
            Number(rawMat[1]),
            Number(rawMat[2]),
            Number(rawMat[3]),
            Number(rawMat[4]),
            Number(rawMat[5]),
          ];
          tlm = [...tm];
        }
      } else if ((fn === OPS.moveText || fn === OPS.setLeadingMoveText) && args.length >= 2) {
        if (fn === OPS.setLeadingMoveText) {
          textLeading = -Number(args[1]);
        }
        tlm = mulMatrix(tlm, [1, 0, 0, 1, Number(args[0]), Number(args[1])]);
        tm = [...tlm];
      } else if (fn === OPS.nextLine || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
        tlm = mulMatrix(tlm, [1, 0, 0, 1, 0, -textLeading]);
        tm = [...tlm];
        if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
          const composed = mulMatrix(ctm, tm);
          textColorEvents.push({
            x: composed[4] / PT_PER_INCH,
            y: (pageHeightPt - composed[5]) / PT_PER_INCH,
            color: gs.fillColor ?? '#0F172A',
          });
        }
      } else if (fn === OPS.showText || fn === OPS.showSpacedText) {
        const composed = mulMatrix(ctm, tm);
        const pxIn = composed[4] / PT_PER_INCH;
        const pyIn = (pageHeightPt - composed[5]) / PT_PER_INCH;
        textColorEvents.push({
          x: pxIn,
          y: pyIn,
          color: gs.fillColor ?? '#0F172A',
        });
      } else if (fn === OPS.constructPath && typeof args[0] === 'number') {
        // pdfjs-dist v6 format: [paintOp, [Float32Array of sub-ops+coords], Float32Array bbox]
        const paintOp = args[0] as number;
        const hasFill =
          paintOp === OPS.fill ||
          paintOp === OPS.eoFill ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke;
        const hasStroke =
          paintOp === OPS.stroke ||
          paintOp === OPS.closeStroke ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke;

        const rawBuf = Array.isArray(args[1]) ? (args[1][0] as ArrayLike<number> | undefined) : undefined;
        const subpaths: Array<{ pts: Array<{ x: number; y: number }>; hasCurves: boolean }> = [];
        let active: { pts: Array<{ x: number; y: number }>; hasCurves: boolean } | null = null;

        if (rawBuf && rawBuf.length > 0) {
          let k = 0;
          while (k < rawBuf.length) {
            const code = rawBuf[k++];
            if (code === 0 && k + 1 < rawBuf.length) {
              // MOVE_TO
              if (active && active.pts.length >= 2) subpaths.push(active);
              const [px, py] = applyCtm(ctm, Number(rawBuf[k]), Number(rawBuf[k + 1]));
              active = {
                pts: [{ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH }],
                hasCurves: false,
              };
              k += 2;
            } else if (code === 1 && k + 1 < rawBuf.length) {
              // LINE_TO
              const [px, py] = applyCtm(ctm, Number(rawBuf[k]), Number(rawBuf[k + 1]));
              if (!active) active = { pts: [], hasCurves: false };
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 2;
            } else if (code === 2 && k + 5 < rawBuf.length) {
              // CURVE_TO (6 args)
              const [px, py] = applyCtm(ctm, Number(rawBuf[k + 4]), Number(rawBuf[k + 5]));
              if (!active) active = { pts: [], hasCurves: false };
              active.hasCurves = true;
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 6;
            } else if (code === 3 && k + 3 < rawBuf.length) {
              // QUADRATIC_TO (4 args)
              const [px, py] = applyCtm(ctm, Number(rawBuf[k + 2]), Number(rawBuf[k + 3]));
              if (!active) active = { pts: [], hasCurves: false };
              active.hasCurves = true;
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 4;
            } else if (code === 4) {
              // CLOSE_PATH
              if (active && active.pts.length >= 2) subpaths.push(active);
              active = null;
            } else {
              break;
            }
          }
          if (active && active.pts.length >= 2) subpaths.push(active);
        }
        emitPathShapes(subpaths, hasFill, hasStroke, gs.fillColor, gs.strokeColor, gs.lineWidthPt);
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
            ci += 6;
          } else if (sop === OPS.rectangle) {
            const [x1, y1] = applyCtm(ctm, coords[ci], coords[ci + 1]);
            const [x2, y2] = applyCtm(ctm, coords[ci] + coords[ci + 2], coords[ci + 1] + coords[ci + 3]);
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
              strokeColor: hasStroke ? gs.strokeColor : undefined,
              fillColor: hasFill ? gs.fillColor : undefined,
              lineWidthPt: gs.lineWidthPt,
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
              strokeColor: hasStroke ? gs.strokeColor : gs.fillColor,
              lineWidthPt: gs.lineWidthPt,
            });
          }
        }
        pendingRects = [];
        pendingLines = [];
      } else if (fn === OPS.endPath) {
        pendingRects = [];
        pendingLines = [];
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
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

    // Merge nearby/overlapping curved graphics into tight icon/badge clusters
    const complexClusterBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const pad = 0.12;
    for (const cb of curveBoxes) {
      const merged = complexClusterBoxes.find(
        (existing) =>
          cb.x <= existing.x + existing.width + pad &&
          cb.x + cb.width >= existing.x - pad &&
          cb.y <= existing.y + existing.height + pad &&
          cb.y + cb.height >= existing.y - pad
      );
      if (merged) {
        const x1 = Math.min(merged.x, cb.x);
        const y1 = Math.min(merged.y, cb.y);
        const x2 = Math.max(merged.x + merged.width, cb.x + cb.width);
        const y2 = Math.max(merged.y + merged.height, cb.y + cb.height);
        merged.x = x1;
        merged.y = y1;
        merged.width = x2 - x1;
        merged.height = y2 - y1;
      } else {
        complexClusterBoxes.push({ ...cb });
      }
    }

    return {
      vectorRects,
      imageBoxes,
      complexClusterBoxes: complexClusterBoxes.filter(
        (b) => b.width >= 0.18 && b.height >= 0.18 && b.width <= 3.6 && b.height <= 3.6
      ),
      textColorEvents,
    };
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
