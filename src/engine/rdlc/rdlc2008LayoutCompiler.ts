import crypto from 'crypto';
import {
  LayoutPage,
  LayoutRegion,
  LayoutSectionSummary,
  RdlcBandContainerSpec,
  RdlcDocumentHierarchy,
  RegionStyle,
  StructuredLogger,
  TablixCell,
  TablixRegion,
  TablixRow,
  VisualImageItem,
  VisualParagraphSpec,
  VisualRectItem,
  VisualTextboxItem,
  VisualTextRun,
} from '../core/types.ts';

const PT_PER_INCH = 72;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function roundIn(val: number): number {
  return Math.round(val * 1000) / 1000;
}

function sanitizeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `T_${cleaned}` : cleaned;
}

function makeSectionSlug(text: string | undefined, fallback: string): string {
  if (!text) return fallback;
  const words = text
    .replace(/[^A-Za-z0-9\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^\d+$/.test(w))
    .slice(0, 4);
  if (words.length === 0) return fallback;
  const joined = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  return sanitizeIdentifier(joined.slice(0, 28), fallback);
}

function hexLuminance(hex?: string): number {
  if (!hex) return 1;
  const h = hex.trim().replace('#', '');
  if (h.length !== 6) return 1;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return 1;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function normalizeChromeText(text: string): string {
  return text
    .trim()
    .replace(/\b(Hal\.?|Halaman|Page)\s+\d+(\s+(?:dari|of)\s+\d+)?\b/gi, '$1 # $2')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildDynamicPageFooterExpr(rawText: string): string | undefined {
  const fullMatch = rawText.match(
    /^(.*?\b(?:Hal\.?|Halaman|Page)\s+)(\d+)(\s+(?:dari|of)\s+)(\d+)(.*)$/i
  );
  if (fullMatch) {
    const esc = (s: string) => s.replace(/"/g, '""');
    const parts: string[] = [];
    if (fullMatch[1]) parts.push(`"${esc(fullMatch[1])}"`);
    parts.push('Globals!PageNumber');
    parts.push(`"${esc(fullMatch[3])}"`);
    parts.push('Globals!TotalPages');
    if (fullMatch[5]) parts.push(`"${esc(fullMatch[5])}"`);
    return `=${parts.join(' & ')}`;
  }
  const singleMatch = rawText.match(/^(.*?\b(?:Hal\.?|Halaman|Page)\s+)(\d+)(.*)$/i);
  if (singleMatch) {
    const esc = (s: string) => s.replace(/"/g, '""');
    const parts: string[] = [];
    if (singleMatch[1]) parts.push(`"${esc(singleMatch[1])}"`);
    parts.push('Globals!PageNumber');
    if (singleMatch[3]) parts.push(`"${esc(singleMatch[3])}"`);
    return `=${parts.join(' & ')}`;
  }
  return undefined;
}

function regionSignature(r: LayoutRegion): string {
  const yBucket = Math.round(r.y * 12);
  const xBucket = Math.round(r.x * 8);
  if (r.type === 'text' && r.text) {
    return `txt::${yBucket}::${xBucket}::${normalizeChromeText(r.text)}`;
  }
  if ((r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64) {
    const sha = crypto.createHash('sha256').update(r.imageAssetBase64).digest('hex').slice(0, 12);
    return `img::${yBucket}::${xBucket}::${sha}`;
  }
  const wBucket = Math.round(r.width * 8);
  const hBucket = Math.round(r.height * 12);
  const col = r.style.backgroundColor ?? r.style.borderColor ?? '';
  return `vec::${yBucket}::${xBucket}::${wBucket}x${hBucket}::${col}`;
}

function clusterValues(vals: number[], tol: number): number[] {
  if (vals.length === 0) return [];
  const sorted = [...vals].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const grp = groups[groups.length - 1];
    const avg = grp.reduce((s, v) => s + v, 0) / grp.length;
    if (Math.abs(sorted[i] - avg) <= tol) {
      grp.push(sorted[i]);
    } else {
      groups.push([sorted[i]]);
    }
  }
  return groups.map((g) => roundIn(g.reduce((s, v) => s + v, 0) / g.length));
}

function defaultTextStyle(fontSizePt = 8.5): RegionStyle {
  return {
    fontFamily: 'Arial',
    fontSizePt,
    bold: false,
    italic: false,
    color: '#0F172A',
    textAlign: 'Left',
    verticalAlign: 'Top',
    paddingPt: { top: 1, right: 2, bottom: 1, left: 2 },
  };
}

const LIST_MARKER_PREFIX_RE = /^(\d+(?:\.\d+)*\.|\([ivxa-z0-9]+\)|[a-z][\.\)]|[•\u2022\-–*])$/i;
const LIST_MARKER_INLINE_RE = /^(\d+(?:\.\d+)*\.|\([ivxa-z0-9]+\)|[a-z][\.\)]|[•\u2022\-–*])\s+(.+)$/i;

function startsWithListMarker(text: string): boolean {
  const t = text.trim();
  return LIST_MARKER_PREFIX_RE.test(t) || LIST_MARKER_INLINE_RE.test(t);
}

interface BodyItemBox {
  kind: 'rect' | 'line' | 'image' | 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  region: LayoutRegion;
  rawIndex: number;
  isDetectedBanner?: boolean;
  isDetectedBand?: boolean;
}

interface DetectedChrome {
  pageHeader?: {
    heightIn: number;
    rawBottomIn: number;
    printOnFirstPage: boolean;
    printOnLastPage: boolean;
    regions: LayoutRegion[];
    matchedIdsByPage: Map<number, Set<string>>;
    textSignatures: Array<{ norm: string; x: number }>;
    imageShas: Array<{ sha: string; x: number }>;
  };
  pageFooter?: {
    topRawIn: number;
    heightIn: number;
    printOnFirstPage: boolean;
    printOnLastPage: boolean;
    regions: LayoutRegion[];
    matchedIdsByPage: Map<number, Set<string>>;
    textSignatures: Array<{ norm: string; x: number }>;
    imageShas: Array<{ sha: string; x: number }>;
  };
}

interface TrackRange {
  x0: number;
  x1: number;
}

interface SideBySideState {
  active: boolean;
  left: TrackRange;
  right: TrackRange;
  gutterX: number;
}

interface Compiled2008Input {
  pages: LayoutPage[];
  printableWidthIn: number;
  printableHeightIn: number;
  fullPageWidthIn: number;
  fullPageHeightIn: number;
  marginsIn: { top: number; right: number; bottom: number; left: number };
  dataSetName: string;
  registerEmbeddedImage: (base64Data: string, preferredName: string) => string;
  nextUniqueName: (prefix: string) => string;
}

interface Compiled2008Output {
  pageHeaderSpec?: RdlcBandContainerSpec;
  pageFooterSpec?: RdlcBandContainerSpec;
  bodyTablixes: TablixRegion[];
  hierarchy: RdlcDocumentHierarchy;
}

interface AtomicSegment {
  y0: number;
  y1: number;
  leftIn: number;
  widthIn: number;
  items: BodyItemBox[];
  isFullWidthBannerOnly?: boolean;
  trackSide?: 'Single' | 'Left' | 'Right';
  lockedByHDivider?: boolean;
}

interface ParagraphCellBlock {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  text: string;
  runs: VisualTextRun[];
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  color: string;
  textAlign: 'Left' | 'Center' | 'Right';
  verticalAlign: 'Top' | 'Middle' | 'Bottom';
  backgroundColor?: string;
  borderColor?: string;
  borderEdges?: {
    top?: 'Solid' | 'None';
    bottom?: 'Solid' | 'None';
    left?: 'Solid' | 'None';
    right?: 'Solid' | 'None';
  };
  subTableColEndX?: number;
  isBanner?: boolean;
  canGrow: boolean;
  lineCount: number;
}

export class Rdlc2008LayoutCompiler {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public compile(input: Compiled2008Input): Compiled2008Output {
    const {
      pages,
      printableWidthIn,
      fullPageHeightIn,
      marginsIn,
      dataSetName,
      registerEmbeddedImage,
      nextUniqueName,
    } = input;

    // Layer 1/2 Chrome Isolation: top 12% and bottom 10% (y > 0.90 * H)
    const chrome = this.detectChrome2008(pages, fullPageHeightIn, marginsIn);
    const effectivePrintableHeightIn = Math.max(
      2.0,
      roundIn(fullPageHeightIn - marginsIn.top - marginsIn.bottom)
    );

    const pageHeaderSpec = chrome.pageHeader
      ? this.buildChromeBandSpec(
          'PageHeader',
          chrome.pageHeader.heightIn,
          marginsIn.top,
          marginsIn.left,
          printableWidthIn,
          chrome.pageHeader.printOnFirstPage,
          chrome.pageHeader.printOnLastPage,
          chrome.pageHeader.regions,
          registerEmbeddedImage,
          nextUniqueName
        )
      : undefined;

    const pageFooterSpec = chrome.pageFooter
      ? this.buildChromeBandSpec(
          'PageFooter',
          chrome.pageFooter.heightIn,
          chrome.pageFooter.topRawIn,
          marginsIn.left,
          printableWidthIn,
          chrome.pageFooter.printOnFirstPage,
          chrome.pageFooter.printOnLastPage,
          chrome.pageFooter.regions,
          registerEmbeddedImage,
          nextUniqueName
        )
      : undefined;

    const bodyTablixes: TablixRegion[] = [];
    const sectionSummaries: LayoutSectionSummary[] = [];
    let sectionSeq = 1;
    let docCursorY = 0;

    let sideBySide: SideBySideState = {
      active: false,
      left: { x0: 0, x1: roundIn(printableWidthIn * 0.48) },
      right: { x0: roundIn(printableWidthIn * 0.52), x1: roundIn(printableWidthIn) },
      gutterX: roundIn(printableWidthIn * 0.5),
    };

    for (const page of pages) {
      const pNum = page.pageNumber;
      const showHeader = Boolean(chrome.pageHeader && (pNum > 1 || chrome.pageHeader.printOnFirstPage));
      const headerHeightIn = showHeader ? chrome.pageHeader!.heightIn : 0;
      const headerCutRaw = showHeader ? Math.max(marginsIn.top + headerHeightIn, chrome.pageHeader!.rawBottomIn) : marginsIn.top;
      const footerCutRaw = chrome.pageFooter ? chrome.pageFooter.topRawIn : fullPageHeightIn - marginsIn.bottom;
      const pageBodyAvailH = Math.max(
        1.0,
        roundIn(effectivePrintableHeightIn - headerHeightIn - (chrome.pageFooter ? chrome.pageFooter.heightIn : 0))
      );

      const headerExcludedIds = chrome.pageHeader?.matchedIdsByPage.get(pNum) ?? new Set<string>();
      const footerExcludedIds = chrome.pageFooter?.matchedIdsByPage.get(pNum) ?? new Set<string>();

      const isChromeRegion = (r: LayoutRegion): boolean => {
        if (headerExcludedIds.has(r.id) || footerExcludedIds.has(r.id)) return true;
        if (showHeader && r.y + r.height <= headerCutRaw + 0.03) return true;
        if (chrome.pageFooter && r.y >= footerCutRaw - 0.03) return true;
        if (r.type === 'text' && r.text) {
          const norm = normalizeChromeText(r.text);
          if (
            showHeader &&
            chrome.pageHeader &&
            r.y < fullPageHeightIn * 0.14 &&
            chrome.pageHeader.textSignatures.some((s) => s.norm === norm && Math.abs(s.x - r.x) <= 0.12)
          ) {
            return true;
          }
          if (
            chrome.pageFooter &&
            r.y > fullPageHeightIn * 0.88 &&
            chrome.pageFooter.textSignatures.some((s) => s.norm === norm && Math.abs(s.x - r.x) <= 0.12)
          ) {
            return true;
          }
        }
        if ((r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64) {
          const sha = crypto.createHash('sha256').update(r.imageAssetBase64).digest('hex').slice(0, 12);
          if (
            showHeader &&
            chrome.pageHeader &&
            r.y < fullPageHeightIn * 0.15 &&
            chrome.pageHeader.imageShas.some((s) => s.sha === sha && Math.abs(s.x - r.x) <= 0.12)
          ) {
            return true;
          }
          if (
            chrome.pageFooter &&
            r.y > fullPageHeightIn * 0.88 &&
            chrome.pageFooter.imageShas.some((s) => s.sha === sha && Math.abs(s.x - r.x) <= 0.12)
          ) {
            return true;
          }
        }
        return false;
      };

      const bodyItems: BodyItemBox[] = [];
      let rawIdx = 0;
      const bodyRawOriginY = marginsIn.top + headerHeightIn;
      const vp = page.vectorPrimitives;
      const vpBannersIn = (vp?.fillBanners ?? []).map((fb) => ({
        x: fb.x / PT_PER_INCH - marginsIn.left,
        y: fb.y / PT_PER_INCH - bodyRawOriginY,
        width: fb.width / PT_PER_INCH,
        height: fb.height / PT_PER_INCH,
        fillHex: fb.fillHex,
      }));
      const vpBandsIn = (vp?.fillBands ?? []).map((fb) => ({
        x: fb.x / PT_PER_INCH - marginsIn.left,
        y: fb.y / PT_PER_INCH - bodyRawOriginY,
        width: fb.width / PT_PER_INCH,
        height: fb.height / PT_PER_INCH,
        fillHex: fb.fillHex,
      }));

      for (const r of page.regions) {
        if (isChromeRegion(r)) continue;
        // Skip invisible full-page white fill rect
        if (
          r.type === 'vector_rect' &&
          r.width >= printableWidthIn - 0.1 &&
          r.height >= effectivePrintableHeightIn - 0.1 &&
          (!r.style.backgroundColor || r.style.backgroundColor.toUpperCase() === '#FFFFFF') &&
          !r.style.borderColor
        ) {
          continue;
        }
        const isLine = r.type === 'vector_line';
        const minDim = isLine ? 0.005 : 0.014;
        const x = clamp(r.x - marginsIn.left, 0, Math.max(0, printableWidthIn - minDim));
        const y = Math.max(0, r.y - bodyRawOriginY);
        const w = clamp(r.width, minDim, printableWidthIn - x);
        const h = clamp(r.height, minDim, Math.max(minDim, pageBodyAvailH - y + 0.1));
        const kind: BodyItemBox['kind'] =
          r.type === 'vector_line'
            ? 'line'
            : r.type === 'vector_rect'
              ? 'rect'
              : r.type === 'image' || r.type === 'vector_complex'
                ? 'image'
                : 'text';
        const isDetectedBanner =
          kind === 'rect' &&
          vpBannersIn.some(
            (fb) =>
              Math.abs(fb.x - x) <= 0.08 &&
              Math.abs(fb.y - y) <= 0.06 &&
              Math.abs(fb.width - w) <= 0.10 &&
              Math.abs(fb.height - h) <= 0.06
          );
        const isDetectedBand =
          kind === 'rect' &&
          vpBandsIn.some(
            (fb) =>
              Math.abs(fb.x - x) <= 0.08 &&
              Math.abs(fb.y - y) <= 0.06 &&
              Math.abs(fb.width - w) <= 0.10 &&
              Math.abs(fb.height - h) <= 0.06
          );
        bodyItems.push({ kind, x, y, width: w, height: h, region: r, rawIndex: rawIdx++, isDetectedBanner, isDetectedBand });
      }

      // Inject any Channel 1 fillBanners / fillBands inside body Y-bounds that were absent from vector regions
      const injectMissingFill = (
        fb: { x: number; y: number; width: number; height: number; fillHex: string },
        asBanner: boolean
      ) => {
        if (fb.y < -0.02 || fb.y > pageBodyAvailH) return;
        const sx = clamp(fb.x, 0, Math.max(0, printableWidthIn - 0.02));
        const sy = Math.max(0, fb.y);
        const sw = clamp(fb.width, 0.02, printableWidthIn - sx);
        const sh = clamp(fb.height, 0.02, Math.max(0.02, pageBodyAvailH - sy));
        const already = bodyItems.some(
          (it) =>
            it.kind === 'rect' &&
            Math.abs(it.x - sx) <= 0.08 &&
            Math.abs(it.y - sy) <= 0.06 &&
            Math.abs(it.width - sw) <= 0.10 &&
            Math.abs(it.height - sh) <= 0.06
        );
        if (already) return;
        bodyItems.push({
          kind: 'rect',
          x: sx,
          y: sy,
          width: sw,
          height: sh,
          rawIndex: rawIdx++,
          isDetectedBanner: asBanner,
          isDetectedBand: !asBanner,
          region: {
            id: `vp-fill-${rawIdx}`,
            pageNumber: pNum,
            type: 'vector_rect',
            x: roundIn(sx + marginsIn.left),
            y: roundIn(sy + bodyRawOriginY),
            width: roundIn(sw),
            height: roundIn(sh),
            style: { ...defaultTextStyle(8), backgroundColor: fb.fillHex },
            semanticRole: 'unknown',
            confidence: 0.96,
            bandKind: 'Detail',
            isAmbiguous: false,
            sourceObjectRefs: [`vp-fill-${pNum}-${rawIdx}`],
          },
        });
      };
      for (const fb of vpBannersIn) injectMissingFill(fb, true);
      for (const fb of vpBandsIn) injectMissingFill(fb, false);

      if (bodyItems.length === 0) {
        const secNum = String(sectionSeq++).padStart(2, '0');
        const tbl = this.buildEmptyPlaceholderTablix(`Tablix_${secNum}_Page${pNum}`, pNum, docCursorY, printableWidthIn, dataSetName, nextUniqueName, pNum > 1);
        bodyTablixes.push(tbl);
        sectionSummaries.push({
          name: tbl.name,
          slug: `Page${pNum}`,
          pageNumber: pNum,
          pageBreakStart: pNum > 1,
          topIn: tbl.topIn,
          leftIn: tbl.leftIn,
          widthIn: tbl.widthIn,
          heightIn: tbl.heightIn,
          layoutType: 'Single-Column',
          rowCount: 1,
          colCount: 1,
          hasNestedTablixes: false,
          columnCount: 1,
          hasHeaderBand: false,
          hasLeftColumn: false,
          hasRightColumn: false,
          hasFooterBand: false,
          childItemCount: 0,
        });
        docCursorY = roundIn(tbl.topIn + tbl.heightIn + 0.05);
        continue;
      }

      // Layer 2: Deterministic geometric segmentation into Single-Track bands and Side-by-Side track pairs
      const { zones, nextSideBySideState } = this.partitionPageIntoGeometricZones(
        bodyItems,
        printableWidthIn,
        sideBySide
      );
      sideBySide = nextSideBySideState;

      let pageCursorY = docCursorY;
      let pageHasEmittedPageBreak = pNum === 1;

      for (const zone of zones) {
        if (zone.kind === 'SingleTrack') {
          const subSegments = this.splitSingleTrackBand(zone.items, zone.leftIn, zone.widthIn, printableWidthIn);
          for (const seg of subSegments) {
            const needBreak = !pageHasEmittedPageBreak;
            pageHasEmittedPageBreak = true;
            const secNum = String(sectionSeq++).padStart(2, '0');
            const headingItem = seg.items.find((it) => it.kind === 'text' && it.region.text?.trim());
            const slug = makeSectionSlug(headingItem?.region.text, `Page${pNum}Section${secNum}`);
            const tblName = sanitizeIdentifier(`Tablix_${secNum}_${slug}`, `Tablix_${secNum}`);

            const tbl = this.quantizeSegmentToTablix(
              tblName,
              seg,
              pNum,
              pageCursorY,
              dataSetName,
              registerEmbeddedImage,
              nextUniqueName,
              needBreak
            );
            tbl.slug = slug;
            tbl.keepTogether = false;
            bodyTablixes.push(tbl);

            sectionSummaries.push({
              name: tbl.name,
              slug,
              pageNumber: pNum,
              pageBreakStart: needBreak,
              topIn: tbl.topIn,
              leftIn: tbl.leftIn,
              widthIn: tbl.widthIn,
              heightIn: tbl.heightIn,
              layoutType: tbl.columnWidthsIn.length >= 4 ? 'Tablix' : 'Single-Column',
              rowCount: tbl.rows.length,
              colCount: tbl.columnWidthsIn.length,
              hasNestedTablixes: false,
              columnCount: 1,
              hasHeaderBand: false,
              hasLeftColumn: false,
              hasRightColumn: false,
              hasFooterBand: false,
              childItemCount: tbl.rows.length,
            });
            pageCursorY = roundIn(tbl.topIn + tbl.heightIn + 0.02);
          }
        } else {
          // SIDE_BY_SIDE_MODE: Left and Right tracks share identical topIn (`zoneTopY`).
          // PageBreak is emitted ONLY on the first Tablix of Tablix_Left, NEVER on Tablix_Right!
          const zoneTopY = pageCursorY;
          let leftCursorY = zoneTopY;
          let rightCursorY = zoneTopY;
          const secNum = String(sectionSeq++).padStart(2, '0');

          const leftSegs = this.splitSideTrack(zone.leftItems, zone.leftRange.x0, zone.leftRange.x1 - zone.leftRange.x0);
          const rightSegs = this.splitSideTrack(zone.rightItems, zone.rightRange.x0, zone.rightRange.x1 - zone.rightRange.x0);

          if (leftSegs.length === 0) {
            leftSegs.push({
              y0: 0,
              y1: 0.25,
              leftIn: zone.leftRange.x0,
              widthIn: Math.max(0.5, zone.leftRange.x1 - zone.leftRange.x0),
              items: [],
              trackSide: 'Left',
            });
          }
          if (rightSegs.length === 0) {
            rightSegs.push({
              y0: 0,
              y1: 0.25,
              leftIn: zone.rightRange.x0,
              widthIn: Math.max(0.5, zone.rightRange.x1 - zone.rightRange.x0),
              items: [],
              trackSide: 'Right',
            });
          }

          leftSegs.forEach((seg, idx) => {
            const needBreak = idx === 0 && !pageHasEmittedPageBreak;
            if (needBreak) pageHasEmittedPageBreak = true;
            const headingItem = seg.items.find((it) => it.kind === 'text' && it.region.text?.trim());
            const slug = makeSectionSlug(headingItem?.region.text, `Page${pNum}ColL`);
            const suffix = idx === 0 ? 'Left' : `Left${idx + 1}`;
            const tblName = sanitizeIdentifier(`Tablix_${secNum}_${slug}_${suffix}`, `Tablix_${secNum}_${suffix}`);
            const tbl =
              seg.items.length > 0
                ? this.quantizeSegmentToTablix(
                    tblName,
                    seg,
                    pNum,
                    leftCursorY,
                    dataSetName,
                    registerEmbeddedImage,
                    nextUniqueName,
                    needBreak
                  )
                : this.buildEmptyPlaceholderTablix(
                    tblName,
                    pNum,
                    leftCursorY,
                    seg.widthIn,
                    dataSetName,
                    nextUniqueName,
                    needBreak,
                    seg.leftIn
                  );
            tbl.slug = `${slug}_${suffix}`;
            tbl.keepTogether = false;
            bodyTablixes.push(tbl);
            sectionSummaries.push({
              name: tbl.name,
              slug: tbl.slug,
              pageNumber: pNum,
              pageBreakStart: needBreak,
              topIn: tbl.topIn,
              leftIn: tbl.leftIn,
              widthIn: tbl.widthIn,
              heightIn: tbl.heightIn,
              layoutType: 'Dual-Column',
              rowCount: tbl.rows.length,
              colCount: tbl.columnWidthsIn.length,
              hasNestedTablixes: false,
              columnCount: 2,
              hasHeaderBand: false,
              hasLeftColumn: true,
              hasRightColumn: false,
              hasFooterBand: false,
              childItemCount: tbl.rows.length,
            });
            leftCursorY = roundIn(tbl.topIn + tbl.heightIn + 0.02);
          });

          rightSegs.forEach((seg, idx) => {
            const headingItem = seg.items.find((it) => it.kind === 'text' && it.region.text?.trim());
            const slug = makeSectionSlug(headingItem?.region.text, `Page${pNum}ColR`);
            const suffix = idx === 0 ? 'Right' : `Right${idx + 1}`;
            const tblName = sanitizeIdentifier(`Tablix_${secNum}_${slug}_${suffix}`, `Tablix_${secNum}_${suffix}`);
            const tbl =
              seg.items.length > 0
                ? this.quantizeSegmentToTablix(
                    tblName,
                    seg,
                    pNum,
                    rightCursorY,
                    dataSetName,
                    registerEmbeddedImage,
                    nextUniqueName,
                    false // NEVER emit PageBreak on Tablix_Right
                  )
                : this.buildEmptyPlaceholderTablix(
                    tblName,
                    pNum,
                    rightCursorY,
                    seg.widthIn,
                    dataSetName,
                    nextUniqueName,
                    false,
                    seg.leftIn
                  );
            tbl.slug = `${slug}_${suffix}`;
            tbl.keepTogether = false;
            bodyTablixes.push(tbl);
            sectionSummaries.push({
              name: tbl.name,
              slug: tbl.slug,
              pageNumber: pNum,
              pageBreakStart: false,
              topIn: tbl.topIn,
              leftIn: tbl.leftIn,
              widthIn: tbl.widthIn,
              heightIn: tbl.heightIn,
              layoutType: 'Dual-Column',
              rowCount: tbl.rows.length,
              colCount: tbl.columnWidthsIn.length,
              hasNestedTablixes: false,
              columnCount: 2,
              hasHeaderBand: false,
              hasLeftColumn: false,
              hasRightColumn: true,
              hasFooterBand: false,
              childItemCount: tbl.rows.length,
            });
            rightCursorY = roundIn(tbl.topIn + tbl.heightIn + 0.02);
          });

          pageCursorY = Math.max(leftCursorY, rightCursorY);
        }
      }

      docCursorY = roundIn(pageCursorY + 0.04);
    }

    const hierarchy: RdlcDocumentHierarchy = {
      mode: 'v3-full-tablix-single-rdlc',
      pageHeader: pageHeaderSpec
        ? {
            heightIn: pageHeaderSpec.heightIn,
            printOnFirstPage: pageHeaderSpec.printOnFirstPage ?? true,
            printOnLastPage: pageHeaderSpec.printOnLastPage ?? true,
            assetCount: pageHeaderSpec.images.length,
            textLabels: pageHeaderSpec.textboxes.map((t) => t.text).filter(Boolean),
          }
        : undefined,
      pageFooter: pageFooterSpec
        ? {
            heightIn: pageFooterSpec.heightIn,
            printOnFirstPage: pageFooterSpec.printOnFirstPage ?? true,
            printOnLastPage: pageFooterSpec.printOnLastPage ?? true,
            assetCount: pageFooterSpec.images.length,
            textLabels: pageFooterSpec.textboxes.map((t) => t.text).filter(Boolean),
          }
        : undefined,
      sections: sectionSummaries,
    };

    this.logger.info('Rdlc2008LayoutCompiler', 'RDLC 2008 deterministic geometry compiled', {
      bodyTablixes: bodyTablixes.length,
      hasPageHeader: Boolean(pageHeaderSpec),
      hasPageFooter: Boolean(pageFooterSpec),
    });

    return {
      pageHeaderSpec,
      pageFooterSpec,
      bodyTablixes,
      hierarchy,
    };
  }

  private detectChrome2008(
    pages: LayoutPage[],
    fullPageHeightIn: number,
    marginsIn: { top: number; right: number; bottom: number; left: number }
  ): DetectedChrome {
    const numPages = pages.length;
    const topBandLimitY = fullPageHeightIn * 0.12;
    const bottomBandLimitY = fullPageHeightIn * 0.90;

    let pageHeader: DetectedChrome['pageHeader'];
    let pageFooter: DetectedChrome['pageFooter'];

    if (numPages >= 2) {
      const minAll = Math.max(2, Math.ceil(numPages * 0.6));
      const minTail = numPages >= 3 ? Math.max(2, Math.ceil((numPages - 1) * 0.6)) : 2;

      const headerAll = new Map<string, Set<number>>();
      const headerTail = new Map<string, Set<number>>();
      for (const p of pages) {
        const seen = new Set<string>();
        for (const r of p.regions) {
          if (r.y >= topBandLimitY) continue;
          const sig = regionSignature(r);
          if (seen.has(sig)) continue;
          seen.add(sig);
          const allSet = headerAll.get(sig) ?? new Set<number>();
          allSet.add(p.pageNumber);
          headerAll.set(sig, allSet);
          if (p.pageNumber >= 2) {
            const tailSet = headerTail.get(sig) ?? new Set<number>();
            tailSet.add(p.pageNumber);
            headerTail.set(sig, tailSet);
          }
        }
      }

      const activeSigs = new Set<string>();
      for (const [sig, ps] of headerAll.entries()) {
        if (ps.size >= minAll) activeSigs.add(sig);
      }
      if (activeSigs.size === 0) {
        for (const [sig, ps] of headerTail.entries()) {
          if (ps.size >= minTail) activeSigs.add(sig);
        }
      }

      if (activeSigs.size > 0) {
        const tplPage = pages.find((p) => p.pageNumber >= 2) ?? pages[0];
        let matched = tplPage.regions.filter(
          (r) => (r.y < topBandLimitY || r.imageAssetName === 'HeaderLogo') && activeSigs.has(regionSignature(r))
        );
        // Include thin header separator line sitting directly below header items (<= 0.145 * H)
        if (matched.length > 0) {
          const maxItemBot = Math.max(...matched.map((r) => r.y + r.height));
          const headerSepLines = tplPage.regions.filter(
            (r) =>
              r.type === 'vector_line' &&
              r.width >= r.height &&
              r.y >= maxItemBot - 0.02 &&
              r.y <= Math.min(fullPageHeightIn * 0.145, maxItemBot + 0.12)
          );
          for (const sep of headerSepLines) {
            const sepSig = regionSignature(sep);
            const sepCount = pages.filter((p) => p.regions.some((rr) => regionSignature(rr) === sepSig)).length;
            if (sepCount >= minTail) {
              activeSigs.add(sepSig);
              matched.push(sep);
            }
          }
        }

        if (matched.length > 0) {
          const p1Sigs = new Set(
            pages[0].regions.filter((r) => r.y < fullPageHeightIn * 0.15).map((r) => regionSignature(r))
          );
          let p1Hits = 0;
          for (const s of activeSigs) if (p1Sigs.has(s)) p1Hits++;
          const printOnFirstPage = p1Hits / activeSigs.size >= 0.6;

          const p1Matched = printOnFirstPage
            ? pages[0].regions.filter(
                (r) => (r.y < topBandLimitY || r.imageAssetName === 'HeaderLogo') && activeSigs.has(regionSignature(r))
              )
            : [];
          const allHeaderMatched = [...matched, ...p1Matched];

          const effectiveItemHeight = (r: LayoutRegion): number =>
            r.type === 'text'
              ? Math.max(r.height, (r.style.fontSizePt / PT_PER_INCH) * 1.25)
              : r.height;

          const minHeaderY = Math.min(...allHeaderMatched.map((r) => r.y));
          if (minHeaderY < marginsIn.top + 0.02) {
            marginsIn.top = roundIn(Math.min(marginsIn.top, Math.max(0.08, minHeaderY - 2 / PT_PER_INCH)));
          }

          const rawBot = Math.max(
            ...allHeaderMatched.map((r) => Math.min(fullPageHeightIn, r.y + effectiveItemHeight(r)))
          );
          const maxRelBot = Math.max(
            ...allHeaderMatched.map((r) => Math.max(0, r.y - marginsIn.top) + effectiveItemHeight(r))
          );
          const headerHeightIn = roundIn(
            clamp(Math.max(rawBot - marginsIn.top, maxRelBot) + 4 / PT_PER_INCH, 0.22, fullPageHeightIn * 0.16)
          );

          const matchedIdsByPage = new Map<number, Set<string>>();
          for (const p of pages) {
            const ids = new Set<string>();
            if (p.pageNumber > 1 || printOnFirstPage) {
              for (const r of p.regions) {
                if (r.y <= rawBot + 0.04 && activeSigs.has(regionSignature(r))) ids.add(r.id);
              }
            }
            matchedIdsByPage.set(p.pageNumber, ids);
          }

          pageHeader = {
            heightIn: headerHeightIn,
            rawBottomIn: rawBot,
            printOnFirstPage,
            printOnLastPage: true,
            regions: matched,
            matchedIdsByPage,
            textSignatures: matched.filter((r) => r.type === 'text' && r.text).map((r) => ({ norm: normalizeChromeText(r.text!), x: r.x })),
            imageShas: matched
              .filter((r) => (r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64)
              .map((r) => ({
                sha: crypto.createHash('sha256').update(r.imageAssetBase64!).digest('hex').slice(0, 12),
                x: r.x,
              })),
          };
        }
      }

      // Footer detection (y > 0.90 * H) — ignore tall/bleed/empty rects
      const isFooterCandidate = (r: LayoutRegion): boolean => {
        if (r.y <= bottomBandLimitY || r.y >= fullPageHeightIn - 0.02) return false;
        if (r.height > fullPageHeightIn * 0.09) return false;
        if (r.type === 'vector_rect') {
          if (r.height > 0.55) return false;
          if (!r.style.backgroundColor && !r.style.borderColor) return false;
          if (r.style.backgroundColor?.toUpperCase() === '#FFFFFF' && !r.style.borderColor) return false;
        }
        return true;
      };

      const footerCounts = new Map<string, Set<number>>();
      for (const p of pages) {
        const seen = new Set<string>();
        for (const r of p.regions) {
          if (!isFooterCandidate(r)) continue;
          const sig = regionSignature(r);
          if (seen.has(sig)) continue;
          seen.add(sig);
          const set = footerCounts.get(sig) ?? new Set<number>();
          set.add(p.pageNumber);
          footerCounts.set(sig, set);
        }
      }

      const footerSigs = new Set<string>();
      for (const [sig, ps] of footerCounts.entries()) {
        if (ps.size >= minAll) footerSigs.add(sig);
      }

      if (footerSigs.size > 0) {
        const tplPage = pages.find((p) => p.pageNumber >= 2) ?? pages[0];
        const matched = tplPage.regions.filter((r) => isFooterCandidate(r) && footerSigs.has(regionSignature(r)));
        if (matched.length > 0) {
          const minRawY = Math.min(...matched.map((r) => r.y));
          const maxRawBot = Math.max(
            ...matched.map((r) =>
              Math.min(
                fullPageHeightIn,
                r.y + (r.type === 'text' ? Math.max(r.height, (r.style.fontSizePt / PT_PER_INCH) * 1.25) : r.height)
              )
            )
          );
          if (maxRawBot > fullPageHeightIn - marginsIn.bottom - 0.02) {
            marginsIn.bottom = roundIn(
              Math.min(marginsIn.bottom, Math.max(0.06, fullPageHeightIn - maxRawBot - 2 / PT_PER_INCH))
            );
          }
          const topRawIn = Math.min(minRawY - 4 / PT_PER_INCH, fullPageHeightIn - marginsIn.bottom - 0.18);
          const footerHeightIn = roundIn(
            clamp(
              Math.max(maxRawBot + 2 / PT_PER_INCH, fullPageHeightIn - marginsIn.bottom) - topRawIn,
              0.18,
              fullPageHeightIn * 0.09
            )
          );
          const matchedIdsByPage = new Map<number, Set<string>>();
          for (const p of pages) {
            const ids = new Set<string>();
            for (const r of p.regions) {
              if (isFooterCandidate(r) && r.y >= topRawIn - 0.04 && footerSigs.has(regionSignature(r))) ids.add(r.id);
            }
            matchedIdsByPage.set(p.pageNumber, ids);
          }

          pageFooter = {
            topRawIn,
            heightIn: footerHeightIn,
            printOnFirstPage: true,
            printOnLastPage: true,
            regions: matched,
            matchedIdsByPage,
            textSignatures: matched.filter((r) => r.type === 'text' && r.text).map((r) => ({ norm: normalizeChromeText(r.text!), x: r.x })),
            imageShas: matched
              .filter((r) => (r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64)
              .map((r) => ({
                sha: crypto.createHash('sha256').update(r.imageAssetBase64!).digest('hex').slice(0, 12),
                x: r.x,
              })),
          };
        }
      }
    } else if (numPages === 1) {
      const p = pages[0];
      const logoReg = p.regions.filter((r) => r.imageAssetName === 'HeaderLogo' && r.y < topBandLimitY);
      if (logoReg.length > 0) {
        const minHeaderY = Math.min(...logoReg.map((r) => r.y));
        if (minHeaderY < marginsIn.top + 0.02) {
          marginsIn.top = roundIn(Math.min(marginsIn.top, Math.max(0.08, minHeaderY - 2 / PT_PER_INCH)));
        }
        const rawBot = Math.max(...logoReg.map((r) => Math.min(fullPageHeightIn, r.y + r.height)));
        const maxRelBot = Math.max(...logoReg.map((r) => Math.max(0, r.y - marginsIn.top) + r.height));
        const ids = new Set(logoReg.map((r) => r.id));
        pageHeader = {
          heightIn: roundIn(clamp(Math.max(rawBot - marginsIn.top, maxRelBot) + 4 / PT_PER_INCH, 0.22, fullPageHeightIn * 0.16)),
          rawBottomIn: rawBot,
          printOnFirstPage: true,
          printOnLastPage: true,
          regions: logoReg,
          matchedIdsByPage: new Map([[1, ids]]),
          textSignatures: [],
          imageShas: logoReg
            .filter((r) => r.imageAssetBase64)
            .map((r) => ({
              sha: crypto.createHash('sha256').update(r.imageAssetBase64!).digest('hex').slice(0, 12),
              x: r.x,
            })),
        };
      }
      const fRegs = p.regions.filter(
        (r) => r.y > bottomBandLimitY && r.type === 'text' && r.text && Boolean(buildDynamicPageFooterExpr(r.text))
      );
      if (fRegs.length > 0) {
        const minRawY = Math.min(...fRegs.map((r) => r.y));
        const maxRawBot = Math.max(
          ...fRegs.map((r) => Math.min(fullPageHeightIn, r.y + Math.max(r.height, (r.style.fontSizePt / PT_PER_INCH) * 1.25)))
        );
        if (maxRawBot > fullPageHeightIn - marginsIn.bottom - 0.02) {
          marginsIn.bottom = roundIn(
            Math.min(marginsIn.bottom, Math.max(0.06, fullPageHeightIn - maxRawBot - 2 / PT_PER_INCH))
          );
        }
        const topRawIn = Math.min(minRawY - 4 / PT_PER_INCH, fullPageHeightIn - marginsIn.bottom - 0.18);
        const footerHeightIn = roundIn(
          clamp(
            Math.max(maxRawBot + 2 / PT_PER_INCH, fullPageHeightIn - marginsIn.bottom) - topRawIn,
            0.18,
            fullPageHeightIn * 0.09
          )
        );
        pageFooter = {
          topRawIn,
          heightIn: footerHeightIn,
          printOnFirstPage: true,
          printOnLastPage: true,
          regions: fRegs,
          matchedIdsByPage: new Map([[1, new Set(fRegs.map((r) => r.id))]]),
          textSignatures: fRegs.map((r) => ({ norm: normalizeChromeText(r.text!), x: r.x })),
          imageShas: [],
        };
      }
    }

    return { pageHeader, pageFooter };
  }

  private buildChromeBandSpec(
    kind: 'PageHeader' | 'PageFooter',
    bandHeightIn: number,
    bandOriginY: number,
    marginLeftIn: number,
    printableWidthIn: number,
    printOnFirstPage: boolean,
    printOnLastPage: boolean,
    regions: LayoutRegion[],
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string
  ): RdlcBandContainerSpec {
    const rectangles: VisualRectItem[] = [];
    const images: VisualImageItem[] = [];
    const textboxes: VisualTextboxItem[] = [];

    const sorted = [...regions].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const minDim = r.type === 'vector_line' ? 0.005 : 0.02;
      const x = roundIn(clamp(r.x - marginLeftIn, 0, Math.max(0, printableWidthIn - minDim)));
      const rawRelY = r.y - bandOriginY;
      const maxY = Math.max(0, bandHeightIn - Math.min(r.height, bandHeightIn));
      const y = roundIn(clamp(rawRelY, 0, maxY));
      const w = roundIn(clamp(r.width, minDim, printableWidthIn - x));
      const h = roundIn(clamp(r.height, minDim, Math.max(minDim, bandHeightIn - y)));

      if (r.type === 'vector_line' || r.type === 'vector_rect') {
        const bg = r.style.backgroundColor;
        const bc = r.style.borderColor;
        if (r.type === 'vector_line') {
          const lineCol = bc ?? bg ?? '#CBD5E1';
          rectangles.push({
            kind: 'Rectangle',
            name: nextUniqueName('ChromeLine'),
            leftIn: x,
            topIn: y,
            widthIn: r.width >= r.height ? Math.max(0.05, w) : Math.max(0.006, Math.min(w, 0.02)),
            heightIn: r.width >= r.height ? Math.max(0.006, Math.min(h, 0.02)) : Math.max(0.05, h),
            backgroundColor: lineCol,
            zIndex: 0,
            role: 'line',
          });
        } else if (bg || bc) {
          rectangles.push({
            kind: 'Rectangle',
            name: nextUniqueName('ChromeRect'),
            leftIn: x,
            topIn: y,
            widthIn: w,
            heightIn: h,
            backgroundColor: bg,
            borderColor: bc,
            borderWidthPt: bc ? Math.max(0.5, r.style.borderWidthPt ?? 0.5) : undefined,
            zIndex: 0,
            role: 'fill',
          });
        }
        continue;
      }

      if ((r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64) {
        const preferred = r.imageAssetName ?? `ChromeImg_${i + 1}`;
        const embName = registerEmbeddedImage(r.imageAssetBase64, preferred);
        images.push({
          kind: 'Image',
          name: preferred === 'HeaderLogo' ? 'Img_HeaderLogo' : nextUniqueName('Img'),
          embeddedImageName: embName,
          leftIn: x,
          topIn: y,
          widthIn: w,
          heightIn: Math.max(0.08, h),
          sizing: 'FitProportional',
          zIndex: 1,
        });
        continue;
      }

      if (r.type === 'text' && r.text && r.text.trim()) {
        const expr = kind === 'PageFooter' ? buildDynamicPageFooterExpr(r.text) : undefined;
        const runs: VisualTextRun[] = expr
          ? [
              {
                text: expr,
                fontFamily: r.style.fontFamily,
                fontSizePt: r.style.fontSizePt,
                bold: r.style.bold,
                italic: r.style.italic,
                color: r.style.color,
              },
            ]
          : r.runs && r.runs.length > 0
            ? r.runs.map((rn) => ({ ...rn, parameterName: undefined }))
            : [
                {
                  text: r.text,
                  fontFamily: r.style.fontFamily,
                  fontSizePt: r.style.fontSizePt,
                  bold: r.style.bold,
                  italic: r.style.italic,
                  underline: r.style.underline,
                  color: r.style.color,
                },
              ];

        const boxW = roundIn(clamp(w + 0.16, 0.25, printableWidthIn - x));
        const boxH = roundIn(clamp(Math.max(h, (r.style.fontSizePt / PT_PER_INCH) * 1.25), 0.12, Math.max(0.12, bandHeightIn - y)));
        textboxes.push({
          kind: 'Textbox',
          name: nextUniqueName('ChromeTxt'),
          leftIn: x,
          topIn: y,
          widthIn: boxW,
          heightIn: boxH,
          text: expr ?? r.text,
          runs,
          style: {
            ...r.style,
            backgroundColor: undefined,
            borderColor: undefined,
            verticalAlign: 'Middle',
            paddingPt: { top: 0, right: 1, bottom: 0, left: 1 },
          },
          canGrow: false,
          zIndex: 2,
        });
      }
    }

    return {
      kind,
      heightIn: bandHeightIn,
      printOnFirstPage,
      printOnLastPage,
      rectangles,
      images,
      textboxes,
      tablixes: [],
    };
  }

  private isBannerRect(b: BodyItemBox, allItems: BodyItemBox[], minWidthIn: number): boolean {
    if (b.kind !== 'rect') return false;
    if (b.height < 12 / PT_PER_INCH || b.height > 0.65) return false;
    if (b.width < minWidthIn) return false;
    const bgLum = hexLuminance(b.region.style.backgroundColor);
    if (bgLum >= 0.75) return false;

    // Reject if interior vertical grid lines divide this filled bar (multi-column table header row, not a section banner)
    const crossedByVLine = allItems.some(
      (it) =>
        it.kind === 'line' &&
        it.height > it.width * 1.5 &&
        it.height >= b.height * 0.75 &&
        it.x > b.x + 0.12 &&
        it.x < b.x + b.width - 0.12 &&
        it.y <= b.y + 0.04 &&
        it.y + it.height >= b.y + b.height - 0.04
    );
    if (crossedByVLine) return false;

    const textsInside = allItems.filter(
      (it) =>
        it.kind === 'text' &&
        it.x >= b.x - 0.06 &&
        it.x + it.width <= b.x + b.width + 0.06 &&
        it.y + it.height / 2 >= b.y - 0.03 &&
        it.y + it.height / 2 <= b.y + b.height + 0.03
    );
    if (textsInside.length === 0) return false;

    const hasContrastingText =
      bgLum < 0.72 ||
      textsInside.some((t) => Math.abs(hexLuminance(t.region.style.color) - bgLum) >= 0.25);
    if (!hasContrastingText) return false;

    // Reject if multiple horizontal column headers sit inside (table header row, not a banner)
    if (textsInside.length >= 2) {
      const sorted = [...textsInside].sort((a, b2) => a.x - b2.x);
      let multiColHeaders = 0;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width) >= 0.35 && Math.abs(sorted[i].y - sorted[i - 1].y) <= 0.06) {
          multiColHeaders++;
        }
      }
      if (multiColHeaders >= 1) return false;
    }
    return true;
  }

  private detectEnclosedSideBoxes(
    items: BodyItemBox[],
    printW: number
  ): Array<{ y0: number; y1: number; left: TrackRange; right: TrackRange; gutterX: number }> {
    const out: Array<{ y0: number; y1: number; left: TrackRange; right: TrackRange; gutterX: number }> = [];
    interface BoxCandidate {
      x: number;
      y: number;
      width: number;
      height: number;
    }
    const candidateBoxes: BoxCandidate[] = items
      .filter(
        (it) =>
          it.kind === 'rect' &&
          it.width >= printW * 0.25 &&
          it.width < printW * 0.65 &&
          it.height >= 0.55 &&
          Boolean(it.region.style.borderColor)
      )
      .map((it) => ({ x: it.x, y: it.y, width: it.width, height: it.height }));

    // Reconstruct outer border boxes drawn as 4 stroked HLine + VLine segments (common when PDF doesn't emit a rect)
    const vLines = items
      .filter((it) => it.kind === 'line' && it.height > it.width * 1.5 && it.height >= 0.55)
      .sort((a, b) => a.x - b.x || a.y - b.y);
    const hLines = items.filter((it) => it.kind === 'line' && it.width > it.height * 1.5 && it.width >= printW * 0.25);
    for (let i = 0; i < vLines.length; i++) {
      for (let j = i + 1; j < vLines.length; j++) {
        const vl = vLines[i];
        const vr = vLines[j];
        const boxW = vr.x - vl.x;
        if (boxW < printW * 0.25 || boxW >= printW * 0.65) continue;
        const yOv = Math.min(vl.y + vl.height, vr.y + vr.height) - Math.max(vl.y, vr.y);
        if (yOv < 0.55 || Math.abs(vl.y - vr.y) > 0.12) continue;
        const minY = Math.min(vl.y, vr.y);
        const maxY = Math.max(vl.y + vl.height, vr.y + vr.height);
        const hasHBoundary = hLines.some(
          (hl) =>
            (Math.abs(hl.y - minY) <= 0.06 || Math.abs(hl.y - maxY) <= 0.06) &&
            hl.x <= vl.x + 0.08 &&
            hl.x + hl.width >= vr.x - 0.08
        );
        if (hasHBoundary) {
          const dup = candidateBoxes.some(
            (cb) =>
              Math.abs(cb.x - vl.x) <= 0.08 &&
              Math.abs(cb.x + cb.width - vr.x) <= 0.08 &&
              Math.abs(cb.y - minY) <= 0.12
          );
          if (!dup) {
            candidateBoxes.push({ x: vl.x, y: minY, width: boxW, height: maxY - minY });
          }
        }
      }
    }

    for (let i = 0; i < candidateBoxes.length; i++) {
      for (let j = i + 1; j < candidateBoxes.length; j++) {
        const a = candidateBoxes[i];
        const b = candidateBoxes[j];
        const left = a.x <= b.x ? a : b;
        const right = a.x <= b.x ? b : a;
        const gutter = right.x - (left.x + left.width);
        const yOverlap = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
        if (gutter >= 6 / PT_PER_INCH && yOverlap >= 0.50 && Math.abs(left.y - right.y) <= 0.35) {
          const bandY0 = Math.min(left.y, right.y);
          const bandY1 = Math.max(left.y + left.height, right.y + right.height);
          const gx = roundIn((left.x + left.width + right.x) / 2);
          const hasCrossers = items.some(
            (it) =>
              it.y + it.height / 2 >= bandY0 - 0.02 &&
              it.y + it.height / 2 <= bandY1 + 0.02 &&
              it.x < gx - 0.03 &&
              it.x + it.width > gx + 0.03 &&
              it.width >= printW * 0.65
          );
          if (!hasCrossers) {
            out.push({
              y0: bandY0,
              y1: bandY1,
              left: { x0: roundIn(left.x), x1: roundIn(left.x + left.width) },
              right: { x0: roundIn(right.x), x1: roundIn(right.x + right.width) },
              gutterX: gx,
            });
          }
        }
      }
    }
    return out;
  }

  private partitionPageIntoGeometricZones(
    items: BodyItemBox[],
    printW: number,
    incomingSideBySide: SideBySideState
  ): {
    zones: Array<
      | { kind: 'SingleTrack'; leftIn: number; widthIn: number; items: BodyItemBox[] }
      | { kind: 'SideBySide'; leftRange: TrackRange; rightRange: TrackRange; leftItems: BodyItemBox[]; rightItems: BodyItemBox[] }
    >;
    nextSideBySideState: SideBySideState;
  } {
    const minBannerW = printW * 0.28;
    const fullBanners = items
      .filter((b) => b.width >= printW * 0.70 && this.isBannerRect(b, items, minBannerW))
      .sort((a, b) => a.y - b.y);
    const halfBanners = items
      .filter((b) => b.width < printW * 0.65 && this.isBannerRect(b, items, minBannerW))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    // Pair side-by-side filled banners (|Δy| <= 4pt)
    const bannerPairs: Array<{ y0: number; left: TrackRange; right: TrackRange; gutterX: number; isTwoTierTouch: boolean }> = [];
    const usedHalf = new Set<number>();
    for (let i = 0; i < halfBanners.length; i++) {
      if (usedHalf.has(i)) continue;
      for (let j = i + 1; j < halfBanners.length; j++) {
        if (usedHalf.has(j)) continue;
        const a = halfBanners[i];
        const b = halfBanners[j];
        if (Math.abs(a.y - b.y) <= 4 / PT_PER_INCH) {
          const leftB = a.x <= b.x ? a : b;
          const rightB = a.x <= b.x ? b : a;
          const gutter = rightB.x - (leftB.x + leftB.width);
          const sitsBelowFullBanner = fullBanners.some(
            (fb) => leftB.y - (fb.y + fb.height) >= -0.02 && leftB.y - (fb.y + fb.height) <= 3 / PT_PER_INCH + 0.01
          );
          if (gutter >= 6 / PT_PER_INCH || (sitsBelowFullBanner && gutter >= -0.01)) {
            usedHalf.add(i);
            usedHalf.add(j);
            const gx = roundIn((leftB.x + leftB.width + rightB.x) / 2);
            bannerPairs.push({
              y0: Math.min(leftB.y, rightB.y),
              left: { x0: roundIn(leftB.x), x1: roundIn(Math.min(gx, leftB.x + leftB.width)) },
              right: { x0: roundIn(Math.max(gx, rightB.x)), x1: roundIn(rightB.x + rightB.width) },
              gutterX: gx,
              isTwoTierTouch: sitsBelowFullBanner,
            });
            break;
          }
        }
      }
    }

    const enclosedPairs = this.detectEnclosedSideBoxes(items, printW);

    // Full-width outer border boxes (>= 0.70 * printW), full-width H_DIVIDER lines, or full-width text crossers act as resets
    const fullWidthBoxStarts = items
      .filter((it) => it.kind === 'rect' && it.width >= printW * 0.70 && it.height >= 0.45 && Boolean(it.region.style.borderColor))
      .map((it) => it.y);
    const fullWidthHLineStarts = items
      .filter((it) => it.kind === 'line' && it.width > it.height * 2 && it.width >= printW * 0.70)
      .map((it) => it.y);
    const wideTextCrossers = items
      .filter((it) => it.kind === 'text' && it.width >= printW * 0.70)
      .map((it) => it.y);

    // Build vertical event timeline to transition cleanly between SingleTrack and SideBySide
    interface EventPoint {
      y: number;
      type: 'ENTER_SBS' | 'EXIT_SBS' | 'FULL_BANNER';
      pair?: { left: TrackRange; right: TrackRange; gutterX: number };
      banner?: BodyItemBox;
    }

    const events: EventPoint[] = [];
    for (const bp of bannerPairs) {
      events.push({ y: bp.y0, type: 'ENTER_SBS', pair: { left: bp.left, right: bp.right, gutterX: bp.gutterX } });
    }
    for (const ep of enclosedPairs) {
      const alreadyBannered = bannerPairs.some((bp) => Math.abs(bp.y0 - ep.y0) <= 0.4);
      if (!alreadyBannered) {
        events.push({ y: ep.y0, type: 'ENTER_SBS', pair: { left: ep.left, right: ep.right, gutterX: ep.gutterX } });
      }
    }
    for (const fb of fullBanners) {
      events.push({ y: fb.y, type: 'FULL_BANNER', banner: fb });
    }
    for (const fy of [...fullWidthBoxStarts, ...fullWidthHLineStarts, ...wideTextCrossers]) {
      events.push({ y: fy, type: 'EXIT_SBS' });
    }
    events.sort((a, b) => a.y - b.y);

    // Determine initial state for this page (persisting across page breaks unless top items are full-width)
    let state: SideBySideState = { ...incomingSideBySide };
    const topEvent = events.find((e) => e.y <= 0.45);
    if (topEvent && (topEvent.type === 'FULL_BANNER' || topEvent.type === 'EXIT_SBS')) {
      state = { ...state, active: false };
    } else if (state.active) {
      // Confirm no item near top of page straddles incoming gutterX
      const hasTopCrosser = items.some(
        (it) =>
          it.y <= 0.75 &&
          it.x < state.gutterX - 0.04 &&
          it.x + it.width > state.gutterX + 0.04 &&
          it.width >= printW * 0.55
      );
      if (hasTopCrosser) {
        state = { ...state, active: false };
      }
    }

    // Partition items into monotonic Y slices whenever mode flips
    const segments: Array<{
      yStart: number;
      yEnd: number;
      sbs: SideBySideState;
    }> = [];
    let curY = 0;
    let curState: SideBySideState = { ...state };

    const maxItemY = Math.max(...items.map((it) => it.y + it.height)) + 0.05;

    for (const ev of events) {
      if (ev.type === 'ENTER_SBS' && ev.pair) {
        if (!curState.active && ev.y > curY + 0.04) {
          segments.push({ yStart: curY, yEnd: ev.y - 0.005, sbs: { ...curState } });
          curY = ev.y - 0.005;
        }
        curState = {
          active: true,
          left: ev.pair.left,
          right: ev.pair.right,
          gutterX: ev.pair.gutterX,
        };
      } else if (ev.type === 'FULL_BANNER' && ev.banner) {
        // Every full-width filled banner below curY ALWAYS closes the upper Tablix and starts a brand-new Tablix with that banner as Row 0.
        const cutY = ev.y - 0.005;
        const hasItemsAbove = items.some((it) => {
          const cy = it.y + it.height / 2;
          return cy >= curY && cy < cutY;
        });
        if (ev.y > curY + 0.04 && hasItemsAbove) {
          segments.push({ yStart: curY, yEnd: cutY, sbs: { ...curState } });
          curY = cutY;
        }
        curState = { ...curState, active: false };
      } else if (ev.type === 'EXIT_SBS') {
        if (curState.active) {
          const crossesGutter = items.some(
            (it) =>
              Math.abs(it.y - ev.y) <= 0.02 &&
              it.x < curState.gutterX - 0.04 &&
              it.x + it.width > curState.gutterX + 0.04 &&
              it.width >= printW * 0.65
          );
          if (crossesGutter) {
            if (ev.y > curY + 0.04) {
              segments.push({ yStart: curY, yEnd: ev.y - 0.005, sbs: { ...curState } });
              curY = ev.y - 0.005;
            }
            curState = { ...curState, active: false };
          }
        }
      }
    }

    if (maxItemY > curY) {
      segments.push({ yStart: curY, yEnd: maxItemY, sbs: { ...curState } });
    }

    const zones: Array<
      | { kind: 'SingleTrack'; leftIn: number; widthIn: number; items: BodyItemBox[] }
      | { kind: 'SideBySide'; leftRange: TrackRange; rightRange: TrackRange; leftItems: BodyItemBox[]; rightItems: BodyItemBox[] }
    > = [];

    for (const seg of segments) {
      const segItems = items.filter((it) => {
        const cy = it.y + it.height / 2;
        return cy >= seg.yStart && cy < seg.yEnd;
      });
      if (segItems.length === 0) continue;

      if (!seg.sbs.active) {
        zones.push({
          kind: 'SingleTrack',
          leftIn: 0,
          widthIn: roundIn(printW),
          items: segItems,
        });
      } else {
        const leftItems: BodyItemBox[] = [];
        const rightItems: BodyItemBox[] = [];
        for (const it of segItems) {
          const cx = it.x + it.width / 2;
          if (cx <= seg.sbs.gutterX) {
            leftItems.push(it);
          } else {
            rightItems.push(it);
          }
        }
        zones.push({
          kind: 'SideBySide',
          leftRange: seg.sbs.left,
          rightRange: seg.sbs.right,
          leftItems,
          rightItems,
        });
      }
    }

    return { zones, nextSideBySideState: curState };
  }

  private hasModeAVectorGrid(items: BodyItemBox[]): {
    isGrid: boolean;
    minGridY: number;
    maxGridY: number;
    colCount: number;
    rowCount: number;
  } {
    const rawMinX = items.length > 0 ? Math.min(...items.map((it) => it.x)) : 0;
    const rawMaxX = items.length > 0 ? Math.max(...items.map((it) => it.x + it.width)) : 0;
    const rawMinY = items.length > 0 ? Math.min(...items.map((it) => it.y)) : 0;
    const rawMaxY = items.length > 0 ? Math.max(...items.map((it) => it.y + it.height)) : 0;
    const spanW = Math.max(0.1, rawMaxX - rawMinX);
    const spanH = Math.max(0.1, rawMaxY - rawMinY);

    // Exclude outer perimeter container box edges (e.g. a full side-track box framing narrative + a small inner table)
    const isOuterPerimeterVLine = (vl: BodyItemBox): boolean => {
      if (vl.height < spanH * 0.72) return false;
      const nearEdge = Math.abs(vl.x - rawMinX) <= 0.12 || Math.abs(vl.x - rawMaxX) <= 0.12;
      if (!nearEdge) return false;
      const interiorVLines = items.filter(
        (it) =>
          it.kind === 'line' &&
          it.height > it.width * 1.5 &&
          it.height >= 0.22 &&
          it.x > rawMinX + 0.14 &&
          it.x < rawMaxX - 0.14
      );
      if (interiorVLines.length === 0) return true;
      return interiorVLines.every((iv) => iv.height < vl.height * 0.65);
    };

    const vLines = items.filter(
      (it) => it.kind === 'line' && it.height > it.width * 1.5 && it.height >= 0.22 && !isOuterPerimeterVLine(it)
    );
    const hLines = items.filter((it) => it.kind === 'line' && it.width > it.height * 1.5 && it.width >= 0.45);
    const cellRects = items.filter(
      (it) =>
        it.kind === 'rect' &&
        it.width >= 0.20 &&
        it.height >= 0.11 &&
        it.height <= 1.6 &&
        !(it.width >= spanW * 0.85 && it.height >= spanH * 0.72 && !it.region.style.backgroundColor) &&
        Boolean(it.region.style.backgroundColor || it.region.style.borderColor)
    );

    // Case 1: Explicit vertical & horizontal vector grid lines or cell rects
    const xs: number[] = [];
    const ys: number[] = [];
    for (const vl of vLines) xs.push(vl.x);
    for (const hl of hLines) ys.push(hl.y);
    for (const cr of cellRects) {
      const sideBySide = cellRects.filter((o) => Math.abs(o.y - cr.y) <= 0.08 && o.width < cr.width * 2).length;
      if (sideBySide >= 2 || vLines.length >= 1) {
        xs.push(cr.x, cr.x + cr.width);
        ys.push(cr.y, cr.y + cr.height);
      }
    }

    const colEdges = clusterValues(xs, 3 / PT_PER_INCH).filter((v, i, a) => i === 0 || v - a[i - 1] >= 0.08);
    const rowEdges = clusterValues(ys, 3 / PT_PER_INCH).filter((v, i, a) => i === 0 || v - a[i - 1] >= 0.07);

    if (colEdges.length >= 3 && rowEdges.length >= 3) {
      const minX = colEdges[0];
      const maxX = colEdges[colEdges.length - 1];
      const minY = rowEdges[0];
      const maxY = rowEdges[rowEdges.length - 1];
      const textsInGrid = items.filter(
        (it) =>
          it.kind === 'text' &&
          it.x >= minX - 0.05 &&
          it.x + it.width <= maxX + 0.05 &&
          it.y >= minY - 0.05 &&
          it.y + it.height <= maxY + 0.05
      );
      if (textsInGrid.length >= 4) {
        return {
          isGrid: true,
          minGridY: minY,
          maxGridY: maxY,
          colCount: colEdges.length - 1,
          rowCount: rowEdges.length - 1,
        };
      }
    }

    return { isGrid: false, minGridY: 0, maxGridY: 0, colCount: 0, rowCount: 0 };
  }

  private haveDifferentColumnTopology(upperItems: BodyItemBox[], lowerItems: BodyItemBox[]): boolean {
    const getAnchors = (list: BodyItemBox[]): number[] => {
      const texts = list.filter((it) => it.kind === 'text' && it.region.text?.trim());
      if (texts.length === 0) return [];
      return clusterValues(texts.map((t) => t.x), 8 / PT_PER_INCH);
    };
    const countSideBySideLines = (list: BodyItemBox[]): number => {
      const texts = list.filter((it) => it.kind === 'text').sort((a, b) => a.y - b.y || a.x - b.x);
      let multiCount = 0;
      let i = 0;
      while (i < texts.length) {
        let j = i + 1;
        while (j < texts.length && Math.abs(texts[j].y - texts[i].y) <= 0.05) j++;
        if (j - i >= 3) multiCount++;
        i = j;
      }
      return multiCount;
    };

    const uGrid = this.hasModeAVectorGrid(upperItems);
    const lGrid = this.hasModeAVectorGrid(lowerItems);
    if (uGrid.isGrid !== lGrid.isGrid) return true;

    const uMulti = countSideBySideLines(upperItems);
    const lMulti = countSideBySideLines(lowerItems);
    if ((uMulti >= 2 && lMulti === 0) || (lMulti >= 2 && uMulti === 0)) return true;

    const uAnchors = getAnchors(upperItems);
    const lAnchors = getAnchors(lowerItems);
    if (uAnchors.length === 0 || lAnchors.length === 0) return false;
    if (Math.abs(uAnchors.length - lAnchors.length) >= 2) return true;

    let matches = 0;
    for (const ua of uAnchors) {
      if (lAnchors.some((la) => Math.abs(la - ua) <= 0.14)) matches++;
    }
    const overlapRatio = matches / Math.max(uAnchors.length, lAnchors.length);
    return overlapRatio < 0.55;
  }

  private splitSingleTrackBand(
    items: BodyItemBox[],
    leftIn: number,
    widthIn: number,
    printW: number
  ): AtomicSegment[] {
    if (items.length === 0) return [];
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);

    // 1. Identify full-width H_DIVIDER lines (>= 0.85 * printW) that are NOT crossed by vertical table grid lines
    const vGridLines = sorted.filter((it) => it.kind === 'line' && it.height > it.width * 1.5 && it.height >= 0.35);
    const candidateHDividers = sorted
      .filter(
        (it) =>
          (it.kind === 'line' || (it.kind === 'rect' && it.height <= 0.03)) &&
          it.width >= printW * 0.85 &&
          !vGridLines.some(
            (vl) =>
              vl.x > it.x + 0.25 &&
              vl.x < it.x + it.width - 0.25 &&
              vl.y < it.y - 0.04 &&
              vl.y + vl.height > it.y + 0.04
          )
      )
      .sort((a, b) => a.y - b.y);

    // Build mandatory cuts for any interior full-width filled banners + H_DIVIDER cuts where topologies differ
    const cuts: number[] = [];
    const minY = Math.min(...sorted.map((it) => it.y));
    const maxY = Math.max(...sorted.map((it) => it.y + it.height));

    const interiorBanners = sorted
      .filter((it) => this.isBannerRect(it, sorted, printW * 0.70) && it.y > minY + 0.08)
      .sort((a, b) => a.y - b.y);
    for (const ib of interiorBanners) {
      cuts.push(ib.y - 0.005);
    }

    for (const hd of candidateHDividers) {
      if (hd.y - minY < 0.20 || maxY - hd.y < 0.20) continue;
      if (cuts.some((c) => Math.abs(c - hd.y) <= 0.08)) continue;
      const relevantCutsBefore = cuts.filter((c) => c < hd.y).sort((a, b) => a - b);
      const prevCut = relevantCutsBefore.length > 0 ? relevantCutsBefore[relevantCutsBefore.length - 1] : minY - 0.01;
      const upper = sorted.filter((it) => it.y + it.height / 2 >= prevCut && it.y + it.height / 2 < hd.y);
      const lower = sorted.filter((it) => it.y + it.height / 2 > hd.y);
      if (upper.length > 0 && lower.length > 0 && this.haveDifferentColumnTopology(upper, lower)) {
        cuts.push(hd.y);
      }
    }

    const sortedCuts = clusterValues(cuts, 0.04).filter((c) => c > minY + 0.04 && c < maxY - 0.04);
    const boundaries = [minY - 0.02, ...sortedCuts, maxY + 0.02];
    const hBands: Array<{ y0: number; y1: number; locked: boolean; items: BodyItemBox[] }> = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const b0 = boundaries[i];
      const b1 = boundaries[i + 1];
      const subItems = sorted.filter((it) => {
        const cy = it.y + it.height / 2;
        return cy >= b0 && cy < b1;
      });
      if (subItems.length === 0) continue;
      const boundedByDivider = sortedCuts.some(
        (c) =>
          (Math.abs(c - b0) <= 0.05 || Math.abs(c - b1) <= 0.05) &&
          candidateHDividers.some((hd) => Math.abs(hd.y - c) <= 0.05)
      );
      hBands.push({ y0: b0, y1: b1, locked: boundedByDivider, items: subItems });
    }

    const resultSegs: AtomicSegment[] = [];
    for (const hb of hBands) {
      // Check Mode A dense table + post-table footnotes OR embedded Mode A grid
      const gridInfo = this.hasModeAVectorGrid(hb.items);
      if (gridInfo.isGrid) {
        // Items above grid (unless just the section banner attached cleanly, or separate band), grid itself, footnotes below
        const aboveGrid = hb.items.filter((it) => it.y + it.height <= gridInfo.minGridY - 0.02);
        const gridOnly = hb.items.filter(
          (it) => it.y + it.height > gridInfo.minGridY - 0.02 && it.y < gridInfo.maxGridY + 0.02
        );
        const belowGrid = hb.items.filter((it) => it.y >= gridInfo.maxGridY + 0.02);

        if (aboveGrid.length > 0) {
          // If aboveGrid is ONLY full-width banners, keep attached or separate cleanly; if narrative, split
          const aboveOnlyBanners = aboveGrid.every(
            (it) => this.isBannerRect(it, aboveGrid, widthIn * 0.6) || (it.kind === 'text' && aboveGrid.some((r) => this.isBannerRect(r, aboveGrid, widthIn * 0.6)))
          );
          if (!aboveOnlyBanners) {
            resultSegs.push(...this.splitOptionalCoverageSubBlocks(aboveGrid, leftIn, widthIn, hb.locked));
          } else {
            gridOnly.unshift(...aboveGrid);
          }
        }

        resultSegs.push({
          y0: Math.min(...gridOnly.map((i) => i.y)),
          y1: Math.max(...gridOnly.map((i) => i.y + i.height)),
          leftIn,
          widthIn,
          items: gridOnly,
          trackSide: 'Single',
          lockedByHDivider: true,
        });

        if (belowGrid.length > 0) {
          // Split wide-column footnotes (<= 2 cols, >= 75% width) below dense multi-column tables (>= 4 cols)
          resultSegs.push(...this.splitOptionalCoverageSubBlocks(belowGrid, leftIn, widthIn, hb.locked));
        }
      } else {
        resultSegs.push(...this.splitOptionalCoverageSubBlocks(hb.items, leftIn, widthIn, hb.locked));
      }
    }

    return resultSegs;
  }

  private splitOptionalCoverageSubBlocks(
    items: BodyItemBox[],
    leftIn: number,
    widthIn: number,
    lockedByHDivider: boolean
  ): AtomicSegment[] {
    if (items.length === 0) return [];
    const minY = Math.min(...items.map((i) => i.y));
    const maxY = Math.max(...items.map((i) => i.y + i.height));

    // Container Lock: inside an unbroken band bounded by H_DIVIDER lines, NEVER split on bold text alone!
    if (lockedByHDivider) {
      return [{ y0: minY, y1: maxY, leftIn, widthIn, items, trackSide: 'Single', lockedByHDivider: true }];
    }

    // Check for repeatable/optional coverage blocks: >= 2 bold full-row group subheaders each preceding a structured block
    const sortedTexts = items
      .filter((it) => it.kind === 'text' && it.region.text?.trim())
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const boldGroupHeaders: number[] = [];

    for (let i = 0; i < sortedTexts.length; i++) {
      const t = sortedTexts[i];
      if (!t.region.style.bold) continue;
      if (startsWithListMarker(t.region.text!)) continue;
      const hasRightSibling = sortedTexts.some(
        (o, idx) => idx !== i && Math.abs(o.y - t.y) <= 0.05 && o.x > t.x + 0.1
      );
      if (hasRightSibling) continue;
      // Check if preceded by a significant gap (>= 0.14in) OR shaded/bordered subheader bar
      const prev = i > 0 ? sortedTexts[i - 1] : undefined;
      const gapAbove = prev ? t.y - (prev.y + prev.height) : 0;
      const insideBanner = items.some(
        (r) => r.kind === 'rect' && this.isBannerRect(r, items, widthIn * 0.55) && t.y >= r.y - 0.02 && t.y + t.height <= r.y + r.height + 0.02
      );
      if ((i > 0 && gapAbove >= 0.14) || (i > 0 && insideBanner)) {
        boldGroupHeaders.push(insideBanner ? t.y - 0.04 : t.y - 0.02);
      }
    }

    if (boldGroupHeaders.length >= 2) {
      const cuts = [minY - 0.02, ...boldGroupHeaders, maxY + 0.02];
      const segs: AtomicSegment[] = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const sub = items.filter((it) => {
          const cy = it.y + it.height / 2;
          return cy >= cuts[i] && cy < cuts[i + 1];
        });
        if (sub.length > 0) {
          segs.push({
            y0: cuts[i],
            y1: cuts[i + 1],
            leftIn,
            widthIn,
            items: sub,
            trackSide: 'Single',
          });
        }
      }
      if (segs.length >= 2) return segs;
    }

    return [{ y0: minY, y1: maxY, leftIn, widthIn, items, trackSide: 'Single' }];
  }

  private splitSideTrack(items: BodyItemBox[], trackLeftIn: number, trackWidthIn: number): AtomicSegment[] {
    if (items.length === 0) return [];
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const minY = Math.min(...sorted.map((it) => it.y));
    const maxY = Math.max(...sorted.map((it) => it.y + it.height));

    // Mid-track banners or horizontal track dividers (>= 70% trackWidthIn, not inside grid) close and stack a new Tablix
    const midTrackCuts: number[] = [];
    for (const it of sorted) {
      if (it.y - minY <= 0.12) continue;
      if (this.isBannerRect(it, sorted, trackWidthIn * 0.65)) {
        midTrackCuts.push(it.y - 0.01);
        continue;
      }
      if (
        (it.kind === 'line' || (it.kind === 'rect' && it.height <= 0.025)) &&
        it.width >= trackWidthIn * 0.70
      ) {
        // Ignore perimeter top/bottom line of an enclosed box
        const isBoxTopOrBot = sorted.some(
          (r) => r.kind === 'rect' && r.height >= 0.5 && (Math.abs(it.y - r.y) <= 0.03 || Math.abs(it.y - (r.y + r.height)) <= 0.03)
        );
        if (!isBoxTopOrBot) {
          midTrackCuts.push(it.y);
        }
      }
    }

    // Also split out any embedded Mode A bordered data table inside a side track (since nested Tablix is forbidden in 2008)
    const gridInfo = this.hasModeAVectorGrid(sorted);
    if (gridInfo.isGrid) {
      if (gridInfo.minGridY - minY >= 0.10) midTrackCuts.push(gridInfo.minGridY - 0.01);
      if (maxY - gridInfo.maxGridY >= 0.10) midTrackCuts.push(gridInfo.maxGridY + 0.01);
    }

    const uniqueCuts = clusterValues(midTrackCuts, 0.05).filter((c) => c > minY + 0.08 && c < maxY - 0.08);
    const boundaries = [minY - 0.02, ...uniqueCuts, maxY + 0.02];

    const segs: AtomicSegment[] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const b0 = boundaries[i];
      const b1 = boundaries[i + 1];
      const sub = sorted.filter((it) => {
        const cy = it.y + it.height / 2;
        return cy >= b0 && cy < b1;
      });
      if (sub.length === 0) continue;
      segs.push({
        y0: Math.min(...sub.map((it) => it.y)),
        y1: Math.max(...sub.map((it) => it.y + it.height)),
        leftIn: roundIn(trackLeftIn),
        widthIn: roundIn(Math.max(0.5, trackWidthIn)),
        items: sub,
      });
    }
    return segs;
  }

  private quantizeSegmentToTablix(
    tablixName: string,
    seg: AtomicSegment,
    pageNumber: number,
    topIn: number,
    dataSetName: string,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    pageBreakBefore: boolean
  ): TablixRegion {
    // Check Mode A (Vector-Grid-First for bordered tables)
    const modeATbl = this.tryBuildModeAVectorGridTablix(
      tablixName,
      seg,
      pageNumber,
      topIn,
      dataSetName,
      nextUniqueName,
      pageBreakBefore
    );
    if (modeATbl) return modeATbl;

    // Fallback/Standard Mode B (Paragraph-first + Left-edge x0 atomic columns)
    return this.buildModeBNarrativeOrKeyValueTablix(
      tablixName,
      seg,
      pageNumber,
      topIn,
      dataSetName,
      registerEmbeddedImage,
      nextUniqueName,
      pageBreakBefore
    );
  }

  private tryBuildModeAVectorGridTablix(
    tablixName: string,
    seg: AtomicSegment,
    pageNumber: number,
    topIn: number,
    dataSetName: string,
    nextUniqueName: (prefix: string) => string,
    pageBreakBefore: boolean
  ): TablixRegion | undefined {
    const { items, leftIn: segLeftIn, widthIn: segWidthIn } = seg;
    const gridInfo = this.hasModeAVectorGrid(items);
    if (!gridInfo.isGrid || gridInfo.colCount < 2 || gridInfo.rowCount < 2) return undefined;

    const bannerRects = items.filter(
      (it) => it.y + it.height <= gridInfo.minGridY - 0.01 && this.isBannerRect(it, items, segWidthIn * 0.5)
    );
    const gridItems = items.filter((it) => it.y + it.height > gridInfo.minGridY - 0.02);

    const gridMinX = gridItems.length > 0 ? Math.min(...gridItems.map((it) => it.x)) : 0;
    const gridMaxX = gridItems.length > 0 ? Math.max(...gridItems.map((it) => it.x + it.width)) : 0;
    const gridMinY = gridItems.length > 0 ? Math.min(...gridItems.map((it) => it.y)) : 0;
    const gridMaxY = gridItems.length > 0 ? Math.max(...gridItems.map((it) => it.y + it.height)) : 0;
    const spanW = Math.max(0.1, gridMaxX - gridMinX);
    const spanH = Math.max(0.1, gridMaxY - gridMinY);

    const vLines = gridItems.filter((it) => it.kind === 'line' && it.height > it.width * 1.5 && it.height >= 0.2);
    const hLines = gridItems.filter((it) => it.kind === 'line' && it.width > it.height * 1.5 && it.width >= 0.4);
    const cellRects = gridItems.filter(
      (it) =>
        it.kind === 'rect' &&
        it.width >= 0.2 &&
        it.height >= 0.11 &&
        it.height <= 1.6 &&
        !(it.width >= spanW * 0.85 && it.height >= spanH * 0.72 && !it.region.style.backgroundColor) &&
        Boolean(it.region.style.backgroundColor || it.region.style.borderColor)
    );
    const textItems = gridItems.filter((it) => it.kind === 'text' && it.region.text?.trim());
    if (textItems.length < 3) return undefined;

    const rawXs: number[] = [];
    const rawYs: number[] = [];
    for (const vl of vLines) rawXs.push(vl.x);
    for (const hl of hLines) rawYs.push(hl.y);
    for (const cr of cellRects) {
      const sideBySide = cellRects.filter((o) => Math.abs(o.y - cr.y) <= 0.08 && o.width < cr.width * 2).length;
      if (sideBySide >= 2 || vLines.length >= 1) {
        rawXs.push(cr.x, cr.x + cr.width);
      }
      rawYs.push(cr.y, cr.y + cr.height);
    }

    const colEdges = clusterValues(rawXs, 3 / PT_PER_INCH).filter((v, i, a) => i === 0 || v - a[i - 1] >= 0.08);
    const baseRowEdges = clusterValues(rawYs, 3 / PT_PER_INCH).filter((v, i, a) => i === 0 || v - a[i - 1] >= 0.07);
    if (colEdges.length < 3 || baseRowEdges.length < 3) return undefined;

    // Sub-slice tall unshaded gaps between HLine/FillBand row edges ONLY when >= 2 multi-column baseline rows sit inside separated by whitespace
    const refinedYs: number[] = [...baseRowEdges];
    for (let r = 0; r < baseRowEdges.length - 1; r++) {
      const yA = baseRowEdges[r];
      const yB = baseRowEdges[r + 1];
      if (yB - yA < 0.35) continue;
      const inBandTexts = textItems
        .filter((t) => t.y + t.height / 2 >= yA && t.y + t.height / 2 <= yB)
        .sort((a, b) => a.y - b.y || a.x - b.x);
      if (inBandTexts.length < 4) continue;
      const baseLines: BodyItemBox[][] = [];
      for (const bt of inBandTexts) {
        const last = baseLines[baseLines.length - 1];
        if (last && Math.abs(bt.y - last[0].y) <= 3.5 / PT_PER_INCH) {
          last.push(bt);
        } else {
          baseLines.push([bt]);
        }
      }
      const multiColLines = baseLines.filter((bl) => bl.length >= 2);
      if (baseLines.length >= 2 && multiColLines.length >= baseLines.length * 0.75) {
        for (let b = 0; b < baseLines.length - 1; b++) {
          const curBot = Math.max(...baseLines[b].map((t) => t.y + t.height));
          const nxtTop = Math.min(...baseLines[b + 1].map((t) => t.y));
          const minF = Math.min(...baseLines[b].map((t) => t.region.style.fontSizePt));
          if (nxtTop - curBot >= (minF * 0.35) / PT_PER_INCH) {
            refinedYs.push(roundIn((curBot + nxtTop) / 2));
          }
        }
      }
    }
    const rowEdges = clusterValues(refinedYs, 2.5 / PT_PER_INCH).filter((v, i, a) => i === 0 || v - a[i - 1] >= 0.07);
    if (rowEdges.length < 3) return undefined;

    const tblLeftIn = roundIn(Math.max(segLeftIn, colEdges[0]));
    const gridLeft = colEdges[0];
    const gridRight = colEdges[colEdges.length - 1];
    const numCols = colEdges.length - 1;
    const numRows = rowEdges.length - 1;
    const columnWidthsIn = Array.from({ length: numCols }, (_, c) => Math.max(0.06, roundIn(colEdges[c + 1] - colEdges[c])));

    const hasVerticalDividerAt = (edgeX: number, y1: number, y2: number): boolean => {
      if (vLines.some((vl) => Math.abs(vl.x - edgeX) <= 0.045 && vl.y <= y1 + 0.05 && vl.y + vl.height >= y2 - 0.05)) {
        return true;
      }
      return cellRects.some(
        (cr) =>
          (Math.abs(cr.x - edgeX) <= 0.045 || Math.abs(cr.x + cr.width - edgeX) <= 0.045) &&
          cr.y <= y1 + 0.05 &&
          cr.y + cr.height >= y2 - 0.05
      );
    };

    const hasHorizontalDividerAt = (edgeY: number, x1: number, x2: number): boolean => {
      if (
        hLines.some(
          (hl) =>
            Math.abs(hl.y - edgeY) <= 0.045 &&
            Math.min(hl.x + hl.width, x2) - Math.max(hl.x, x1) >= (x2 - x1) * 0.45
        )
      ) {
        return true;
      }
      return cellRects.some(
        (cr) =>
          (Math.abs(cr.y - edgeY) <= 0.045 || Math.abs(cr.y + cr.height - edgeY) <= 0.045) &&
          Math.min(cr.x + cr.width, x2) - Math.max(cr.x, x1) >= (x2 - x1) * 0.45
      );
    };

    // Determine detected border color or default #D0D7DE (0.5pt Solid)
    const sampleBorderHex =
      hLines[0]?.region.style.borderColor ??
      vLines[0]?.region.style.borderColor ??
      cellRects.find((r) => r.region.style.borderColor)?.region.style.borderColor ??
      '#D0D7DE';
    const gridBorderColor =
      sampleBorderHex && sampleBorderHex.toUpperCase() !== '#FFFFFF' ? sampleBorderHex : '#D0D7DE';

    const rows: TablixRow[] = [];

    // Prepend optional top section banners as centered ColSpan=numCols rows
    for (const br of bannerRects) {
      const brTexts = items
        .filter(
          (it) =>
            it.kind === 'text' &&
            it.y + it.height / 2 >= br.y - 0.02 &&
            it.y + it.height / 2 <= br.y + br.height + 0.02
        )
        .sort((a, b) => a.x - b.x);
      const bText = brTexts.map((t) => t.region.text?.trim() ?? '').filter(Boolean).join(' ');
      const bStyle = brTexts[0]?.region.style ?? defaultTextStyle(9);
      const cells: TablixCell[] = Array.from({ length: numCols }, (_, cIdx) =>
        cIdx === 0
          ? {
              colIndex: 0,
              rowIndex: rows.length,
              colSpan: numCols,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Textbox',
                name: nextUniqueName('BannerTxt'),
                value: bText,
                runs: [
                  {
                    text: bText,
                    fontFamily: bStyle.fontFamily,
                    fontSizePt: bStyle.fontSizePt,
                    bold: bStyle.bold || true,
                    italic: bStyle.italic,
                    color: bStyle.color,
                  },
                ],
                isExpression: false,
                style: {
                  ...bStyle,
                  bold: true,
                  backgroundColor: br.region.style.backgroundColor,
                  borderColor: gridBorderColor,
                  borderWidthPt: 0.5,
                  textAlign: 'Center',
                  verticalAlign: 'Middle',
                  paddingPt: { top: 2, right: 3, bottom: 2, left: 3 },
                },
                canGrow: true,
              },
            }
          : {
              colIndex: cIdx,
              rowIndex: rows.length,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: true,
              content: { kind: 'Empty', name: nextUniqueName('Empty') },
            }
      );
      rows.push({
        heightIn: roundIn(Math.max(0.18, br.height)),
        isDetailRow: false,
        pageBreakBefore: rows.length === 0 && pageBreakBefore ? true : undefined,
        cells,
      });
    }

    // RDLC 2008 vertical-merge simulation tracker: activeVMerges[`${r}:${c}`]
    interface VMergeSpanInfo {
      topRow: number;
      bottomRow: number;
      colSpan: number;
      bgColor?: string;
    }
    const vMergeChildMap = new Map<string, VMergeSpanInfo>();
    const horizOccupied = new Set<string>();

    for (let rIdx = 0; rIdx < numRows; rIdx++) {
      const y1 = rowEdges[rIdx];
      const y2 = rowEdges[rIdx + 1];
      const baseRowH = Math.max(0.14, roundIn(y2 - y1));
      const actualRowIdx = rows.length;
      const cells: TablixCell[] = [];
      let rowMaxEstH = baseRowH;

      for (let cIdx = 0; cIdx < numCols; cIdx++) {
        const coord = `${rIdx}:${cIdx}`;
        if (horizOccupied.has(coord)) {
          cells.push({
            colIndex: cIdx,
            rowIndex: actualRowIdx,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: true,
            content: { kind: 'Empty', name: nextUniqueName('Empty') },
          });
          continue;
        }

        // Check if this cell is an empty vertical-merge continuation cell from an upper row
        const vCont = vMergeChildMap.get(coord);
        if (vCont) {
          const isBottom = rIdx === vCont.bottomRow;
          for (let cc = cIdx + 1; cc < cIdx + vCont.colSpan; cc++) {
            horizOccupied.add(`${rIdx}:${cc}`);
          }
          cells.push({
            colIndex: cIdx,
            rowIndex: actualRowIdx,
            colSpan: vCont.colSpan,
            rowSpan: 1, // NEVER > 1 in RDLC 2008
            skipBecauseMerged: false,
            content: {
              kind: 'Textbox',
              name: nextUniqueName('VMergeCont'),
              value: '',
              isExpression: false,
              style: {
                ...defaultTextStyle(8),
                backgroundColor: vCont.bgColor,
                borderColor: gridBorderColor,
                borderWidthPt: 0.5,
                borderEdges: {
                  top: 'None',
                  bottom: isBottom ? 'Solid' : 'None',
                  left: 'Solid',
                  right: 'Solid',
                },
                paddingPt: { top: 1, right: 2, bottom: 1, left: 2 },
              },
              canGrow: true,
            },
          });
          continue;
        }

        const x1 = colEdges[cIdx];

        // 1. Detect horizontal merge (colSpan) from matching rect or absent interior vertical grid lines
        let colSpan = 1;
        const enclosingRect = cellRects
          .filter(
            (cr) =>
              cr.x <= x1 + 0.05 &&
              cr.x + cr.width >= colEdges[cIdx + 1] - 0.05 &&
              cr.y <= y1 + 0.05 &&
              cr.y + cr.height >= y2 - 0.05
          )
          .sort((a, b) => a.width * a.height - b.width * b.height)[0];

        while (cIdx + colSpan < numCols) {
          const nextEdgeX = colEdges[cIdx + colSpan];
          if (enclosingRect && enclosingRect.x + enclosingRect.width >= colEdges[cIdx + colSpan + 1] - 0.05) {
            colSpan++;
            continue;
          }
          if (!hasVerticalDividerAt(nextEdgeX, y1, y2)) {
            const nextColRightX = colEdges[cIdx + colSpan + 1];
            const spanningText = textItems.some(
              (t) =>
                t.y + t.height / 2 >= y1 - 0.02 &&
                t.y + t.height / 2 <= y2 + 0.02 &&
                t.x < nextEdgeX - 0.02 &&
                t.x + t.width > nextEdgeX + 0.02
            );
            const curHasText = textItems.some(
              (t) =>
                t.y + t.height / 2 >= y1 - 0.02 &&
                t.y + t.height / 2 <= y2 + 0.02 &&
                t.x + t.width / 2 >= x1 - 0.02 &&
                t.x + t.width / 2 <= nextEdgeX + 0.02
            );
            const nextColHasText = textItems.some(
              (t) =>
                t.y + t.height / 2 >= y1 - 0.02 &&
                t.y + t.height / 2 <= y2 + 0.02 &&
                t.x >= nextEdgeX - 0.02 &&
                t.x + t.width / 2 <= nextColRightX + 0.02
            );
            if (spanningText || (curHasText && !nextColHasText && rIdx <= 1)) {
              colSpan++;
              continue;
            }
          }
          break;
        }

        const spanX2 = colEdges[cIdx + colSpan];
        for (let cc = cIdx + 1; cc < cIdx + colSpan; cc++) {
          horizOccupied.add(`${rIdx}:${cc}`);
        }

        // 2. Detect vertical merge (simulated cleanly without <RowSpan>)
        let vSpan = 1;
        while (rIdx + vSpan < numRows) {
          const nextEdgeY = rowEdges[rIdx + vSpan];
          const nextRowY2 = rowEdges[rIdx + vSpan + 1];
          if (enclosingRect && enclosingRect.y + enclosingRect.height >= nextRowY2 - 0.05) {
            vSpan++;
            continue;
          }
          if (!hasHorizontalDividerAt(nextEdgeY, x1, spanX2)) {
            vSpan++;
            continue;
          }
          break;
        }

        const spanY2 = rowEdges[rIdx + vSpan];
        const cellTexts = textItems
          .filter((t) => {
            const cx = t.x + t.width / 2;
            const cy = t.y + t.height / 2;
            return cx >= x1 - 0.04 && cx <= spanX2 + 0.04 && cy >= y1 - 0.04 && cy <= spanY2 + 0.04;
          })
          .sort((a, b) => a.y - b.y || a.x - b.x);

        const bgColor =
          enclosingRect?.region.style.backgroundColor ??
          cellRects.find(
            (cr) =>
              cr.region.style.backgroundColor &&
              Math.min(cr.x + cr.width, spanX2) - Math.max(cr.x, x1) >= (spanX2 - x1) * 0.5 &&
              Math.min(cr.y + cr.height, spanY2) - Math.max(cr.y, y1) >= (spanY2 - y1) * 0.5
          )?.region.style.backgroundColor;

        if (vSpan > 1) {
          const info: VMergeSpanInfo = {
            topRow: rIdx,
            bottomRow: rIdx + vSpan - 1,
            colSpan,
            bgColor,
          };
          for (let rr = rIdx + 1; rr < rIdx + vSpan; rr++) {
            vMergeChildMap.set(`${rr}:${cIdx}`, info);
          }
        }

        // Group same-baseline spans inside the cell
        const lineGroups: BodyItemBox[][] = [];
        for (const ct of cellTexts) {
          const last = lineGroups[lineGroups.length - 1];
          if (last && Math.abs(ct.y - last[0].y) <= 0.04) {
            last.push(ct);
          } else {
            lineGroups.push([ct]);
          }
        }
        for (const lg of lineGroups) lg.sort((a, b) => a.x - b.x);

        const lineStrings = lineGroups.map((lg) => lg.map((it) => it.region.text?.trim() ?? '').filter(Boolean).join(' '));
        const cellText = lineStrings.join('\n');
        const firstStyle = cellTexts[0]?.region.style ?? defaultTextStyle(8);

        // Alignment check: Center if within 4pt of horizontal cell center, Right if right-flush, else Left
        let align: 'Left' | 'Center' | 'Right' = 'Left';
        if (lineGroups.length > 0) {
          const lLeft = Math.min(...lineGroups[0].map((t) => t.x));
          const lRight = Math.max(...lineGroups[0].map((t) => t.x + t.width));
          const padL = lLeft - x1;
          const padR = spanX2 - lRight;
          if (Math.abs(padL - padR) <= 4 / PT_PER_INCH && padL >= 0.02 && padR >= 0.02) {
            align = 'Center';
          } else if (padR <= 6 / PT_PER_INCH && padL >= 12 / PT_PER_INCH && firstStyle.textAlign === 'Right') {
            align = 'Right';
          }
        }

        const mergedRuns: VisualTextRun[] = [];
        lineGroups.forEach((lg, lIdx) => {
          if (lIdx > 0) {
            mergedRuns.push({
              text: '\n',
              fontFamily: firstStyle.fontFamily,
              fontSizePt: firstStyle.fontSizePt,
              bold: firstStyle.bold,
              italic: firstStyle.italic,
              color: firstStyle.color,
            });
          }
          lg.forEach((span, sIdx) => {
            const runs = span.region.runs?.length
              ? span.region.runs.map((r) => ({ ...r, parameterName: undefined }))
              : [
                  {
                    text: span.region.text ?? '',
                    fontFamily: span.region.style.fontFamily,
                    fontSizePt: span.region.style.fontSizePt,
                    bold: span.region.style.bold,
                    italic: span.region.style.italic,
                    underline: span.region.style.underline,
                    color: span.region.style.color,
                  },
                ];
            if (sIdx > 0 && mergedRuns.length > 0 && !mergedRuns[mergedRuns.length - 1].text.endsWith(' ')) {
              mergedRuns[mergedRuns.length - 1].text += ' ';
            }
            for (const rn of runs) mergedRuns.push({ ...rn });
          });
        });

        const cellWIn = spanX2 - x1;
        const estH = this.estimateCellHeightIn(
          cellText,
          cellWIn,
          firstStyle.fontSizePt,
          3,
          3,
          firstStyle.bold
        );
        if (vSpan === 1) {
          rowMaxEstH = Math.max(rowMaxEstH, estH);
        }

        cells.push({
          colIndex: cIdx,
          rowIndex: actualRowIdx,
          colSpan,
          rowSpan: 1, // NEVER > 1 in RDLC 2008
          skipBecauseMerged: false,
          content: {
            kind: 'Textbox',
            name: nextUniqueName('CellTxt'),
            value: cellText,
            runs: mergedRuns.length > 0 ? mergedRuns : undefined,
            isExpression: false,
            style: {
              ...firstStyle,
              backgroundColor: bgColor,
              borderColor: gridBorderColor,
              borderWidthPt: 0.5,
              borderEdges:
                vSpan > 1
                  ? { top: 'Solid', bottom: 'None', left: 'Solid', right: 'Solid' }
                  : undefined,
              textAlign: align,
              verticalAlign: 'Middle',
              paddingPt: { top: 3, right: 2, bottom: 3, left: 2 },
            },
            canGrow: true,
          },
        });
      }

      rows.push({
        heightIn: roundIn(rowMaxEstH),
        isDetailRow: false,
        pageBreakBefore: actualRowIdx === 0 && pageBreakBefore ? true : undefined,
        cells,
      });
    }

    const totalW = roundIn(columnWidthsIn.reduce((s, w) => s + w, 0));
    const totalH = roundIn(rows.reduce((s, r) => s + r.heightIn, 0));

    // Ensure tblLeftIn starts cleanly relative to printable origin (at colEdges[0] unless colEdges[0] == gridLeft)
    void gridLeft;
    return {
      id: tablixName,
      name: tablixName,
      pageNumber,
      bandKind: 'Detail',
      pageBreakBefore,
      topIn: roundIn(topIn),
      leftIn: tblLeftIn,
      widthIn: totalW,
      heightIn: totalH,
      dataSetName,
      isRepeatingDetail: false,
      columnWidthsIn,
      rows,
      zIndex: 1,
    };
  }

  private detectEmbeddedSubTables(
    items: BodyItemBox[],
    bannerRects: BodyItemBox[],
    outerBoxRects: BodyItemBox[],
    textItems: BodyItemBox[],
    segWidthIn: number
  ): Array<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    cols: Array<{ x0: number; x1: number }>;
    borderColor: string;
    rects: BodyItemBox[];
    hLines: BodyItemBox[];
    vLines: BodyItemBox[];
    headerEndY: number;
  }> {
    const excluded = new Set<BodyItemBox>([...bannerRects, ...outerBoxRects]);
    const localRects = items.filter(
      (it) =>
        it.kind === 'rect' &&
        !excluded.has(it) &&
        it.width >= 0.16 &&
        it.width < segWidthIn * 0.92 &&
        it.height >= 0.10 &&
        it.height <= 1.8 &&
        Boolean(it.region.style.backgroundColor || it.region.style.borderColor) &&
        !(it.region.style.backgroundColor?.toUpperCase() === '#FFFFFF' && !it.region.style.borderColor)
    );
    const allSegMinX = items.length > 0 ? Math.min(...items.map((it) => it.x)) : 0;
    const allSegMaxX = items.length > 0 ? Math.max(...items.map((it) => it.x + it.width)) : segWidthIn;
    const allSegH = items.length > 0 ? Math.max(...items.map((it) => it.y + it.height)) - Math.min(...items.map((it) => it.y)) : 1;
    const localVLines = items.filter(
      (it) =>
        it.kind === 'line' &&
        it.height > it.width * 1.5 &&
        it.height >= 0.14 &&
        !(
          it.height >= Math.max(1.2, allSegH * 0.72) &&
          (Math.abs(it.x - allSegMinX) <= 0.10 || Math.abs(it.x - allSegMaxX) <= 0.10)
        )
    );
    const localHLines = items.filter(
      (it) =>
        it.kind === 'line' &&
        it.width > it.height * 1.5 &&
        it.width >= 0.25 &&
        it.width < segWidthIn * 0.85
    );

    const primitives: Array<{
      item: BodyItemBox;
      kind: 'rect' | 'v' | 'h';
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }> = [
      ...localRects.map((r) => ({ item: r, kind: 'rect' as const, x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height })),
      ...localVLines.map((l) => ({ item: l, kind: 'v' as const, x0: l.x, y0: l.y, x1: l.x + l.width, y1: l.y + l.height })),
      ...localHLines.map((l) => ({ item: l, kind: 'h' as const, x0: l.x, y0: l.y, x1: l.x + l.width, y1: l.y + l.height })),
    ];

    if (primitives.length === 0) return [];

    // Connected components by spatial proximity
    const visited = new Array(primitives.length).fill(false);
    const components: Array<typeof primitives> = [];
    const padX = 0.05;
    const padY = 0.08;

    for (let i = 0; i < primitives.length; i++) {
      if (visited[i]) continue;
      visited[i] = true;
      const queue = [primitives[i]];
      const comp: typeof primitives = [primitives[i]];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (let j = 0; j < primitives.length; j++) {
          if (visited[j]) continue;
          const p = primitives[j];
          const overlapsX = p.x0 <= cur.x1 + padX && p.x1 >= cur.x0 - padX;
          const overlapsY = p.y0 <= cur.y1 + padY && p.y1 >= cur.y0 - padY;
          if (overlapsX && overlapsY) {
            visited[j] = true;
            queue.push(p);
            comp.push(p);
          }
        }
      }
      components.push(comp);
    }

    const subTables: Array<{
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      cols: Array<{ x0: number; x1: number }>;
      borderColor: string;
      rects: BodyItemBox[];
      hLines: BodyItemBox[];
      vLines: BodyItemBox[];
      headerEndY: number;
    }> = [];

    for (const comp of components) {
      const rects = comp.filter((c) => c.kind === 'rect').map((c) => c.item);
      const hLines = comp.filter((c) => c.kind === 'h').map((c) => c.item);
      const vLines = comp.filter((c) => c.kind === 'v').map((c) => c.item);

      const x0 = roundIn(Math.min(...comp.map((c) => c.x0)));
      const y0 = roundIn(Math.min(...comp.map((c) => c.y0)));
      const x1 = roundIn(Math.max(...comp.map((c) => c.x1)));
      const y1 = roundIn(Math.max(...comp.map((c) => c.y1)));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 0.65 || h < 0.22) continue;

      const hasTableVectorCue =
        vLines.length >= 1 ||
        rects.length >= 2 ||
        (rects.length >= 1 && hLines.length >= 1) ||
        hLines.length >= 2;
      if (!hasTableVectorCue) continue;

      const subTexts = textItems
        .filter((t) => {
          const cx = t.x + t.width / 2;
          const cy = t.y + t.height / 2;
          return cx >= x0 - 0.04 && cx <= x1 + 0.04 && cy >= y0 - 0.04 && cy <= y1 + 0.06;
        })
        .sort((a, b) => a.y - b.y || a.x - b.x);
      if (subTexts.length < 4) continue;

      // Group subTexts into baseline lines
      const lines: BodyItemBox[][] = [];
      for (const st of subTexts) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(st.y - last[0].y) <= 2.5 / PT_PER_INCH) {
          last.push(st);
        } else {
          lines.push([st]);
        }
      }
      for (const ln of lines) ln.sort((a, b) => a.x - b.x);
      if (lines.length < 2) continue;
      const multiSpanLines = lines.filter((ln) => ln.length >= 2);
      if (multiSpanLines.length === 0) continue;

      // Determine header zone end Y (first shaded header rect or first horizontal divider below bold header lines)
      const shadedTopRect = rects
        .filter((r) => r.region.style.backgroundColor && hexLuminance(r.region.style.backgroundColor) < 0.96 && r.y <= y0 + 0.25)
        .sort((a, b) => a.y + a.height - (b.y + b.height))[0];
      let headerEndY = shadedTopRect ? shadedTopRect.y + shadedTopRect.height : 0;
      if (headerEndY <= y0 + 0.04) {
        const boldLines = lines.filter((ln) => ln[0].y <= y0 + 0.55 && ln.every((it) => it.region.style.bold));
        if (boldLines.length > 0) {
          const lastBoldBottom = Math.max(...boldLines[boldLines.length - 1].map((it) => it.y + it.height));
          const sepAfterBold = hLines.find((hl) => hl.y >= lastBoldBottom - 0.03 && hl.y <= lastBoldBottom + 0.14);
          headerEndY = sepAfterBold ? sepAfterBold.y : lastBoldBottom + 0.04;
        } else {
          headerEndY = Math.max(...lines[0].map((it) => it.y + it.height)) + 0.04;
        }
      }

      // 1. Derive column edges strictly from vertical vector X boundaries (VLines + multi-column rects)
      const rawVecXs: number[] = [x0, x1];
      for (const vl of vLines) rawVecXs.push(vl.x);
      for (const rc of rects) rawVecXs.push(rc.x, rc.x + rc.width);
      const vecColEdges = clusterValues(rawVecXs, 3 / PT_PER_INCH).filter(
        (v, idx, arr) => idx === 0 || v - arr[idx - 1] >= 0.14
      );

      // 2. Inside un-divided vector intervals [a, b] ONLY, check bold header column labels (>= 8pt apart) for leaf sub-headers
      const headerLines = lines.filter((ln) => ln[0].y + ln[0].height / 2 <= headerEndY + 0.02);
      const dataLines = lines.filter((ln) => ln[0].y + ln[0].height / 2 > headerEndY + 0.02);
      const finalEdges: number[] = [vecColEdges[0]];

      for (let eIdx = 0; eIdx < vecColEdges.length - 1; eIdx++) {
        const a = vecColEdges[eIdx];
        const b = vecColEdges[eIdx + 1];

        const hasInteriorVLine = vLines.some((vl) => vl.x > a + 0.08 && vl.x < b - 0.08);
        let bestSplitCenters: Array<{ x0: number; x1: number }> = [];
        if (!hasInteriorVLine) {
          const candidatesForSplit = headerLines.length > 0 ? headerLines : multiSpanLines.slice(0, 1);
          for (const hLn of candidatesForSplit) {
            const inInterval = hLn.filter((t) => t.x >= a - 0.04 && t.x + t.width <= b + 0.04);
            if (inInterval.length >= 2 && inInterval.every((t) => t.region.style.bold || shadedTopRect)) {
              const grouped: Array<{ x0: number; x1: number }> = [];
              for (const sp of inInterval) {
                const last = grouped[grouped.length - 1];
                if (last && sp.x - last.x1 < 8 / PT_PER_INCH) {
                  last.x1 = Math.max(last.x1, sp.x + sp.width);
                } else {
                  grouped.push({ x0: sp.x, x1: sp.x + sp.width });
                }
              }
              if (grouped.length > bestSplitCenters.length) {
                bestSplitCenters = grouped;
              }
            }
          }
        }

        if (bestSplitCenters.length >= 2) {
          const splitPoints: number[] = [];
          for (let k = 0; k < bestSplitCenters.length - 1; k++) {
            const mid = roundIn((bestSplitCenters[k].x1 + bestSplitCenters[k + 1].x0) / 2);
            const straddledByData = dataLines.some((dLn) =>
              dLn.some((dt) => dt.x < mid - 0.04 && dt.x + dt.width > mid + 0.04)
            );
            if (!straddledByData && mid - a >= 0.14 && b - mid >= 0.14) {
              splitPoints.push(mid);
            }
          }
          for (const sp of splitPoints) {
            if (sp - finalEdges[finalEdges.length - 1] >= 0.14 && b - sp >= 0.14) {
              finalEdges.push(sp);
            }
          }
        }
        if (b - finalEdges[finalEdges.length - 1] >= 0.14) {
          finalEdges.push(b);
        }
      }

      if (finalEdges.length < 3) continue; // Need >= 2 columns

      const cols = Array.from({ length: finalEdges.length - 1 }, (_, c) => ({
        x0: roundIn(finalEdges[c]),
        x1: roundIn(finalEdges[c + 1]),
      }));

      const rawBorder =
        hLines[0]?.region.style.borderColor ??
        vLines[0]?.region.style.borderColor ??
        rects.find((r) => r.region.style.borderColor)?.region.style.borderColor ??
        '#D0D7DE';
      const borderColor = rawBorder && rawBorder.toUpperCase() !== '#FFFFFF' ? rawBorder : '#D0D7DE';

      // Expand y1 slightly to encompass trailing baseline if subTable bottom border is implicit
      const maxTextBot = Math.max(...subTexts.map((t) => t.y + t.height));
      subTables.push({
        x0,
        y0,
        x1,
        y1: roundIn(Math.max(y1, maxTextBot + 0.02)),
        cols,
        borderColor,
        rects,
        hLines,
        vLines,
        headerEndY: roundIn(headerEndY),
      });
    }

    return subTables;
  }

  private buildModeBNarrativeOrKeyValueTablix(
    tablixName: string,
    seg: AtomicSegment,
    pageNumber: number,
    topIn: number,
    dataSetName: string,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    pageBreakBefore: boolean
  ): TablixRegion {
    const { items, leftIn: segLeftIn, widthIn: segWidthIn } = seg;

    const bannerRects = items
      .filter((it) => this.isBannerRect(it, items, segWidthIn * 0.5))
      .sort((a, b) => a.y - b.y);
    const outerBoxRects = items.filter(
      (it) => it.kind === 'rect' && !bannerRects.includes(it) && it.width >= segWidthIn * 0.65 && it.height >= 0.4 && Boolean(it.region.style.borderColor)
    );
    const shadedBandRects = items.filter(
      (it) =>
        it.kind === 'rect' &&
        !bannerRects.includes(it) &&
        !outerBoxRects.includes(it) &&
        it.width >= segWidthIn * 0.45 &&
        it.height >= 0.12 &&
        Boolean(it.region.style.backgroundColor) &&
        hexLuminance(it.region.style.backgroundColor) < 0.99
    );

    const textItems = items
      .filter((it) => it.kind === 'text' && it.region.text?.trim())
      .sort((a, b) => (Math.abs(a.y - b.y) <= 2 / PT_PER_INCH ? a.x - b.x : a.y - b.y));

    const imageItems = items.filter((it) => it.kind === 'image' && it.region.imageAssetBase64);
    const hDividerLines = items.filter((it) => it.kind === 'line' && it.width > it.height * 2 && it.width >= segWidthIn * 0.65);

    const bannerTextSet = new Set<BodyItemBox>();
    const bannerRows: Array<{ y0: number; y1: number; block: ParagraphCellBlock }> = [];
    for (const br of bannerRects) {
      const bTexts = textItems.filter(
        (t) => t.y + t.height / 2 >= br.y - 0.02 && t.y + t.height / 2 <= br.y + br.height + 0.02
      );
      bTexts.forEach((t) => bannerTextSet.add(t));
      const joined = bTexts.map((t) => t.region.text?.trim() ?? '').filter(Boolean).join(' ');
      const st = bTexts[0]?.region.style ?? defaultTextStyle(9);
      bannerRows.push({
        y0: br.y,
        y1: br.y + br.height,
        block: {
          x0: segLeftIn,
          x1: segLeftIn + segWidthIn,
          y0: br.y,
          y1: br.y + br.height,
          text: joined,
          runs: [
            {
              text: joined,
              fontFamily: st.fontFamily,
              fontSizePt: st.fontSizePt,
              bold: true,
              italic: st.italic,
              color: st.color,
            },
          ],
          fontSizePt: st.fontSizePt,
          bold: true,
          italic: st.italic,
          color: st.color,
          textAlign: 'Center',
          verticalAlign: 'Middle',
          backgroundColor: br.region.style.backgroundColor,
          isBanner: true,
          canGrow: true,
          lineCount: 1,
        },
      });
    }

    const bodyTextItems = textItems.filter((t) => !bannerTextSet.has(t));

    // Detect localized embedded sub-tables BEFORE paragraph clustering so centered cell values NEVER spawn extra columns
    const embeddedSubTables = this.detectEmbeddedSubTables(
      items,
      bannerRects,
      outerBoxRects,
      bodyTextItems,
      segWidthIn
    );

    const paragraphBlocks: ParagraphCellBlock[] = [];
    const consumedTexts = new Set<BodyItemBox>();

    // Build cell blocks for each embedded sub-table cleanly from its column intervals
    for (const st of embeddedSubTables) {
      const stTexts = bodyTextItems.filter((t) => {
        if (consumedTexts.has(t)) return false;
        const cx = t.x + t.width / 2;
        const cy = t.y + t.height / 2;
        return cx >= st.x0 - 0.04 && cx <= st.x1 + 0.04 && cy >= st.y0 - 0.04 && cy <= st.y1 + 0.04;
      });
      if (stTexts.length === 0) continue;

      const mapTextToSubColRange = (t: BodyItemBox): { cStart: number; cEnd: number } => {
        const overlapping: number[] = [];
        for (let c = 0; c < st.cols.length; c++) {
          const col = st.cols[c];
          const ov = Math.min(t.x + t.width, col.x1) - Math.max(t.x, col.x0);
          if (ov > Math.min(t.width * 0.25, (col.x1 - col.x0) * 0.25) || (t.x + t.width / 2 >= col.x0 - 0.02 && t.x + t.width / 2 <= col.x1 + 0.02)) {
            overlapping.push(c);
          }
        }
        if (overlapping.length === 0) {
          let best = 0;
          let bestDist = Infinity;
          const tcx = t.x + t.width / 2;
          for (let c = 0; c < st.cols.length; c++) {
            const ccx = (st.cols[c].x0 + st.cols[c].x1) / 2;
            const d = Math.abs(ccx - tcx);
            if (d < bestDist) {
              bestDist = d;
              best = c;
            }
          }
          return { cStart: best, cEnd: best };
        }
        return { cStart: overlapping[0], cEnd: overlapping[overlapping.length - 1] };
      };

      // Separate header band items from data rows
      const hdrItems = stTexts.filter((t) => t.y + t.height / 2 <= st.headerEndY + 0.02);
      const dataItems = stTexts.filter((t) => t.y + t.height / 2 > st.headerEndY + 0.02);

      const emitSubCellBlock = (
        spans: BodyItemBox[],
        cStart: number,
        cEnd: number,
        isHeaderRow: boolean,
        isBottomSubRow: boolean
      ) => {
        spans.sort((a, b) => (Math.abs(a.y - b.y) <= 2 / PT_PER_INCH ? a.x - b.x : a.y - b.y));
        const colX0 = st.cols[cStart].x0;
        const colX1 = st.cols[cEnd].x1;
        const origX0 = Math.min(...spans.map((s) => s.x));
        const origX1 = Math.max(...spans.map((s) => s.x + s.width));
        const y0 = Math.min(...spans.map((s) => s.y));
        const y1 = Math.max(...spans.map((s) => s.y + s.height));

        // Group same-baseline spans inside this cell
        const cellLines: BodyItemBox[][] = [];
        for (const sp of spans) {
          const last = cellLines[cellLines.length - 1];
          if (last && Math.abs(sp.y - last[0].y) <= 2.5 / PT_PER_INCH) {
            last.push(sp);
          } else {
            cellLines.push([sp]);
          }
        }
        for (const cl of cellLines) cl.sort((a, b) => a.x - b.x);

        const firstStyle = spans[0].region.style;
        const mergedRuns: VisualTextRun[] = [];
        cellLines.forEach((cl, lIdx) => {
          if (lIdx > 0) {
            mergedRuns.push({
              text: '\n',
              fontFamily: firstStyle.fontFamily,
              fontSizePt: firstStyle.fontSizePt,
              bold: firstStyle.bold,
              italic: firstStyle.italic,
              color: firstStyle.color,
            });
          }
          cl.forEach((sp, sIdx) => {
            if (sIdx > 0 && mergedRuns.length > 0 && !mergedRuns[mergedRuns.length - 1].text.endsWith(' ')) {
              mergedRuns[mergedRuns.length - 1].text += ' ';
            }
            const rns = sp.region.runs?.length
              ? sp.region.runs.map((r) => ({ ...r, parameterName: undefined }))
              : [
                  {
                    text: sp.region.text ?? '',
                    fontFamily: sp.region.style.fontFamily,
                    fontSizePt: sp.region.style.fontSizePt,
                    bold: sp.region.style.bold,
                    italic: sp.region.style.italic,
                    underline: sp.region.style.underline,
                    color: sp.region.style.color,
                  },
                ];
            for (const rn of rns) mergedRuns.push({ ...rn });
          });
        });

        const padL = origX0 - colX0;
        const padR = colX1 - origX1;
        let textAlign: 'Left' | 'Center' | 'Right' = 'Left';
        if (cEnd > cStart || isHeaderRow || (Math.abs(padL - padR) <= 5 / PT_PER_INCH && padL >= 0.012 && padR >= 0.012)) {
          textAlign = 'Center';
        } else if (padR <= 6 / PT_PER_INCH && padL >= 10 / PT_PER_INCH) {
          textAlign = 'Right';
        } else if (padL > 6 / PT_PER_INCH && padR > 6 / PT_PER_INCH) {
          textAlign = 'Center';
        }

        const midY = (y0 + y1) / 2;
        const midX = (colX0 + colX1) / 2;
        const bgRect = st.rects.find(
          (rc) =>
            rc.region.style.backgroundColor &&
            rc.region.style.backgroundColor.toUpperCase() !== '#FFFFFF' &&
            midX >= rc.x - 0.02 &&
            midX <= rc.x + rc.width + 0.02 &&
            midY >= rc.y - 0.02 &&
            midY <= rc.y + rc.height + 0.02
        );

        paragraphBlocks.push({
          x0: colX0,
          x1: colX1,
          y0,
          y1,
          text: mergedRuns.map((r) => r.text).join(''),
          runs: mergedRuns,
          fontSizePt: firstStyle.fontSizePt,
          bold: firstStyle.bold,
          italic: firstStyle.italic,
          color: firstStyle.color,
          textAlign,
          verticalAlign: 'Middle',
          backgroundColor: bgRect?.region.style.backgroundColor,
          borderColor: st.borderColor,
          borderEdges: {
            top: 'Solid',
            bottom: isBottomSubRow ? 'Solid' : 'Solid',
            left: 'Solid',
            right: 'Solid',
          },
          subTableColEndX: colX1,
          canGrow: true,
          lineCount: cellLines.length,
        });
        spans.forEach((s) => consumedTexts.add(s));
      };

      // Check if header has a 2-tier spanned group header (e.g. a top header item covering >= 2 subCols)
      const hdrSpannedTop = hdrItems.filter((t) => {
        const rng = mapTextToSubColRange(t);
        return rng.cEnd > rng.cStart;
      });
      if (hdrSpannedTop.length > 0 && hdrItems.length > hdrSpannedTop.length) {
        const hdrLines: BodyItemBox[][] = [];
        for (const ht of hdrItems) {
          const last = hdrLines[hdrLines.length - 1];
          if (last && Math.abs(ht.y - last[0].y) <= 2.5 / PT_PER_INCH) {
            last.push(ht);
          } else {
            hdrLines.push([ht]);
          }
        }
        // Check if bottom header line has leaf headers (e.g. Rupiah | USD)
        const spannedColsSet = new Set<number>();
        for (const sTop of hdrSpannedTop) {
          const rng = mapTextToSubColRange(sTop);
          for (let c = rng.cStart; c <= rng.cEnd; c++) spannedColsSet.add(c);
          emitSubCellBlock([sTop], rng.cStart, rng.cEnd, true, false);
        }
        // Single-col items on header lines: group multi-line left header columns into Row 0, and leaf subheaders into Row 1
        const leafColGroups = new Map<number, BodyItemBox[]>();
        const upperColGroups = new Map<number, BodyItemBox[]>();
        const topSpanBaselineY = Math.min(...hdrSpannedTop.map((t) => t.y));
        for (const ht of hdrItems) {
          if (consumedTexts.has(ht)) continue;
          const rng = mapTextToSubColRange(ht);
          if (spannedColsSet.has(rng.cStart) && ht.y > topSpanBaselineY + 0.03) {
            const list = leafColGroups.get(rng.cStart) ?? [];
            list.push(ht);
            leafColGroups.set(rng.cStart, list);
          } else {
            const list = upperColGroups.get(rng.cStart) ?? [];
            list.push(ht);
            upperColGroups.set(rng.cStart, list);
          }
        }
        for (const [cIdx, grp] of upperColGroups.entries()) {
          emitSubCellBlock(grp, cIdx, cIdx, true, false);
        }
        for (const [cIdx, grp] of leafColGroups.entries()) {
          emitSubCellBlock(grp, cIdx, cIdx, true, false);
        }
      } else if (hdrItems.length > 0) {
        // Single-tier multi-line header: merge all header lines per subCol
        const byCol = new Map<number, BodyItemBox[]>();
        for (const ht of hdrItems) {
          const rng = mapTextToSubColRange(ht);
          const list = byCol.get(rng.cStart) ?? [];
          list.push(ht);
          byCol.set(rng.cStart, list);
        }
        for (const [cIdx, grp] of byCol.entries()) {
          emitSubCellBlock(grp, cIdx, cIdx, true, dataItems.length === 0);
        }
      }

      // Data rows inside sub-table: derive row Y-intervals strictly from HLine + FillBand dividers when available
      const dataYsRaw: number[] = [st.headerEndY, st.y1];
      for (const hl of st.hLines) {
        if (hl.y > st.headerEndY + 0.02 && hl.y < st.y1 + 0.04) dataYsRaw.push(hl.y);
      }
      for (const rc of st.rects) {
        if (rc.y + rc.height > st.headerEndY + 0.02) {
          if (rc.y > st.headerEndY - 0.02) dataYsRaw.push(rc.y);
          dataYsRaw.push(rc.y + rc.height);
        }
      }
      const dataRowBoundaries = clusterValues(dataYsRaw, 3 / PT_PER_INCH).filter(
        (v, idx, arr) => idx === 0 || v - arr[idx - 1] >= 0.09
      );

      let dataRowsGrouped: BodyItemBox[][] = [];
      if (dataRowBoundaries.length >= 3) {
        for (let r = 0; r < dataRowBoundaries.length - 1; r++) {
          const ry0 = dataRowBoundaries[r];
          const ry1 = dataRowBoundaries[r + 1];
          const bandItems = dataItems.filter(
            (dt) => dt.y + dt.height / 2 >= ry0 - 0.02 && dt.y + dt.height / 2 < ry1 + 0.02
          );
          if (bandItems.length === 0) continue;
          // If an unshaded band is tall and contains multiple multi-column rows separated cleanly, split by baseline
          if (ry1 - ry0 >= 0.35) {
            const subLines: BodyItemBox[][] = [];
            for (const bt of bandItems) {
              const last = subLines[subLines.length - 1];
              if (last && Math.abs(bt.y - last[0].y) <= 3 / PT_PER_INCH) {
                last.push(bt);
              } else {
                subLines.push([bt]);
              }
            }
            const multiColCount = subLines.filter((sl) => sl.length >= 2).length;
            if (subLines.length >= 2 && multiColCount >= subLines.length * 0.75) {
              dataRowsGrouped.push(...subLines);
              continue;
            }
          }
          dataRowsGrouped.push(bandItems);
        }
      } else {
        for (const dt of dataItems) {
          const last = dataRowsGrouped[dataRowsGrouped.length - 1];
          if (last && Math.abs(dt.y - last[0].y) <= 3 / PT_PER_INCH) {
            last.push(dt);
          } else {
            dataRowsGrouped.push([dt]);
          }
        }
      }

      dataRowsGrouped.forEach((dRow, dIdx) => {
        const byCol = new Map<number, BodyItemBox[]>();
        for (const dt of dRow) {
          const rng = mapTextToSubColRange(dt);
          const list = byCol.get(rng.cStart) ?? [];
          list.push(dt);
          byCol.set(rng.cStart, list);
        }
        for (const [cIdx, grp] of byCol.entries()) {
          emitSubCellBlock(grp, cIdx, cIdx, false, dIdx === dataRowsGrouped.length - 1);
        }
      });
    }

    // Paragraph-First Reconstruction (1 Paragraph = 1 Row, CanGrow=true) for remaining bodyTextItems
    const remainingBodyItems = bodyTextItems.filter((t) => !consumedTexts.has(t));
    const baselineGroups: BodyItemBox[][] = [];
    for (const t of remainingBodyItems) {
      const last = baselineGroups[baselineGroups.length - 1];
      if (last && Math.abs(t.y - last[0].y) <= 2 / PT_PER_INCH) {
        last.push(t);
      } else {
        baselineGroups.push([t]);
      }
    }
    const baselineByItem = new Map<BodyItemBox, BodyItemBox[]>();
    const hasSiblingOnBaseline = new Set<BodyItemBox>();
    for (const bg of baselineGroups) {
      bg.forEach((item) => baselineByItem.set(item, bg));
      if (bg.length >= 2) {
        const sortedLine = [...bg].sort((a, b) => a.x - b.x);
        const firstTxt = sortedLine[0].region.text?.trim() ?? '';
        const isLeadingMarkerPlusBody = sortedLine.length === 2 && LIST_MARKER_PREFIX_RE.test(firstTxt);
        if (isLeadingMarkerPlusBody) {
          hasSiblingOnBaseline.add(sortedLine[0]);
        } else {
          bg.forEach((item) => hasSiblingOnBaseline.add(item));
        }
      }
    }

    const isContinuationBaseline = (prevItem: BodyItemBox, candItem: BodyItemBox): boolean => {
      const candLine = baselineByItem.get(candItem) ?? [candItem];
      if (candLine.length <= 1) return true;
      // Never merge if the candidate's baseline contains a ':' separator or a leading list marker
      if (
        candLine.some((it) => {
          const tx = it.region.text?.trim() ?? '';
          return tx === ':' || startsWithListMarker(tx);
        })
      ) {
        return false;
      }
      // Every item on candidate's baseline must align within 5pt of a sibling on prevItem's baseline
      const prevLine = baselineByItem.get(prevItem) ?? [prevItem];
      return candLine.every((ci) => prevLine.some((pi) => Math.abs(ci.x - pi.x) <= 5 / PT_PER_INCH));
    };

    for (let i = 0; i < remainingBodyItems.length; i++) {
      const anchor = remainingBodyItems[i];
      if (consumedTexts.has(anchor)) continue;
      consumedTexts.add(anchor);

      const chain: BodyItemBox[] = [anchor];
      const aStyle = anchor.region.style;
      const aTxt = anchor.region.text?.trim() ?? '';
      const anchorIsKeyOrSep =
        aTxt === ':' || LIST_MARKER_PREFIX_RE.test(aTxt);

      if (!anchorIsKeyOrSep) {
        for (let j = i + 1; j < remainingBodyItems.length; j++) {
          const cand = remainingBodyItems[j];
          if (consumedTexts.has(cand)) continue;
          const prev = chain[chain.length - 1];

          const dy = cand.y - prev.y;
          const maxLeading = (aStyle.fontSizePt * 1.65) / PT_PER_INCH;
          if (dy > maxLeading + 0.02) break;
          if (dy < 0.03) continue; // Same baseline sibling

          if (Math.abs(cand.x - anchor.x) > 4 / PT_PER_INCH) continue;
          if (cand.region.style.bold !== aStyle.bold) break;
          if (Math.abs(cand.region.style.fontSizePt - aStyle.fontSizePt) > 0.6) continue;
          if (startsWithListMarker(cand.region.text ?? '')) break;
          if (cand.region.text?.trim() === ':') break;
          if (hasSiblingOnBaseline.has(cand) && !isContinuationBaseline(prev, cand)) break;

          // Stop if an H-line or shaded border crosses between prev and cand within this column's X span
          const colMinX = Math.min(anchor.x, cand.x);
          const colMaxX = Math.max(anchor.x + anchor.width, cand.x + cand.width);
          const crossedByDivider = hDividerLines.some(
            (hl) =>
              hl.y > prev.y + prev.height * 0.5 &&
              hl.y < cand.y + cand.height * 0.5 &&
              hl.x < colMaxX + 0.05 &&
              hl.x + hl.width > colMinX - 0.05
          );
          if (crossedByDivider) break;

          // Only break for intervening items that actually overlap this column horizontally
          const hasIntervening = remainingBodyItems.some(
            (other) =>
              !consumedTexts.has(other) &&
              other !== cand &&
              other.y > prev.y + 0.02 &&
              other.y < cand.y - 0.01 &&
              other.x < colMaxX + 0.05 &&
              other.x + other.width > colMinX - 0.05
          );
          if (hasIntervening) break;

          chain.push(cand);
          consumedTexts.add(cand);
        }
      }

      const mergedRuns: VisualTextRun[] = [];
      chain.forEach((ln, lIdx) => {
        const lineRuns =
          ln.region.runs && ln.region.runs.length > 0
            ? ln.region.runs.map((r) => ({ ...r, parameterName: undefined }))
            : [
                {
                  text: ln.region.text ?? '',
                  fontFamily: ln.region.style.fontFamily,
                  fontSizePt: ln.region.style.fontSizePt,
                  bold: ln.region.style.bold,
                  italic: ln.region.style.italic,
                  underline: ln.region.style.underline,
                  color: ln.region.style.color,
                },
              ];
        if (lIdx > 0 && mergedRuns.length > 0 && !mergedRuns[mergedRuns.length - 1].text.endsWith(' ')) {
          mergedRuns[mergedRuns.length - 1].text += ' ';
        }
        for (const r of lineRuns) mergedRuns.push({ ...r });
      });

      const mergedText = mergedRuns.map((r) => r.text).join('');
      const x0 = Math.min(...chain.map((c) => c.x));
      const x1 = Math.max(...chain.map((c) => c.x + c.width));
      const y0 = chain[0].y;
      const y1 = Math.max(...chain.map((c) => c.y + c.height));
      const shade = shadedBandRects.find(
        (sr) => y0 + (y1 - y0) / 2 >= sr.y - 0.01 && y0 + (y1 - y0) / 2 <= sr.y + sr.height + 0.01
      );

      paragraphBlocks.push({
        x0,
        x1,
        y0,
        y1,
        text: mergedText,
        runs: mergedRuns,
        fontSizePt: aStyle.fontSizePt,
        bold: aStyle.bold,
        italic: aStyle.italic,
        color: aStyle.color,
        textAlign: aStyle.textAlign === 'Right' ? 'Right' : 'Left',
        verticalAlign: 'Top',
        backgroundColor: shade?.region.style.backgroundColor,
        canGrow: true,
        lineCount: chain.length,
      });
    }

    // Fallback geometric guard: if any short block (not in a sub-table) is center-aligned directly under a wider bold header above it, align it to the header's x0/x1
    for (const blk of paragraphBlocks) {
      if (blk.borderColor || blk.subTableColEndX !== undefined) continue;
      const blkCx = (blk.x0 + blk.x1) / 2;
      const matchingHeader = paragraphBlocks.find(
        (hdr) =>
          hdr !== blk &&
          hdr.bold &&
          hdr.y1 < blk.y0 &&
          blk.y0 - hdr.y1 <= 1.2 &&
          hdr.x1 - hdr.x0 > blk.x1 - blk.x0 + 0.04 &&
          blk.x0 >= hdr.x0 - 0.04 &&
          blk.x1 <= hdr.x1 + 0.04 &&
          Math.abs((hdr.x0 + hdr.x1) / 2 - blkCx) <= 5 / PT_PER_INCH
      );
      if (matchingHeader) {
        blk.x0 = matchingHeader.x0;
        blk.x1 = matchingHeader.x1;
        blk.textAlign = 'Center';
      }
    }

    // Group non-banner blocks into visual rows by first-line baseline (<= 3.5pt)
    type VisualRowEntry =
      | { kind: 'Banner'; y0: number; y1: number; block: ParagraphCellBlock }
      | { kind: 'Cells'; y0: number; y1: number; blocks: ParagraphCellBlock[] }
      | { kind: 'Image'; y0: number; y1: number; item: BodyItemBox };

    const rowEntries: VisualRowEntry[] = bannerRows.map((b) => ({ kind: 'Banner', ...b }));
    for (const im of imageItems) {
      rowEntries.push({ kind: 'Image', y0: im.y, y1: im.y + im.height, item: im });
    }

    const sortedBlocks = [...paragraphBlocks].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const visualCellRows: Array<{ y0: number; y1: number; blocks: ParagraphCellBlock[] }> = [];
    for (const pb of sortedBlocks) {
      const last = visualCellRows[visualCellRows.length - 1];
      if (last && Math.abs(pb.y0 - last.y0) <= 3.5 / PT_PER_INCH) {
        last.blocks.push(pb);
        last.y1 = Math.max(last.y1, pb.y1);
      } else {
        visualCellRows.push({ y0: pb.y0, y1: pb.y1, blocks: [pb] });
      }
    }
    for (const vr of visualCellRows) {
      vr.blocks.sort((a, b) => a.x0 - b.x0);
      rowEntries.push({ kind: 'Cells', ...vr });
    }

    rowEntries.sort((a, b) => a.y0 - b.y0);

    // Pure Column Indentation: register every left edge x0 & embedded sub-table column boundaries
    const allLeftXs: number[] = [];
    for (const st of embeddedSubTables) {
      for (const col of st.cols) {
        allLeftXs.push(col.x0);
      }
      allLeftXs.push(st.x1);
    }
    for (const re of rowEntries) {
      if (re.kind === 'Cells') {
        for (const blk of re.blocks) {
          allLeftXs.push(blk.x0);
        }
      }
    }

    const rawColEdges = clusterValues(allLeftXs, 5 / PT_PER_INCH);
    // Guarantee minimum column separation >= 0.08in unless two blocks share the same row
    const colStartXs: number[] = [];
    for (const x of rawColEdges) {
      if (colStartXs.length === 0 || x - colStartXs[colStartXs.length - 1] >= 0.08) {
        colStartXs.push(x);
      }
    }
    // Also ensure every row with multiple sibling blocks has distinct columns for each sibling
    for (const re of rowEntries) {
      if (re.kind !== 'Cells' || re.blocks.length < 2) continue;
      for (const blk of re.blocks) {
        if (!colStartXs.some((cx) => Math.abs(cx - blk.x0) <= 5 / PT_PER_INCH)) {
          colStartXs.push(roundIn(blk.x0));
        }
      }
    }
    colStartXs.sort((a, b) => a - b);

    const trackStart = roundIn(segLeftIn);
    const trackEnd = roundIn(segLeftIn + segWidthIn);
    const fullColEdges: number[] = [trackStart];
    for (const cx of colStartXs) {
      if (cx > trackStart + 0.07 && cx < trackEnd - 0.08) {
        if (cx - fullColEdges[fullColEdges.length - 1] >= 0.07) {
          fullColEdges.push(roundIn(cx));
        }
      }
    }
    fullColEdges.push(trackEnd);
    const numCols = Math.max(1, fullColEdges.length - 1);
    const columnWidthsIn = Array.from({ length: numCols }, (_, c) =>
      Math.max(0.06, roundIn(fullColEdges[c + 1] - fullColEdges[c]))
    );

    const mapLeftEdgeToCol = (x0: number): number => {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let c = 0; c < numCols; c++) {
        const d = Math.abs(fullColEdges[c] - x0);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      return bestIdx;
    };

    const mapRightEdgeToEndCol = (x1: number, minEndCol: number): number => {
      let bestIdx = numCols;
      let bestDist = Infinity;
      for (let c = minEndCol; c <= numCols; c++) {
        const d = Math.abs(fullColEdges[c] - x1);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      return Math.max(minEndCol, bestIdx);
    };

    const hasOuterBox = outerBoxRects.length > 0;
    const outerBorderColor = outerBoxRects[0]?.region.style.borderColor ?? '#D0D7DE';

    const rows: TablixRow[] = [];
    for (let rIdx = 0; rIdx < rowEntries.length; rIdx++) {
      const entry = rowEntries[rIdx];
      const isTopRow = rIdx === 0;
      const isBottomRow = rIdx === rowEntries.length - 1;

      if (entry.kind === 'Banner') {
        const blk = entry.block;
        const bannerEstH = this.estimateCellHeightIn(blk.text, segWidthIn, blk.fontSizePt, 3, 3, true);
        const cells: TablixCell[] = Array.from({ length: numCols }, (_, cIdx) =>
          cIdx === 0
            ? {
                colIndex: 0,
                rowIndex: rows.length,
                colSpan: numCols,
                rowSpan: 1,
                skipBecauseMerged: false,
                content: {
                  kind: 'Textbox',
                  name: nextUniqueName('BannerTxt'),
                  value: blk.text,
                  runs: blk.runs,
                  isExpression: false,
                  style: {
                    ...defaultTextStyle(blk.fontSizePt),
                    bold: true,
                    color: blk.color,
                    backgroundColor: blk.backgroundColor,
                    textAlign: 'Center',
                    verticalAlign: 'Middle',
                    borderColor: hasOuterBox ? outerBorderColor : undefined,
                    borderWidthPt: hasOuterBox ? 0.5 : undefined,
                    borderEdges: hasOuterBox
                      ? {
                          top: isTopRow ? 'Solid' : 'None',
                          bottom: isBottomRow ? 'Solid' : 'None',
                          left: 'Solid',
                          right: 'Solid',
                        }
                      : undefined,
                    paddingPt: { top: 3, right: 3, bottom: 3, left: 3 },
                  },
                  canGrow: true,
                },
              }
            : {
                colIndex: cIdx,
                rowIndex: rows.length,
                colSpan: 1,
                rowSpan: 1,
                skipBecauseMerged: true,
                content: { kind: 'Empty', name: nextUniqueName('Empty') },
              }
        );
        rows.push({
          heightIn: roundIn(Math.max(0.20, entry.y1 - entry.y0, bannerEstH)),
          isDetailRow: false,
          pageBreakBefore: isTopRow && pageBreakBefore ? true : undefined,
          cells,
        });
        continue;
      }

      if (entry.kind === 'Image') {
        const im = entry.item;
        const embName = registerEmbeddedImage(
          im.region.imageAssetBase64!,
          im.region.imageAssetName ?? `BodyImg_P${pageNumber}`
        );
        const cells: TablixCell[] = Array.from({ length: numCols }, (_, cIdx) =>
          cIdx === 0
            ? {
                colIndex: 0,
                rowIndex: rows.length,
                colSpan: numCols,
                rowSpan: 1,
                skipBecauseMerged: false,
                content: {
                  kind: 'Image',
                  name: nextUniqueName('BodyImg'),
                  mimeType: 'image/png',
                  base64Data: embName === im.region.imageAssetBase64 ? im.region.imageAssetBase64! : im.region.imageAssetBase64!,
                  sizing: 'FitProportional',
                },
              }
            : {
                colIndex: cIdx,
                rowIndex: rows.length,
                colSpan: 1,
                rowSpan: 1,
                skipBecauseMerged: true,
                content: { kind: 'Empty', name: nextUniqueName('Empty') },
              }
        );
        rows.push({
          heightIn: roundIn(Math.max(0.18, entry.y1 - entry.y0)),
          isDetailRow: false,
          pageBreakBefore: isTopRow && pageBreakBefore ? true : undefined,
          cells,
        });
        continue;
      }

      // Visual Cells Row: anchor strictly by left edge x0, extend ColSpan to next sibling or subTable boundary or trackLastCol
      const assigned: Array<{ startCol: number; colSpan: number; block: ParagraphCellBlock }> = [];
      let minColAllowed = 0;
      for (let bIdx = 0; bIdx < entry.blocks.length; bIdx++) {
        const blk = entry.blocks[bIdx];
        let sCol = Math.max(minColAllowed, mapLeftEdgeToCol(blk.x0));
        if (sCol >= numCols) sCol = numCols - 1;
        minColAllowed = sCol + 1;
        assigned.push({ startCol: sCol, colSpan: 1, block: blk });
      }
      for (let bIdx = 0; bIdx < assigned.length; bIdx++) {
        const cur = assigned[bIdx];
        const nextStart = bIdx + 1 < assigned.length ? assigned[bIdx + 1].startCol : numCols;
        if (cur.block.subTableColEndX !== undefined) {
          const endCol = mapRightEdgeToEndCol(cur.block.subTableColEndX, cur.startCol + 1);
          cur.colSpan = Math.max(1, Math.min(nextStart, endCol) - cur.startCol);
        } else {
          cur.colSpan = Math.max(1, nextStart - cur.startCol);
        }
      }

      const rowCells: TablixCell[] = [];
      const nextEntry = rIdx + 1 < rowEntries.length ? rowEntries[rIdx + 1] : undefined;
      const gapBelow = nextEntry ? Math.max(0, nextEntry.y0 - entry.y1) : 0;
      const padTopPt = 3;
      const padBottomPt = Math.max(3, gapBelow >= 0.06 ? Math.min(8, Math.round(gapBelow * PT_PER_INCH)) : 3);
      let rowHIn = Math.max(0.18, roundIn(entry.y1 - entry.y0 + (padTopPt + padBottomPt) / PT_PER_INCH));

      let cPtr = 0;
      while (cPtr < numCols) {
        const match = assigned.find((a) => a.startCol === cPtr);
        if (!match) {
          rowCells.push({
            colIndex: cPtr,
            rowIndex: rows.length,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: false,
            content: {
              kind: 'Textbox',
              name: nextUniqueName('Pad'),
              value: '',
              isExpression: false,
              style: {
                ...defaultTextStyle(8),
                borderColor: hasOuterBox ? outerBorderColor : undefined,
                borderWidthPt: hasOuterBox ? 0.5 : undefined,
                borderEdges: hasOuterBox
                  ? {
                      top: isTopRow ? 'Solid' : 'None',
                      bottom: isBottomRow ? 'Solid' : 'None',
                      left: cPtr === 0 ? 'Solid' : 'None',
                      right: cPtr === numCols - 1 ? 'Solid' : 'None',
                    }
                  : undefined,
                paddingPt: { top: padTopPt, right: 0, bottom: padBottomPt, left: 0 },
              },
              canGrow: true,
            },
          });
          cPtr++;
          continue;
        }

        const { startCol, colSpan, block } = match;
        const cellWIn = columnWidthsIn.slice(startCol, startCol + colSpan).reduce((s, w) => s + w, 0);
        const estH = this.estimateCellHeightIn(
          block.text,
          cellWIn,
          block.fontSizePt,
          padTopPt,
          padBottomPt,
          block.bold
        );
        rowHIn = Math.max(rowHIn, estH);

        const coversLeft = startCol === 0;
        const coversRight = startCol + colSpan >= numCols;
        const paraSpec: VisualParagraphSpec = {
          runs: block.runs,
          lineHeightPt: Math.round(block.fontSizePt * 1.45 * 10) / 10,
          textAlign: block.textAlign,
        };

        const effectiveBorderColor = block.borderColor ?? (hasOuterBox ? outerBorderColor : undefined);
        const effectiveBorderEdges = block.borderColor
          ? block.borderEdges ?? { top: 'Solid', bottom: 'Solid', left: 'Solid', right: 'Solid' }
          : hasOuterBox
            ? {
                top: isTopRow ? ('Solid' as const) : ('None' as const),
                bottom: isBottomRow ? ('Solid' as const) : ('None' as const),
                left: coversLeft ? ('Solid' as const) : ('None' as const),
                right: coversRight ? ('Solid' as const) : ('None' as const),
              }
            : undefined;

        rowCells.push({
          colIndex: startCol,
          rowIndex: rows.length,
          colSpan,
          rowSpan: 1,
          skipBecauseMerged: false,
          content: {
            kind: 'Textbox',
            name: nextUniqueName('Txt'),
            value: block.text,
            runs: block.runs,
            paragraphLines: [paraSpec],
            isExpression: false,
            style: {
              ...defaultTextStyle(block.fontSizePt),
              bold: block.bold,
              italic: block.italic,
              color: block.color,
              backgroundColor: block.backgroundColor,
              textAlign: block.textAlign,
              verticalAlign: block.verticalAlign,
              borderColor: effectiveBorderColor,
              borderWidthPt: effectiveBorderColor ? 0.5 : undefined,
              borderEdges: effectiveBorderEdges,
              paddingPt: { top: padTopPt, right: 2, bottom: padBottomPt, left: 2 },
            },
            canGrow: true,
          },
        });

        for (let cc = startCol + 1; cc < startCol + colSpan; cc++) {
          rowCells.push({
            colIndex: cc,
            rowIndex: rows.length,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: true,
            content: { kind: 'Empty', name: nextUniqueName('Empty') },
          });
        }
        cPtr = startCol + colSpan;
      }

      rows.push({
        heightIn: roundIn(rowHIn),
        isDetailRow: false,
        pageBreakBefore: isTopRow && pageBreakBefore ? true : undefined,
        cells: rowCells,
      });
    }

    if (rows.length === 0) {
      return this.buildEmptyPlaceholderTablix(
        tablixName,
        pageNumber,
        topIn,
        segWidthIn,
        dataSetName,
        nextUniqueName,
        pageBreakBefore,
        segLeftIn
      );
    }

    const totalW = roundIn(columnWidthsIn.reduce((s, w) => s + w, 0));
    const totalH = roundIn(rows.reduce((s, r) => s + r.heightIn, 0));

    return {
      id: tablixName,
      name: tablixName,
      pageNumber,
      bandKind: 'Detail',
      pageBreakBefore,
      topIn: roundIn(topIn),
      leftIn: roundIn(segLeftIn),
      widthIn: totalW,
      heightIn: totalH,
      dataSetName,
      isRepeatingDetail: false,
      columnWidthsIn,
      rows,
      zIndex: 1,
    };
  }

  private estimateCellHeightIn(
    text: string,
    colWidthIn: number,
    fontSizePt: number,
    padTopPt: number,
    padBottomPt: number,
    isBold = false
  ): number {
    const innerWPt = Math.max(8, colWidthIn * PT_PER_INCH - 4);
    const charWidthPt = Math.max(3, fontSizePt * (isBold ? 0.62 : 0.57));
    const charsPerLine = Math.max(3, Math.floor(innerWPt / charWidthPt));
    const hardLines = text.split('\n');
    let lineCount = 0;
    for (const hl of hardLines) {
      const trimmed = hl.trim();
      if (!trimmed) {
        lineCount += 1;
        continue;
      }
      // Word-wrap aware line count so long words/tokens wrap accurately
      const words = trimmed.split(/\s+/);
      let curLen = 0;
      let linesForHard = 1;
      for (const w of words) {
        if (curLen === 0) {
          if (w.length > charsPerLine) {
            linesForHard += Math.ceil(w.length / charsPerLine) - 1;
            curLen = w.length % charsPerLine || charsPerLine;
          } else {
            curLen = w.length;
          }
        } else if (curLen + 1 + w.length <= charsPerLine) {
          curLen += 1 + w.length;
        } else {
          linesForHard++;
          if (w.length > charsPerLine) {
            linesForHard += Math.ceil(w.length / charsPerLine) - 1;
            curLen = w.length % charsPerLine || charsPerLine;
          } else {
            curLen = w.length;
          }
        }
      }
      lineCount += Math.max(1, linesForHard);
    }
    const lineHeightPt = fontSizePt * 1.45;
    const totalPadPt = Math.max(6, padTopPt + padBottomPt);
    return roundIn(Math.max(0.16, (lineCount * lineHeightPt + totalPadPt) / PT_PER_INCH));
  }

  private buildEmptyPlaceholderTablix(
    tablixName: string,
    pageNumber: number,
    topIn: number,
    widthIn: number,
    dataSetName: string,
    nextUniqueName: (prefix: string) => string,
    pageBreakBefore: boolean,
    leftIn = 0
  ): TablixRegion {
    const w = roundIn(Math.max(0.25, widthIn));
    const h = 0.2;
    return {
      id: tablixName,
      name: tablixName,
      pageNumber,
      bandKind: 'Detail',
      pageBreakBefore,
      topIn: roundIn(topIn),
      leftIn: roundIn(leftIn),
      widthIn: w,
      heightIn: h,
      dataSetName,
      isRepeatingDetail: false,
      columnWidthsIn: [w],
      rows: [
        {
          heightIn: h,
          isDetailRow: false,
          pageBreakBefore: pageBreakBefore ? true : undefined,
          cells: [
            {
              colIndex: 0,
              rowIndex: 0,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: { kind: 'Empty', name: nextUniqueName('Empty') },
            },
          ],
        },
      ],
      zIndex: 1,
    };
  }
}
