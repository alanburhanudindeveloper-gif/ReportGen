import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';
import { PNG } from 'pngjs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  BandKind,
  IntermediateLayoutModel,
  LayoutPage,
  LayoutRegion,
  PageVectorPrimitives,
  RegionStyle,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
  VectorFillBox,
  VisualTextRun,
} from '../core/types.ts';
import {
  createRecordingCanvas,
  createVirtualOwnerDocument,
  deduplicateVectorPrimitives,
  rasterizePrimitivesToRgba,
  VirtualCanvasFactory,
  withVirtualCanvasGlobals,
} from './canvas2dVectorProxy.ts';
import { scanPixelGeometry, TextBoxPt } from './pixelGeometryScanner.ts';

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

interface NormalizedSpan {
  text: string;
  x: number;
  y: number;
  baselineY: number;
  width: number;
  height: number;
  fontSizePt: number;
  fontName: string;
  fontLoadedName?: string;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  brokenGlyph: boolean;
}

interface MergedTextLine {
  text: string;
  runs: VisualTextRun[];
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizePt: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
}

const PT_PER_INCH = 72;

function roundIn(val: number): number {
  return Math.round(val * 1000) / 1000;
}

function roundPt(val: number): number {
  return Math.round(val * 100) / 100;
}

function hexLuminancePt(hex?: string): number {
  if (!hex) return 1;
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return 1;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return 1;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function defaultStyle(): RegionStyle {
  return {
    fontFamily: 'Arial',
    fontSizePt: 10,
    bold: false,
    italic: false,
    color: '#0F172A',
    textAlign: 'Left',
    verticalAlign: 'Top',
    paddingPt: { top: 0, right: 0, bottom: 0, left: 0 },
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
    combined.includes('demi') ||
    combined.includes('heavy') ||
    /(?:^|[-_+])(700|800|900)/.test(combined);
  const italic = combined.includes('italic') || combined.includes('oblique');
  const isExplicitSans =
    combined.includes('sans-serif') ||
    combined.includes('sans') ||
    combined.includes('helvetica') ||
    combined.includes('arial') ||
    combined.includes('calibri') ||
    combined.includes('segoe') ||
    combined.includes('montserrat') ||
    combined.includes('roboto') ||
    combined.includes('inter');

  let family = 'Arial';
  if (combined.includes('courier') || combined.includes('mono') || combined.includes('consolas')) {
    family = 'Courier New';
  } else if (
    !isExplicitSans &&
    (combined.includes('times') ||
      combined.includes('garamond') ||
      combined.includes('georgia') ||
      combined.includes('cambria') ||
      /(?:^|[^a-z])serif(?:$|[^a-z])/.test(combined))
  ) {
    family = 'Times New Roman';
  } else if (combined.includes('segoe')) {
    family = 'Segoe UI';
  } else if (combined.includes('calibri')) {
    family = 'Calibri';
  }
  return { family, bold, italic };
}

function classifyBandHeuristic(yIn: number, pageHeightIn: number): BandKind {
  if (yIn < Math.min(1.4, pageHeightIn * 0.14)) return 'Header';
  if (yIn > pageHeightIn - Math.min(1.1, pageHeightIn * 0.1)) return 'Footer';
  return 'Detail';
}

function normalizeLigatures(str: string): string {
  if (!str) return str;
  return str
    .replace(/\uFB00/g, 'ff')
    .replace(/\uFB01/g, 'fi')
    .replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi')
    .replace(/\uFB04/g, 'ffl')
    .replace(/\uFB05/g, 'st')
    .replace(/\uFB06/g, 'st');
}

function hasBrokenGlyphs(str: string): boolean {
  if (!str) return false;
  if (/[\uFFFD\uE000-\uF8FF\u0234\u0235\u025D\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(str)) {
    return true;
  }
  if (/\(cid:\d+\)/i.test(str)) {
    return true;
  }
  return false;
}

function isPdfDelimiter(byte: number): boolean {
  return (
    byte === 0x20 || // space
    byte === 0x0a || // LF
    byte === 0x0d || // CR
    byte === 0x09 || // TAB
    byte === 0x0c || // FF
    byte === 0x00 || // NUL
    byte === 0x28 || // (
    byte === 0x29 || // )
    byte === 0x3c || // <
    byte === 0x3e || // >
    byte === 0x5b || // [
    byte === 0x5d || // ]
    byte === 0x7b || // {
    byte === 0x7d || // }
    byte === 0x2f || // /
    byte === 0x25 // %
  );
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
}

const TEXT_ONLY_OPS = new Set([
  'Tf',
  'Tm',
  'Td',
  'TD',
  'T*',
  'Tc',
  'Tw',
  'Tz',
  'TL',
  'Tr',
  'Ts',
  'Tj',
  'TJ',
  "'",
  '"',
]);

/**
 * Deterministic byte-level PDF content stream lexer that strips all text-positioning
 * and text-showing operators inside BT ... ET blocks while preserving color,
 * ExtGState, and graphics-state operators (rg, RG, k, K, g, G, cs, sc, gs, etc.)
 * that subsequent shapes or table backgrounds may inherit.
 */
export function stripBtEtFromContentStream(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  const len = bytes.length;
  let i = 0;
  let inTextObject = false;
  let pendingOperands: Uint8Array[] = [];

  const pushBytes = (chunk: Uint8Array) => {
    for (let k = 0; k < chunk.length; k++) out.push(chunk[k]);
  };

  const emitChunk = (chunk: Uint8Array) => {
    if (!inTextObject) {
      pushBytes(chunk);
    } else {
      pendingOperands.push(chunk);
    }
  };

  const readLiteralString = (): Uint8Array => {
    const start = i;
    let depth = 1;
    i++;
    while (i < len && depth > 0) {
      const c = bytes[i];
      if (c === 0x5c && i + 1 < len) {
        i += 2;
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29) depth--;
      i++;
    }
    return bytes.subarray(start, i);
  };

  const readAngleBracket = (): Uint8Array => {
    const start = i;
    if (i + 1 < len && bytes[i + 1] === 0x3c) {
      let dictDepth = 1;
      i += 2;
      while (i < len && dictDepth > 0) {
        if (bytes[i] === 0x28) {
          readLiteralString();
          continue;
        }
        if (bytes[i] === 0x3c && i + 1 < len && bytes[i + 1] === 0x3c) {
          dictDepth++;
          i += 2;
          continue;
        }
        if (bytes[i] === 0x3e && i + 1 < len && bytes[i + 1] === 0x3e) {
          dictDepth--;
          i += 2;
          continue;
        }
        i++;
      }
      return bytes.subarray(start, i);
    }
    i++;
    while (i < len && bytes[i] !== 0x3e) i++;
    if (i < len) i++;
    return bytes.subarray(start, i);
  };

  const readArray = (): Uint8Array => {
    const start = i;
    let arrDepth = 1;
    i++;
    while (i < len && arrDepth > 0) {
      const c = bytes[i];
      if (c === 0x28) {
        readLiteralString();
        continue;
      }
      if (c === 0x3c) {
        readAngleBracket();
        continue;
      }
      if (c === 0x5b) arrDepth++;
      else if (c === 0x5d) arrDepth--;
      i++;
    }
    return bytes.subarray(start, i);
  };

  while (i < len) {
    const b = bytes[i];

    // Whitespace
    if (isWhitespace(b)) {
      if (!inTextObject) out.push(b);
      i++;
      continue;
    }

    // Comment %...\n
    if (b === 0x25) {
      const start = i;
      while (i < len && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      if (!inTextObject) pushBytes(bytes.subarray(start, i));
      continue;
    }

    // Literal string (...)
    if (b === 0x28) {
      emitChunk(readLiteralString());
      continue;
    }

    // Dictionary <<...>> or hex string <...>
    if (b === 0x3c) {
      emitChunk(readAngleBracket());
      continue;
    }

    // Array [...]
    if (b === 0x5b) {
      emitChunk(readArray());
      continue;
    }

    // Name /...
    if (b === 0x2f) {
      const start = i;
      i++;
      while (i < len && !isPdfDelimiter(bytes[i])) i++;
      emitChunk(bytes.subarray(start, i));
      continue;
    }

    // Single-char delimiter operators (like ' or ") or unexpected delimiters
    if (isPdfDelimiter(b)) {
      if (inTextObject && (b === 0x27 || b === 0x22)) {
        pendingOperands = [];
        i++;
        continue;
      }
      if (!inTextObject) out.push(b);
      i++;
      continue;
    }

    // Collect regular token (number, boolean, keyword/operator)
    const start = i;
    while (i < len && !isPdfDelimiter(bytes[i])) i++;
    const chunk = bytes.subarray(start, i);
    const token = Buffer.from(chunk).toString('latin1');

    // Inline image BI ... ID ... EI when outside text objects
    if (!inTextObject && token === 'BI') {
      pushBytes(chunk);
      while (i < len) {
        if (
          bytes[i] === 0x49 &&
          bytes[i + 1] === 0x44 &&
          (i === 0 || isWhitespace(bytes[i - 1])) &&
          i + 2 < len &&
          isWhitespace(bytes[i + 2])
        ) {
          out.push(0x49, 0x44, bytes[i + 2]);
          i += 3;
          while (i < len) {
            if (
              i + 2 < len &&
              isWhitespace(bytes[i]) &&
              bytes[i + 1] === 0x45 &&
              bytes[i + 2] === 0x49 &&
              (i + 3 >= len || isPdfDelimiter(bytes[i + 3]))
            ) {
              out.push(bytes[i], 0x45, 0x49);
              i += 3;
              break;
            }
            out.push(bytes[i]);
            i++;
          }
          break;
        }
        out.push(bytes[i]);
        i++;
      }
      continue;
    }

    if (token === 'BT') {
      inTextObject = true;
      pendingOperands = [];
      out.push(0x20);
      continue;
    }

    if (token === 'ET') {
      inTextObject = false;
      pendingOperands = [];
      out.push(0x20);
      continue;
    }

    if (!inTextObject) {
      pushBytes(chunk);
      continue;
    }

    // Inside BT ... ET: classify numbers/booleans/null as operands; operators flush or drop
    const isOperand =
      token === 'true' ||
      token === 'false' ||
      token === 'null' ||
      /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token);

    if (isOperand) {
      pendingOperands.push(chunk);
    } else if (TEXT_ONLY_OPS.has(token)) {
      pendingOperands = [];
    } else {
      for (const op of pendingOperands) {
        pushBytes(op);
        out.push(0x20);
      }
      pushBytes(chunk);
      out.push(0x20);
      pendingOperands = [];
    }
  }

  return Uint8Array.from(out);
}

export class PdfAnalyzer {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public async stripTextOperatorsFromPdf(pdfBytes: Uint8Array): Promise<Uint8Array> {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const visitedRefs = new Set<string>();

    const rewriteRawStream = (raw: PDFRawStream) => {
      try {
        const decoded = decodePDFRawStream(raw).decode();
        const stripped = stripBtEtFromContentStream(decoded);
        const compressed = zlib.deflateSync(Buffer.from(stripped));
        const mut = raw as unknown as { contents: Uint8Array; dict: PDFDict };
        mut.contents = new Uint8Array(compressed);
        mut.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        mut.dict.delete(PDFName.of('DecodeParms'));
        mut.dict.set(PDFName.of('Length'), doc.context.obj(compressed.length));
      } catch {
        // Leave undecodable custom-filter streams untouched so Ghostscript does not fail
      }
    };

    const processXObjects = (resources: PDFDict | undefined) => {
      if (!resources) return;
      const xObjEntry = resources.lookup(PDFName.of('XObject'));
      if (!(xObjEntry instanceof PDFDict)) return;
      for (const [, val] of xObjEntry.entries()) {
        const refKey = val instanceof PDFRef ? val.toString() : undefined;
        if (refKey) {
          if (visitedRefs.has(refKey)) continue;
          visitedRefs.add(refKey);
        }
        const resolved = doc.context.lookup(val);
        if (resolved instanceof PDFRawStream) {
          const subtype = resolved.dict.get(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Form')) {
            rewriteRawStream(resolved);
            const nestedRes = resolved.dict.lookup(PDFName.of('Resources'));
            if (nestedRes instanceof PDFDict) {
              processXObjects(nestedRes);
            }
          }
        }
      }
    };

    for (const page of doc.getPages()) {
      const contentsVal = page.node.get(PDFName.of('Contents'));
      const processContentObj = (obj: unknown) => {
        if (obj instanceof PDFRef) {
          const key = obj.toString();
          if (visitedRefs.has(key)) return;
          visitedRefs.add(key);
          const resolved = doc.context.lookup(obj);
          processContentObj(resolved);
          return;
        }
        if (obj instanceof PDFRawStream) {
          rewriteRawStream(obj);
          return;
        }
        if (obj instanceof PDFArray) {
          for (let i = 0; i < obj.size(); i++) {
            processContentObj(obj.get(i));
          }
        }
      };

      processContentObj(contentsVal);
      const pageResources = page.node.lookup(PDFName.of('Resources'));
      if (pageResources instanceof PDFDict) {
        processXObjects(pageResources);
      }
    }

    return doc.save({ useObjectStreams: false });
  }

  public async analyzeBuffer(
    pdfBytes: Uint8Array,
    documentName: string,
    dpi = 150
  ): Promise<IntermediateLayoutModel> {
    this.logger.info('PdfAnalysis', `PDF analysis started for "${documentName}"`, { dpi });
    return withVirtualCanvasGlobals(async () => {
      try {
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(pdfBytes),
          CanvasFactory: VirtualCanvasFactory as unknown as object,
          disableFontFace: false,
          useSystemFonts: false,
          ownerDocument: createVirtualOwnerDocument() as unknown as object,
          verbosity: 0,
        });
        const pdfDoc = await loadingTask.promise;
        const numPages = pdfDoc.numPages;

        if (numPages === 0) {
          throw new Error('PDF contains 0 pages');
        }

        let lazyStrippedBytes: Uint8Array | null = null;
        const pagePngCache = new Map<string, Buffer | undefined>();

        // Channel 1 pre-pass: render all PDF pages once at scale=2 (144 DPI) for text-masked pixel geometry scanning
        const gs144Pngs = await this.rasterizePagesWithGhostscript(pdfBytes, 144);
        gs144Pngs.forEach((pngBuf, idx) => {
          pagePngCache.set(`${idx + 1}:144:r`, pngBuf);
        });

        const getSinglePagePng = async (
          pageNum: number,
          targetDpi: number,
          stripped: boolean
        ): Promise<Buffer | undefined> => {
          const key = `${pageNum}:${targetDpi}:${stripped ? 's' : 'r'}`;
          if (pagePngCache.has(key)) return pagePngCache.get(key);
          let sourceBytes = pdfBytes;
          if (stripped) {
            if (lazyStrippedBytes === null) {
              try {
                lazyStrippedBytes = await this.stripTextOperatorsFromPdf(pdfBytes);
              } catch (stripErr) {
                this.logger.warn(
                  'PdfAnalysis',
                  `Text-stripped crop fallback triggered: ${stripErr instanceof Error ? stripErr.message : String(stripErr)}`
                );
                lazyStrippedBytes = pdfBytes;
              }
            }
            sourceBytes = lazyStrippedBytes;
          }
          const png = await this.rasterizeSinglePageWithGhostscript(sourceBytes, pageNum, targetDpi);
          pagePngCache.set(key, png);
          return png;
        };

        const headerLogoCache = new Map<string, string>();
        const pages: LayoutPage[] = [];
        let regionSeq = 1;

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
          const page = await pdfDoc.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1.0 });
          const widthIn = roundIn(viewport.width / PT_PER_INCH);
          const heightIn = roundIn(viewport.height / PT_PER_INCH);

          const textContent = await page.getTextContent();
          const rawItems = (textContent.items as PdfTextItem[]).filter(
            (item) => typeof item.str === 'string' && item.str.trim().length > 0
          );
          const isDigitalVectorPage = rawItems.length > 0;

          // Record Canvas2D vector operations + textColorEvents via VirtualCanvas proxy (captures XObjects/gradients cleanly)
          const recCanvas = createRecordingCanvas(viewport.width, viewport.height);
          try {
            await page.render({
              canvasContext: recCanvas.getContext('2d') as unknown as CanvasRenderingContext2D,
              viewport,
              canvas: null,
            }).promise;
          } catch (renderErr) {
            this.logger.warn(
              'PdfAnalysis',
              `Canvas2D vector recording warning on page ${pageNum}: ${renderErr instanceof Error ? renderErr.message : String(renderErr)}`
            );
          }

          // Channel 1: Text-Masked Canvas Pixel Geometry Scanner at scale = 2 (144 DPI)
          const textBoxesPt: TextBoxPt[] = rawItems.map((it) => {
            const tx = it.transform;
            const fontSizePt = Math.max(5.5, Math.hypot(tx[0], tx[1]) || Math.hypot(tx[2], tx[3]) || 10);
            const yBaselinePt = viewport.height - tx[5];
            const yTopPt = Math.max(0, yBaselinePt - fontSizePt * 0.85);
            const wPt = Math.max(it.width || it.str.length * fontSizePt * 0.5, 4);
            const hPt = Math.max(it.height || fontSizePt * 1.15, fontSizePt * 1.07);
            return { x: tx[4], y: yTopPt, width: wPt, height: hPt };
          });

          const scale2Png = gs144Pngs[pageNum - 1] ?? (await getSinglePagePng(pageNum, 144, false));
          let rgbaScale2: { width: number; height: number; data: Uint8Array | Uint8ClampedArray } | undefined;
          if (scale2Png) {
            try {
              const decoded = PNG.sync.read(scale2Png);
              rgbaScale2 = { width: decoded.width, height: decoded.height, data: decoded.data };
            } catch {
              rgbaScale2 = undefined;
            }
          }
          if (!rgbaScale2) {
            rgbaScale2 = rasterizePrimitivesToRgba(recCanvas._recorder, viewport.width, viewport.height, 2);
          }

          const printableWidthPt = Math.max(viewport.width * 0.75, viewport.width - 72);
          const pixelGeom = scanPixelGeometry(
            rgbaScale2,
            viewport.width,
            viewport.height,
            textBoxesPt,
            printableWidthPt
          );

          // Fuse Channel 1 pixel geometry + Canvas2D vector proxy primitives (preserving razor-thin CTM hairlines)
          const deduped = deduplicateVectorPrimitives({
            hLines: [...recCanvas._recorder.hLines, ...pixelGeom.hLines],
            vLines: [...recCanvas._recorder.vLines, ...pixelGeom.vLines],
            fillBoxes: [...recCanvas._recorder.fillBoxes, ...pixelGeom.fillBoxes],
            curveBoxes: recCanvas._recorder.curveBoxes,
            imageBoxes: recCanvas._recorder.imageBoxes,
            textColorEvents: recCanvas._recorder.textColorEvents,
          });

          const mergeFillCollection = (
            base: VectorFillBox[],
            predicate: (fb: VectorFillBox) => boolean
          ): VectorFillBox[] => {
            const out: VectorFillBox[] = [...base];
            for (const fb of deduped.fillBoxes) {
              if (!predicate(fb)) continue;
              const dup = out.some(
                (o) =>
                  Math.abs(o.x - fb.x) <= 3 &&
                  Math.abs(o.y - fb.y) <= 3 &&
                  Math.abs(o.width - fb.width) <= 4 &&
                  Math.abs(o.height - fb.height) <= 4
              );
              if (!dup) out.push(fb);
            }
            return out.sort((a, b) => a.y - b.y || a.x - b.x);
          };

          const fillBanners = mergeFillCollection(
            pixelGeom.fillBanners,
            (fb) =>
              fb.height >= 12 &&
              fb.width >= 0.35 * printableWidthPt &&
              hexLuminancePt(fb.fillHex) < 0.75
          );
          const fillBands = mergeFillCollection(
            pixelGeom.fillBands,
            (fb) => {
              const lum = hexLuminancePt(fb.fillHex);
              return lum >= 0.75 && lum <= 0.975 && fb.height >= 8 && fb.width >= 16;
            }
          );

          const pageVectorPrimitives: PageVectorPrimitives = {
            unit: 'pt',
            pageWidthPt: roundPt(viewport.width),
            pageHeightPt: roundPt(viewport.height),
            hLines: deduped.hLines,
            vLines: deduped.vLines,
            fillBoxes: deduped.fillBoxes,
            fillBanners,
            fillBands,
          };

          const vectorRects: RawVectorRect[] = [
            ...deduped.hLines.map((hl) => ({
              x: hl.x1 / PT_PER_INCH,
              y: hl.y / PT_PER_INCH,
              width: Math.max(0.005, (hl.x2 - hl.x1) / PT_PER_INCH),
              height: Math.max(0.005, (hl.lineWidthPt || 0.75) / PT_PER_INCH),
              strokeColor: hl.strokeColor ?? '#94A3B8',
              lineWidthPt: hl.lineWidthPt || 0.75,
            })),
            ...deduped.vLines.map((vl) => ({
              x: vl.x / PT_PER_INCH,
              y: vl.y1 / PT_PER_INCH,
              width: Math.max(0.005, (vl.lineWidthPt || 0.75) / PT_PER_INCH),
              height: Math.max(0.005, (vl.y2 - vl.y1) / PT_PER_INCH),
              strokeColor: vl.strokeColor ?? '#94A3B8',
              lineWidthPt: vl.lineWidthPt || 0.75,
            })),
            ...deduped.fillBoxes.map((fb) => ({
              x: fb.x / PT_PER_INCH,
              y: fb.y / PT_PER_INCH,
              width: fb.width / PT_PER_INCH,
              height: fb.height / PT_PER_INCH,
              fillColor: fb.fillHex,
              strokeColor: fb.strokeColor,
              lineWidthPt: fb.lineWidthPt ?? 0.75,
            })),
          ];

          const imageBoxes = deduped.imageBoxes.map((b) => ({
            x: b.x / PT_PER_INCH,
            y: b.y / PT_PER_INCH,
            width: b.width / PT_PER_INCH,
            height: b.height / PT_PER_INCH,
          }));

          const complexClusterBoxes: Array<{
            x: number;
            y: number;
            width: number;
            height: number;
            fallbackRect?: RawVectorRect;
          }> = [];
          const clusterPad = 0.12;
          for (const cbPt of deduped.curveBoxes) {
            const cb = {
              x: cbPt.x / PT_PER_INCH,
              y: cbPt.y / PT_PER_INCH,
              width: cbPt.width / PT_PER_INCH,
              height: cbPt.height / PT_PER_INCH,
              fallbackRect:
                cbPt.width / PT_PER_INCH > 0.2 && cbPt.height / PT_PER_INCH > 0.12
                  ? {
                      x: cbPt.x / PT_PER_INCH,
                      y: cbPt.y / PT_PER_INCH,
                      width: cbPt.width / PT_PER_INCH,
                      height: cbPt.height / PT_PER_INCH,
                      fillColor: cbPt.fillHex,
                      strokeColor: cbPt.strokeColor,
                      lineWidthPt: cbPt.lineWidthPt ?? 0.75,
                    }
                  : undefined,
            };
            const merged = complexClusterBoxes.find(
              (existing) =>
                cb.x <= existing.x + existing.width + clusterPad &&
                cb.x + cb.width >= existing.x - clusterPad &&
                cb.y <= existing.y + existing.height + clusterPad &&
                cb.y + cb.height >= existing.y - clusterPad
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
              if (!merged.fallbackRect && cb.fallbackRect) merged.fallbackRect = cb.fallbackRect;
            } else {
              complexClusterBoxes.push(cb);
            }
          }
          const filteredClusterBoxes = complexClusterBoxes.filter(
            (b) =>
              Math.max(b.width, b.height) >= 0.14 &&
              Math.min(b.width, b.height) >= 0.08 &&
              b.width <= widthIn + 0.05 &&
              b.height <= 4.5
          );

          const textColorEvents: TextColorEvent[] = deduped.textColorEvents.map((ev) => ({
            x: ev.x / PT_PER_INCH,
            y: ev.y / PT_PER_INCH,
            color: ev.color,
          }));

          const regions: LayoutRegion[] = [];

        const enrichedStyles: Record<string, { fontFamily?: string }> = {
          ...(textContent.styles ?? {}),
        };
        for (const item of rawItems) {
          if (!item.fontName) continue;
          try {
            if (page.commonObjs.has(item.fontName)) {
              const fontObj = page.commonObjs.get(item.fontName) as { name?: string } | undefined;
              if (fontObj?.name) {
                const prevFamily = enrichedStyles[item.fontName]?.fontFamily ?? '';
                enrichedStyles[item.fontName] = {
                  fontFamily: `${fontObj.name} ${prevFamily}`.trim(),
                };
              }
            }
          } catch {
            // Ignore unresolved pdfjs commonObjs font entries
          }
        }

        const {
          mergedLines,
          brokenGlyphSpans,
          deduplicatedSpans,
        } = this.extractNormalizedTextLines(
          rawItems,
          viewport.height,
          enrichedStyles,
          textColorEvents,
          vectorRects
        );

        // Detect top-left brand graphic + wordmark cluster in top margin (y < 0.12 * H) for 300 DPI HeaderLogo crop
        const topLimitIn = heightIn * 0.12;
        const leftZoneMaxIn = widthIn * 0.45;
        const headerLogoCandidates = [
          ...imageBoxes.map((b, idx) => ({ ...b, source: 'img' as const, idx })),
          ...filteredClusterBoxes
            .filter((b) => {
              const overlapsText = mergedLines.some(
                (ln) =>
                  ln.x < b.x + b.width + 0.02 &&
                  ln.x + ln.width > b.x - 0.02 &&
                  ln.y < b.y + b.height + 0.02 &&
                  ln.y + ln.height > b.y - 0.02
              );
              const strictlyInsideLine = mergedLines.some(
                (ln) =>
                  b.x >= ln.x - 0.01 &&
                  b.x + b.width <= ln.x + ln.width + 0.01 &&
                  b.y >= ln.y - 0.01 &&
                  b.y + b.height <= ln.y + ln.height + 0.01
              );
              return !(overlapsText && b.width < 0.45 && b.height < 0.45 && strictlyInsideLine);
            })
            .map((b, idx) => ({ ...b, source: 'cluster' as const, idx })),
        ].filter(
          (b) =>
            b.y < topLimitIn &&
            b.y + b.height <= heightIn * 0.15 &&
            b.x < widthIn * 0.35 &&
            b.width >= 0.12 &&
            b.width <= widthIn * 0.42 &&
            b.height >= 0.10 &&
            b.height <= 0.90
        );

        let headerLogoBox: { x: number; y: number; width: number; height: number } | undefined;
        const absorbedHeaderImageIdxs = new Set<number>();
        const absorbedHeaderClusterIdxs = new Set<number>();
        const absorbedHeaderLineIdxs = new Set<number>();

        if (headerLogoCandidates.length > 0) {
          headerLogoCandidates.sort((a, b) => a.x - b.x || a.y - b.y);
          const seed = headerLogoCandidates[0];
          let minX = seed.x;
          let minY = seed.y;
          let maxX = seed.x + seed.width;
          let maxY = seed.y + seed.height;

          // Merge adjacent top-left graphic components (brand icon + vector wordmark strokes)
          let changed = true;
          while (changed) {
            changed = false;
            for (const cand of headerLogoCandidates) {
              const cx2 = cand.x + cand.width;
              const cy2 = cand.y + cand.height;
              const alreadyInside =
                cand.x >= minX - 0.005 && cx2 <= maxX + 0.005 && cand.y >= minY - 0.005 && cy2 <= maxY + 0.005;
              const horizAdjacent = cand.x <= maxX + 0.45 && cx2 >= minX - 0.25 && cx2 <= leftZoneMaxIn;
              const vertAligned = cand.y <= maxY + 0.08 && cy2 >= minY - 0.08;
              if (!alreadyInside && horizAdjacent && vertAligned) {
                minX = Math.min(minX, cand.x);
                minY = Math.min(minY, cand.y);
                maxX = Math.max(maxX, cx2);
                maxY = Math.max(maxY, cy2);
                changed = true;
              }
            }
          }

          // Include adjacent wordmark text span in top-left (same vertical band, to the right within 0.45in)
          for (let lIdx = 0; lIdx < mergedLines.length; lIdx++) {
            const ln = mergedLines[lIdx];
            if (ln.y >= topLimitIn || ln.x + ln.width > leftZoneMaxIn) continue;
            if (ln.text.trim().length > 32) continue;
            const vertOverlap = Math.min(maxY + 0.08, ln.y + ln.height) - Math.max(minY - 0.08, ln.y);
            const horizClose = ln.x <= maxX + 0.45 && ln.x + ln.width >= minX - 0.1;
            if (vertOverlap > 0 && horizClose) {
              minX = Math.min(minX, ln.x);
              minY = Math.min(minY, ln.y);
              maxX = Math.max(maxX, ln.x + ln.width);
              maxY = Math.max(maxY, ln.y + ln.height);
              absorbedHeaderLineIdxs.add(lIdx);
            }
          }

          // Include any thin non-full-width colored vector rects inside this brand logo cluster
          for (const vr of vectorRects) {
            if (
              vr.width < widthIn * 0.42 &&
              vr.height < 0.9 &&
              vr.x >= minX - 0.05 &&
              vr.x + vr.width <= maxX + 0.05 &&
              vr.y >= minY - 0.05 &&
              vr.y + vr.height <= maxY + 0.05
            ) {
              minX = Math.min(minX, vr.x);
              minY = Math.min(minY, vr.y);
              maxX = Math.max(maxX, vr.x + vr.width);
              maxY = Math.max(maxY, vr.y + vr.height);
            }
          }

          const padIn = 2 / PT_PER_INCH;
          const bx = Math.max(0, minX - padIn);
          const by = Math.max(0, minY - padIn);
          headerLogoBox = {
            x: roundIn(bx),
            y: roundIn(by),
            width: roundIn(Math.min(widthIn - bx, maxX - minX + padIn * 2)),
            height: roundIn(Math.min(heightIn - by, maxY - minY + padIn * 2)),
          };

          imageBoxes.forEach((b, idx) => {
            if (
              b.x < headerLogoBox!.x + headerLogoBox!.width + 0.02 &&
              b.x + b.width > headerLogoBox!.x - 0.02 &&
              b.y < headerLogoBox!.y + headerLogoBox!.height + 0.02 &&
              b.y + b.height > headerLogoBox!.y - 0.02
            ) {
              absorbedHeaderImageIdxs.add(idx);
            }
          });
          filteredClusterBoxes.forEach((b, idx) => {
            if (
              b.x < headerLogoBox!.x + headerLogoBox!.width + 0.02 &&
              b.x + b.width > headerLogoBox!.x - 0.02 &&
              b.y < headerLogoBox!.y + headerLogoBox!.height + 0.02 &&
              b.y + b.height > headerLogoBox!.y - 0.02
            ) {
              absorbedHeaderClusterIdxs.add(idx);
            }
          });

          const logoSig = `${Math.round(headerLogoBox.x * 20)}:${Math.round(headerLogoBox.y * 20)}:${Math.round(headerLogoBox.width * 20)}:${Math.round(headerLogoBox.height * 20)}`;
          let logoBase64 = headerLogoCache.get(logoSig);
          if (!logoBase64) {
            const hiResPng = await getSinglePagePng(pageNum, 300, false);
            logoBase64 = await this.cropPageRegionToBase64(hiResPng, headerLogoBox, widthIn, heightIn);
            if (logoBase64) headerLogoCache.set(logoSig, logoBase64);
          }

          if (logoBase64) {
            regions.push({
              id: `region-${String(regionSeq++).padStart(4, '0')}`,
              pageNumber: pageNum,
              type: 'image',
              x: headerLogoBox.x,
              y: headerLogoBox.y,
              width: headerLogoBox.width,
              height: headerLogoBox.height,
              style: defaultStyle(),
              semanticRole: 'logoOrGraphic',
              confidence: 0.99,
              bandKind: 'Header',
              isAmbiguous: false,
              preferImageFallback: true,
              imageAssetBase64: logoBase64,
              imageAssetName: 'HeaderLogo',
              sourceObjectRefs: [`p${pageNum}-header-logo`],
            });
          }
        }

        for (let idx = 0; idx < vectorRects.length; idx++) {
          const vr = vectorRects[idx];
          if (
            headerLogoBox &&
            vr.width < widthIn * 0.42 &&
            vr.height < 0.9 &&
            vr.x >= headerLogoBox.x - 0.03 &&
            vr.x + vr.width <= headerLogoBox.x + headerLogoBox.width + 0.03 &&
            vr.y >= headerLogoBox.y - 0.03 &&
            vr.y + vr.height <= headerLogoBox.y + headerLogoBox.height + 0.03
          ) {
            continue;
          }
          const isLine = vr.height <= 0.04 || vr.width <= 0.04;
          const minDim = isLine ? 0.006 : 0.015;
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
            width: roundIn(Math.max(minDim, vr.width)),
            height: roundIn(Math.max(minDim, vr.height)),
            style,
            semanticRole: 'unknown',
            confidence: 0.95,
            bandKind: classifyBandHeuristic(vr.y, heightIn),
            isAmbiguous: false,
            sourceObjectRefs: [`p${pageNum}-vec-${idx}`],
          });
        }

        for (let idx = 0; idx < imageBoxes.length; idx++) {
          if (absorbedHeaderImageIdxs.has(idx)) continue;
          const box = imageBoxes[idx];
          const srcPng =
            (await getSinglePagePng(pageNum, dpi, true)) ?? (await getSinglePagePng(pageNum, dpi, false));
          const croppedBase64 = await this.cropPageRegionToBase64(srcPng, box, widthIn, heightIn);
          if (!croppedBase64) continue;
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

        let brokenGlyphRegions = 0;
        for (let idx = 0; idx < brokenGlyphSpans.length; idx++) {
          const bSpan = brokenGlyphSpans[idx];
          const padIn = 0.008;
          const cropBox = {
            x: Math.max(0, bSpan.x - padIn),
            y: Math.max(0, bSpan.y - padIn),
            width: Math.min(widthIn - Math.max(0, bSpan.x - padIn), bSpan.width + padIn * 2),
            height: Math.min(heightIn - Math.max(0, bSpan.y - padIn), bSpan.height + padIn * 2),
          };
          const rawPng = await getSinglePagePng(pageNum, dpi, false);
          const croppedBase64 = await this.cropPageRegionToBase64(rawPng, cropBox, widthIn, heightIn);
          if (!croppedBase64) continue;
          brokenGlyphRegions++;
          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'image',
            x: roundIn(cropBox.x),
            y: roundIn(cropBox.y),
            width: roundIn(cropBox.width),
            height: roundIn(cropBox.height),
            style: defaultStyle(),
            semanticRole: 'logoOrGraphic',
            confidence: 0.99,
            bandKind: classifyBandHeuristic(cropBox.y, heightIn),
            isAmbiguous: false,
            preferImageFallback: true,
            imageAssetBase64: croppedBase64,
            imageAssetName: `GlyphCrop_P${pageNum}_${brokenGlyphRegions}`,
            sourceObjectRefs: [`p${pageNum}-glyph-${brokenGlyphRegions}`],
          });
        }

        const iconClusters: Array<{ x: number; y: number; width: number; height: number; fallbackRect?: RawVectorRect }> = [];
        for (let cIdx = 0; cIdx < filteredClusterBoxes.length; cIdx++) {
          if (absorbedHeaderClusterIdxs.has(cIdx)) continue;
          const box = filteredClusterBoxes[cIdx];
          const enclosedText = mergedLines.filter(
            (ln) =>
              ln.x >= box.x - 0.08 &&
              ln.x + ln.width <= box.x + box.width + 0.08 &&
              ln.y >= box.y - 0.08 &&
              ln.y + ln.height <= box.y + box.height + 0.08
          );
          const overlapsText = mergedLines.some(
            (ln) =>
              ln.x < box.x + box.width + 0.02 &&
              ln.x + ln.width > box.x - 0.02 &&
              ln.y < box.y + box.height + 0.02 &&
              ln.y + ln.height > box.y - 0.02
          );
          const isTopCoverBanner = box.y < 1.8 && box.width > 2.0 && box.height >= 0.4;
          if (!isTopCoverBanner && ((box.width > 2.2 && enclosedText.length >= 2) || enclosedText.length >= 4)) {
            if (box.fallbackRect) {
              const fb = box.fallbackRect;
              const isLine = fb.height <= 0.04 || fb.width <= 0.04;
              regions.push({
                id: `region-${String(regionSeq++).padStart(4, '0')}`,
                pageNumber: pageNum,
                type: isLine ? 'vector_line' : 'vector_rect',
                x: roundIn(fb.x),
                y: roundIn(fb.y),
                width: roundIn(Math.max(0.015, fb.width)),
                height: roundIn(Math.max(0.015, fb.height)),
                style: {
                  ...defaultStyle(),
                  backgroundColor: fb.fillColor,
                  borderColor: fb.strokeColor,
                  borderWidthPt: fb.lineWidthPt,
                },
                semanticRole: 'unknown',
                confidence: 0.9,
                bandKind: classifyBandHeuristic(fb.y, heightIn),
                isAmbiguous: false,
                sourceObjectRefs: [`p${pageNum}-vc-rect`],
              });
            }
            continue;
          }
          if (overlapsText && box.width < 0.45 && box.height < 0.45 && enclosedText.length === 0) {
            const strictlyInsideLine = mergedLines.some(
              (ln) =>
                box.x >= ln.x - 0.01 &&
                box.x + box.width <= ln.x + ln.width + 0.01 &&
                box.y >= ln.y - 0.01 &&
                box.y + box.height <= ln.y + ln.height + 0.01
            );
            if (strictlyInsideLine) continue;
          }
          iconClusters.push(box);
        }

        for (let idx = 0; idx < iconClusters.length; idx++) {
          const box = iconClusters[idx];
          const srcPng =
            (await getSinglePagePng(pageNum, dpi, true)) ?? (await getSinglePagePng(pageNum, dpi, false));
          const croppedBase64 = await this.cropPageRegionToBase64(srcPng, box, widthIn, heightIn);
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
          if (absorbedHeaderLineIdxs.has(idx)) continue;
          const line = mergedLines[idx];
          const bandKind = classifyBandHeuristic(line.y, heightIn);
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

          const textAlign: 'Left' | 'Center' | 'Right' = 'Left';
          const style: RegionStyle = {
            fontFamily: line.fontFamily,
            fontSizePt: Math.round(line.fontSizePt * 10) / 10,
            bold: line.bold,
            italic: line.italic,
            underline: line.underline,
            color: line.color,
            backgroundColor: enclosingRect?.fillColor,
            borderColor: enclosingRect?.strokeColor,
            borderWidthPt: enclosingRect?.lineWidthPt,
            textAlign,
            verticalAlign: 'Top',
            paddingPt: { top: 0, right: 0, bottom: 0, left: 0 },
          };

          regions.push({
            id: `region-${String(regionSeq++).padStart(4, '0')}`,
            pageNumber: pageNum,
            type: 'text',
            x: roundIn(line.x),
            y: roundIn(line.y),
            width: roundIn(Math.max(0.08, line.width)),
            height: roundIn(Math.max(0.08, line.height)),
            text: line.text,
            runs: line.runs,
            style,
            semanticRole: 'unknown',
            confidence: 0.92,
            bandKind,
            isAmbiguous: false,
            sourceObjectRefs: [`p${pageNum}-txt-${idx}`],
          });
        }

        // Fallback image capture ONLY when a page contains zero extractable vector text characters
        let fallbackPreviewPng: Buffer | undefined;
        if (!isDigitalVectorPage && imageBoxes.length === 0 && iconClusters.length === 0) {
          fallbackPreviewPng = await getSinglePagePng(pageNum, dpi, false);
          if (fallbackPreviewPng) {
            regions.push({
              id: `region-${String(regionSeq++).padStart(4, '0')}`,
              pageNumber: pageNum,
              type: 'image',
              x: 0,
              y: 0,
              width: widthIn,
              height: heightIn,
              style: defaultStyle(),
              semanticRole: 'logoOrGraphic',
              confidence: 0.8,
              bandKind: 'Detail',
              isAmbiguous: true,
              preferImageFallback: true,
              imageAssetBase64: fallbackPreviewPng.toString('base64'),
              imageAssetName: `ScannedPage_P${pageNum}`,
              sourceObjectRefs: [`p${pageNum}-scanned`],
            });
          }
        }

        const rawObjectCount = rawItems.length + vectorRects.length + imageBoxes.length;
        this.logger.info('PdfAnalysis', `Page ${pageNum} analyzed`, {
          mode: isDigitalVectorPage ? 'native-vector' : 'raster-fallback',
          rawObjects: rawObjectCount,
          normalizedRegions: regions.length,
          localizedGraphics: imageBoxes.length + iconClusters.length + (headerLogoBox ? 1 : 0),
          brokenGlyphRegions,
          deduplicatedSpans,
        });

        pages.push({
          pageNumber: pageNum,
          width: widthIn,
          height: heightIn,
          rawObjectCount,
          regions,
          bands: [],
          vectorPrimitives: pageVectorPrimitives,
          rasterPreviewBase64: fallbackPreviewPng?.toString('base64'),
          brokenGlyphRegions,
          deduplicatedSpans,
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
          extractedAt: 'deterministic',
        },
        pages,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('PdfAnalysis', `PDF analysis failed: ${msg}`);
      throw new ReportGenError(ReportGenErrorCode.PDF_ANALYSIS_FAILED, msg, err);
    }
    });
  }

  private extractNormalizedTextLines(
    items: PdfTextItem[],
    pageHeightPt: number,
    styles: Record<string, { fontFamily?: string }>,
    textColorEvents: TextColorEvent[],
    vectorRects: RawVectorRect[]
  ): {
    mergedLines: MergedTextLine[];
    brokenGlyphSpans: NormalizedSpan[];
    deduplicatedSpans: number;
  } {
    const matchTextColor = (x: number, y: number): string => {
      let sameLineColor: string | undefined;
      let sameLineScore = Infinity;
      for (const ev of textColorEvents) {
        if (Math.abs(ev.y - y) <= 0.045) {
          const dx = Math.abs(ev.x - x);
          const score = ev.x <= x + 0.05 ? dx : dx + 0.4;
          if (score < sameLineScore) {
            sameLineScore = score;
            sameLineColor = ev.color;
          }
        }
      }
      if (sameLineColor && sameLineScore <= 7.8) {
        return sameLineColor;
      }
      let bestColor = '#0F172A';
      let bestDist = 0.35;
      for (const ev of textColorEvents) {
        const d = Math.hypot(ev.x - x, ev.y - y);
        if (d < bestDist) {
          bestDist = d;
          bestColor = ev.color;
        }
      }
      return bestColor;
    };

    const thinHorizLines = vectorRects.filter((r) => r.height <= 0.03 && r.width >= 0.1);
    const hasUnderlineBelow = (x: number, yBottom: number, width: number): boolean => {
      return thinHorizLines.some((ln) => {
        if (Math.abs(ln.y - yBottom) > 0.045) return false;
        const overlap = Math.min(x + width, ln.x + ln.width) - Math.max(x, ln.x);
        return overlap >= Math.min(width, ln.width) * 0.72;
      });
    };

    const rawSpans: NormalizedSpan[] = items.map((it) => {
      const tx = it.transform;
      const fontSizePt = Math.max(5.5, Math.hypot(tx[0], tx[1]) || Math.hypot(tx[2], tx[3]) || 10);
      const xPt = tx[4];
      const yBaselineIn = (pageHeightPt - tx[5]) / PT_PER_INCH;
      const yTopPt = pageHeightPt - tx[5] - fontSizePt * 0.85;
      const wPt = Math.max(it.width || it.str.length * fontSizePt * 0.5, 4);
      const hPt = Math.max(it.height || fontSizePt * 1.2, fontSizePt * 1.15);
      const xIn = xPt / PT_PER_INCH;
      const yIn = Math.max(0, yTopPt / PT_PER_INCH);
      const widthIn = wPt / PT_PER_INCH;
      const heightIn = hPt / PT_PER_INCH;
      const loadedName = styles[it.fontName]?.fontFamily;
      const flags = inferFontFlags(it.fontName, loadedName);
      const normText = normalizeLigatures(it.str);
      return {
        text: normText,
        x: xIn,
        y: yIn,
        baselineY: yBaselineIn,
        width: widthIn,
        height: heightIn,
        fontSizePt,
        fontName: it.fontName,
        fontLoadedName: loadedName,
        fontFamily: flags.family,
        bold: flags.bold,
        italic: flags.italic,
        underline: hasUnderlineBelow(xIn, yBaselineIn + 0.02, widthIn),
        color: matchTextColor(xIn, yBaselineIn),
        brokenGlyph: hasBrokenGlyphs(normText),
      };
    });

    const brokenGlyphSpans = rawSpans.filter((s) => s.brokenGlyph);
    const cleanSpans = rawSpans.filter((s) => !s.brokenGlyph);

    cleanSpans.sort((a, b) =>
      Math.abs(a.baselineY - b.baselineY) * PT_PER_INCH <= 1.5 ? a.x - b.x : a.baselineY - b.baselineY
    );

    // Step A: Deduplicate fake-bold / double-stroked / stacked duplicate spans
    const dedupedSpans: NormalizedSpan[] = [];
    let deduplicatedSpans = 0;
    for (const cur of cleanSpans) {
      const curTrim = cur.text.trim();
      const maxVertDup = Math.max(0.025, (cur.fontSizePt / PT_PER_INCH) * 0.72);
      const dup = dedupedSpans.find(
        (prev) =>
          prev.text.trim() === curTrim &&
          Math.abs(prev.x - cur.x) <= 0.025 &&
          Math.abs(prev.baselineY - cur.baselineY) <= maxVertDup &&
          Math.abs(prev.fontSizePt - cur.fontSizePt) <= 0.8 &&
          prev.color === cur.color
      );
      if (dup) {
        dup.bold = true;
        deduplicatedSpans++;
      } else {
        dedupedSpans.push({ ...cur });
      }
    }

    // Build vertical edge barriers from vector lines & bordered/filled rectangles
    const verticalBarriers: Array<{ x: number; y1: number; y2: number }> = [];
    for (const vr of vectorRects) {
      if (vr.width <= 0.05 && vr.height >= 0.10) {
        verticalBarriers.push({ x: vr.x + vr.width / 2, y1: vr.y, y2: vr.y + vr.height });
      } else if (vr.width >= 0.2 && vr.height >= 0.14 && (vr.fillColor || vr.strokeColor)) {
        verticalBarriers.push({ x: vr.x, y1: vr.y, y2: vr.y + vr.height });
        verticalBarriers.push({ x: vr.x + vr.width, y1: vr.y, y2: vr.y + vr.height });
      }
    }
    const crossesVerticalBarrier = (xLeft: number, xRight: number, yTop: number, yBot: number): boolean => {
      const yMid = (yTop + yBot) / 2;
      return verticalBarriers.some(
        (vb) => vb.x >= xLeft - 0.015 && vb.x <= xRight + 0.015 && yMid >= vb.y1 - 0.04 && yMid <= vb.y2 + 0.04
      );
    };

    // Step B: Merge horizontal spans sharing the same baseline (|Δy| <= 1.5pt), preserving full-justified lines
    const mergedLines: MergedTextLine[] = [];
    for (const cur of dedupedSpans) {
      const prev = mergedLines[mergedLines.length - 1];
      const gapIn = prev ? cur.x - (prev.x + prev.width) : Infinity;
      const gapPt = gapIn * PT_PER_INCH;

      const prevBaselineY = prev ? prev.y + (prev.fontSizePt * 0.85) / PT_PER_INCH : 0;
      const curTrim = cur.text.trim();
      const prevTrim = prev ? prev.text.trim() : '';
      const minFontPt = prev ? Math.min(prev.fontSizePt, cur.fontSizePt) : cur.fontSizePt;

      const sameBaselineY = prev && Math.abs(prevBaselineY - cur.baselineY) * PT_PER_INCH <= 1.5;
      const blockedByColon = Boolean(
        prev &&
          ((prevTrim.endsWith(':') && gapPt > minFontPt * 0.55) ||
            (curTrim === ':' && gapPt > minFontPt * 0.65) ||
            (prevTrim === '=' && gapPt > minFontPt * 0.55) ||
            (curTrim === '=' && gapPt > minFontPt * 0.65))
      );
      const isHangingMarker = /^(?:\d+(?:\.\d+)*[\.\)]|\([a-z0-9]+\)|[a-z][\.\)]|[•●○▪▫■□‣⁃\-–*])$/i.test(
        prevTrim
      );
      const blockedByHangingMarker = Boolean(prev && isHangingMarker && gapPt > minFontPt * 0.35);
      const blockedByBarrier = Boolean(
        prev &&
          gapPt > minFontPt * 0.25 &&
          crossesVerticalBarrier(
            prev.x + prev.width,
            cur.x,
            Math.min(prev.y, cur.y),
            Math.max(prev.y + prev.height, cur.y + cur.height)
          )
      );

      const maxJustifiedGapPt = minFontPt * 1.8;
      const sameBaseline =
        Boolean(sameBaselineY) &&
        gapPt >= -2.5 &&
        gapPt <= maxJustifiedGapPt &&
        Math.abs(prev!.fontSizePt - cur.fontSizePt) <= 2.2 &&
        !blockedByColon &&
        !blockedByHangingMarker &&
        !blockedByBarrier;

      if (sameBaseline && prev) {
        const lastRun = prev.runs[prev.runs.length - 1];
        const lastChar = lastRun.text.slice(-1);
        const firstChar = cur.text.charAt(0);
        const parenAlphaTransition = lastChar === ')' && /^[A-Za-z0-9]/.test(firstChar);
        const keepParenNumberTight =
          (lastChar === '(' && /^[0-9.,-]/.test(firstChar) && gapPt <= minFontPt * 0.35) ||
          (/^[),.;:%]$/.test(firstChar) && gapPt <= minFontPt * 0.35);

        const needsSpace =
          !keepParenNumberTight &&
          !lastRun.text.endsWith(' ') &&
          !cur.text.startsWith(' ') &&
          (gapPt > minFontPt * 0.18 || parenAlphaTransition);
        const spacer = needsSpace ? ' ' : '';

        const sameRunStyle =
          lastRun.fontFamily === cur.fontFamily &&
          Math.abs(lastRun.fontSizePt - cur.fontSizePt) <= 0.3 &&
          lastRun.bold === cur.bold &&
          lastRun.italic === cur.italic &&
          Boolean(lastRun.underline) === cur.underline &&
          lastRun.color === cur.color;

        if (sameRunStyle) {
          lastRun.text = `${lastRun.text}${spacer}${cur.text}`.replace(/ {2,}/g, ' ');
        } else {
          if (spacer && !lastRun.text.endsWith(' ')) {
            lastRun.text = `${lastRun.text} `;
          }
          prev.runs.push({
            text: cur.text.replace(/^ +/, needsSpace ? '' : ' '),
            fontFamily: cur.fontFamily,
            fontSizePt: Math.round(cur.fontSizePt * 10) / 10,
            bold: cur.bold,
            italic: cur.italic,
            underline: cur.underline || undefined,
            color: cur.color,
          });
        }

        prev.text = prev.runs.map((r) => r.text).join('').trim();
        prev.width = Math.max(prev.width, cur.x + cur.width - prev.x);
        prev.height = Math.max(prev.height, cur.height);
        prev.y = Math.min(prev.y, cur.y);
      } else {
        const initialText = cur.text.trim();
        if (!initialText) continue;
        mergedLines.push({
          text: initialText,
          runs: [
            {
              text: initialText,
              fontFamily: cur.fontFamily,
              fontSizePt: Math.round(cur.fontSizePt * 10) / 10,
              bold: cur.bold,
              italic: cur.italic,
              underline: cur.underline || undefined,
              color: cur.color,
            },
          ],
          x: cur.x,
          y: cur.y,
          width: cur.width,
          height: cur.height,
          fontSizePt: cur.fontSizePt,
          fontFamily: cur.fontFamily,
          bold: cur.bold,
          italic: cur.italic,
          underline: cur.underline,
          color: cur.color,
        });
      }
    }

    return { mergedLines, brokenGlyphSpans, deduplicatedSpans };
  }

  private async rasterizeSinglePageWithGhostscript(
    pdfBytes: Uint8Array,
    pageNum: number,
    dpi = 150
  ): Promise<Buffer | undefined> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportgen-gs-pg-'));
    const inputPath = path.join(tmpDir, 'input.pdf');
    const outFile = path.join(tmpDir, 'page.png');
    try {
      fs.writeFileSync(inputPath, pdfBytes);
      await execFileAsync('gs', [
        '-dNOPAUSE',
        '-dBATCH',
        `-dFirstPage=${pageNum}`,
        `-dLastPage=${pageNum}`,
        '-sDEVICE=png16m',
        `-r${dpi}`,
        `-sOutputFile=${outFile}`,
        inputPath,
      ]);
      return fs.existsSync(outFile) ? fs.readFileSync(outFile) : undefined;
    } catch {
      return undefined;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  public async rasterizePagesWithGhostscript(pdfBytes: Uint8Array, dpi = 150): Promise<Buffer[]> {
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
