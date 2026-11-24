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
  VisualTextRun,
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
      let lazyStrippedPreviews: Buffer[] | null = null;
      const getTextStrippedPagePng = async (pageIdxZeroBased: number): Promise<Buffer | undefined> => {
        if (lazyStrippedPreviews === null) {
          try {
            const strippedBytes = await this.stripTextOperatorsFromPdf(pdfBytes);
            lazyStrippedPreviews = await this.rasterizePagesWithGhostscript(strippedBytes, dpi);
          } catch (stripErr) {
            this.logger.warn(
              'PdfAnalysis',
              `Text-stripped crop fallback triggered: ${stripErr instanceof Error ? stripErr.message : String(stripErr)}`
            );
            lazyStrippedPreviews = [];
          }
        }
        return lazyStrippedPreviews.length === numPages
          ? lazyStrippedPreviews[pageIdxZeroBased]
          : pagePreviews[pageIdxZeroBased];
      };

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
          const box = imageBoxes[idx];
          const srcPng = (await getTextStrippedPagePng(pageNum - 1)) ?? pagePreviews[pageNum - 1];
          const croppedBase64 = await this.cropPageRegionToBase64(
            srcPng,
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
          const croppedBase64 = await this.cropPageRegionToBase64(
            pagePreviews[pageNum - 1],
            cropBox,
            widthIn,
            heightIn
          );
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
        for (const box of complexClusterBoxes) {
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
          // Filter out multi-line rounded-corner text containers unless fallbackRect converts them to native rectangles
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
          // Skip tiny curves that were merely curved vector glyphs inside or adjacent to normal text when there's no banner fill
          if (overlapsText && box.width < 0.45 && box.height < 0.45 && enclosedText.length === 0) {
            // Keep standalone timeline dots/icons that sit outside text line boxes
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
          const srcPng = (await getTextStrippedPagePng(pageNum - 1)) ?? pagePreviews[pageNum - 1];
          const croppedBase64 = await this.cropPageRegionToBase64(
            srcPng,
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

        const rawObjectCount = rawItems.length + vectorRects.length + imageBoxes.length;
        this.logger.info('PdfAnalysis', `Page ${pageNum} analyzed`, {
          rawObjects: rawObjectCount,
          normalizedRegions: regions.length,
          localizedGraphics: imageBoxes.length + iconClusters.length,
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
          rasterPreviewBase64: pagePreviews[pageNum - 1]?.toString('base64'),
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

    cleanSpans.sort((a, b) => (Math.abs(a.baselineY - b.baselineY) <= 0.028 ? a.x - b.x : a.baselineY - b.baselineY));

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

    // Build vertical edge barriers from vector lines & bordered/filled rectangles so justified prose merges cleanly inside cards/columns without crossing column/cell boundaries
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

    // Step B: Merge contiguous horizontal spans sharing the same baseline into inline VisualTextRuns
    const mergedLines: MergedTextLine[] = [];
    for (const cur of dedupedSpans) {
      const prev = mergedLines[mergedLines.length - 1];
      const gap = prev ? cur.x - (prev.x + prev.width) : Infinity;

      const prevBaselineY = prev ? prev.y + (prev.fontSizePt * 0.85) / PT_PER_INCH : 0;
      const curTrim = cur.text.trim();
      const prevTrim = prev ? prev.text.trim() : '';

      const sameBaselineY = prev && Math.abs(prevBaselineY - cur.baselineY) <= 0.028;
      const blockedByColon = Boolean(prev && prevTrim.endsWith(':') && gap > 0.07);
      const blockedByTableNumericGutter = Boolean(
        prev &&
          gap > 0.115 &&
          (/^[0-9.,Rp%\-$€£()+\/]+$/i.test(curTrim) || /^Plan\s+\d+/i.test(curTrim)) &&
          (/^[0-9.,Rp%\-$€£()+\/]+$/i.test(prevTrim) || prevTrim.length <= 20)
      );
      const isHangingMarker = /^(?:\d{1,2}\.|[a-z]\.|[•●○▪▫■□‣⁃-])$/i.test(prevTrim);
      const blockedByHangingMarker = Boolean(prev && isHangingMarker && gap > 0.045);
      const blockedByBarrier = Boolean(
        prev &&
          gap > 0.04 &&
          crossesVerticalBarrier(
            prev.x + prev.width,
            cur.x,
            Math.min(prev.y, cur.y),
            Math.max(prev.y + prev.height, cur.y + cur.height)
          )
      );

      const sameBaseline =
        Boolean(sameBaselineY) &&
        gap >= -0.035 &&
        gap <= 0.22 &&
        Math.abs(prev!.fontSizePt - cur.fontSizePt) <= 2.2 &&
        !blockedByColon &&
        !blockedByTableNumericGutter &&
        !blockedByHangingMarker &&
        !blockedByBarrier;

      if (sameBaseline && prev) {
        const lastRun = prev.runs[prev.runs.length - 1];
        const needsSpace =
          gap > 0.022 &&
          !lastRun.text.endsWith(' ') &&
          !cur.text.startsWith(' ');
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

  private extractVectorsAndImages(
    opList: { fnArray: number[]; argsArray: unknown[][] },
    pageHeightPt: number,
    pageWidthIn: number,
    pageHeightIn: number
  ): {
    vectorRects: RawVectorRect[];
    imageBoxes: Array<{ x: number; y: number; width: number; height: number }>;
    complexClusterBoxes: Array<{ x: number; y: number; width: number; height: number; fallbackRect?: RawVectorRect }>;
    textColorEvents: TextColorEvent[];
  } {
    const OPS = pdfjsLib.OPS;
    const vectorRects: RawVectorRect[] = [];
    const imageBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    const curveBoxes: Array<{ x: number; y: number; width: number; height: number; fallbackRect?: RawVectorRect }> = [];
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

        if (
          w > pageWidthIn - 0.15 &&
          h > pageHeightIn - 0.15 &&
          (!fillCol || fillCol === '#FFFFFF')
        ) {
          continue;
        }

        if (sp.hasCurves) {
          if (w >= 0.04 && h >= 0.04 && w <= pageWidthIn + 0.1 && h <= 4.5 && (hasFill || hasStroke)) {
            curveBoxes.push({
              x: Math.max(0, minX),
              y: Math.max(0, minY),
              width: Math.min(pageWidthIn - Math.max(0, minX), w),
              height: h,
              fallbackRect:
                w > 0.2 && h > 0.12
                  ? {
                      x: Math.max(0, minX),
                      y: Math.max(0, minY),
                      width: Math.min(pageWidthIn - Math.max(0, minX), w),
                      height: h,
                      fillColor: hasFill ? fillCol : undefined,
                      strokeColor: hasStroke ? strokeCol : undefined,
                      lineWidthPt: lw,
                    }
                  : undefined,
            });
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
          const lineThicknessIn = Math.max(0.005, lw / PT_PER_INCH);
          vectorRects.push({
            x: Math.max(0, minX),
            y: Math.max(0, minY),
            width: w <= 0.035 ? Math.max(lineThicknessIn, w) : w,
            height: h <= 0.035 ? Math.max(lineThicknessIn, h) : h,
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
              if (active && active.pts.length >= 2) subpaths.push(active);
              const [px, py] = applyCtm(ctm, Number(rawBuf[k]), Number(rawBuf[k + 1]));
              active = {
                pts: [{ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH }],
                hasCurves: false,
              };
              k += 2;
            } else if (code === 1 && k + 1 < rawBuf.length) {
              const [px, py] = applyCtm(ctm, Number(rawBuf[k]), Number(rawBuf[k + 1]));
              if (!active) active = { pts: [], hasCurves: false };
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 2;
            } else if (code === 2 && k + 5 < rawBuf.length) {
              const [px, py] = applyCtm(ctm, Number(rawBuf[k + 4]), Number(rawBuf[k + 5]));
              if (!active) active = { pts: [], hasCurves: false };
              active.hasCurves = true;
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 6;
            } else if (code === 3 && k + 3 < rawBuf.length) {
              const [px, py] = applyCtm(ctm, Number(rawBuf[k + 2]), Number(rawBuf[k + 3]));
              if (!active) active = { pts: [], hasCurves: false };
              active.hasCurves = true;
              active.pts.push({ x: px / PT_PER_INCH, y: (pageHeightPt - py) / PT_PER_INCH });
              k += 4;
            } else if (code === 4) {
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
            const lineThicknessIn = Math.max(0.005, gs.lineWidthPt / PT_PER_INCH);
            vectorRects.push({
              x: Math.max(0, Math.min(ln.x1, ln.x2)),
              y: Math.max(0, Math.min(ln.y1, ln.y2)),
              width: w <= 0.035 ? Math.max(lineThicknessIn, w) : w,
              height: h <= 0.035 ? Math.max(lineThicknessIn, h) : h,
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

    const complexClusterBoxes: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      fallbackRect?: RawVectorRect;
    }> = [];
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
        if (!merged.fallbackRect && cb.fallbackRect) merged.fallbackRect = cb.fallbackRect;
      } else {
        complexClusterBoxes.push({ ...cb });
      }
    }

    return {
      vectorRects,
      imageBoxes,
      complexClusterBoxes: complexClusterBoxes.filter(
        (b) =>
          Math.max(b.width, b.height) >= 0.14 &&
          Math.min(b.width, b.height) >= 0.08 &&
          b.width <= pageWidthIn + 0.05 &&
          b.height <= 4.5
      ),
      textColorEvents,
    };
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
