import crypto from 'crypto';
import {
  LayoutPage,
  LayoutRegion,
  LayoutSectionSummary,
  RdlcBandContainerSpec,
  RdlcDocumentHierarchy,
  RegionStyle,
  ReportFieldDef,
  StructuredLogger,
  TablixRegion,
  VisualImageItem,
  VisualParagraphSpec,
  VisualRectItem,
  VisualTextboxItem,
  VisualTextRun,
} from '../core/types.ts';
import { ParameterDetectionContext, parameterizeTextRuns } from './parameterDetector.ts';

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function roundIn(val: number): number {
  return Math.round(val * 1000) / 1000;
}

export function sanitizeV2Identifier(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `S_${cleaned}` : cleaned;
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
  return sanitizeV2Identifier(joined.slice(0, 28), fallback);
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

function isLikelyHeadingRegion(r: LayoutRegion, bodyMedianFontPt: number): boolean {
  if (r.type !== 'text' || !r.text) return false;
  const txt = r.text.trim();
  if (!txt || txt.length > 90) return false;
  if (r.semanticRole === 'reportTitle' || r.semanticRole === 'sectionHeading') return true;
  if (r.style.fontSizePt >= bodyMedianFontPt + 1.5 && r.style.bold) return true;
  if (r.style.bold && txt.length <= 55 && txt === txt.toUpperCase() && /[A-Z]/.test(txt)) return true;
  if (/^(?:[A-Z]\.|BAB\s+[IVX0-9]+|PASAL\s+\d+)/i.test(txt) && r.style.bold) return true;
  return false;
}

function isBulletStart(text: string): boolean {
  return /^(?:\d+[\.\)]|[a-z][\.\)]|[•\u2022\-–*])\s+/i.test(text.trim());
}

export interface V2CompileInput {
  pages: LayoutPage[];
  pageWidthIn: number;
  pageHeightIn: number;
  pageTablixesByPage: Map<number, TablixRegion[]>;
  coveredByTablixFn: (pageNumber: number, x: number, y: number, w: number, h: number) => boolean;
  paramCtx: ParameterDetectionContext;
  registerEmbeddedImage: (base64Data: string, preferredName: string) => string;
  nextUniqueName: (prefix: string) => string;
  fieldMap: Map<string, ReportFieldDef>;
}

export interface V2CompileOutput {
  pageHeaderSpec?: RdlcBandContainerSpec;
  pageFooterSpec?: RdlcBandContainerSpec;
  bodySections: VisualRectItem[];
  hierarchy: RdlcDocumentHierarchy;
}

interface DetectedChrome {
  pageHeader?: {
    heightIn: number;
    printOnFirstPage: boolean;
    printOnLastPage: boolean;
    regions: LayoutRegion[];
    matchedIdsByPage: Map<number, Set<string>>;
  };
  pageFooter?: {
    topIn: number;
    heightIn: number;
    printOnFirstPage: boolean;
    printOnLastPage: boolean;
    regions: LayoutRegion[];
    matchedIdsByPage: Map<number, Set<string>>;
  };
}

interface BodyItemBox {
  kind: 'rect' | 'line' | 'image' | 'text' | 'tablix';
  x: number;
  y: number;
  width: number;
  height: number;
  region?: LayoutRegion;
  tablix?: TablixRegion;
  rawIndex: number;
}

export class V2LayoutCompiler {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public compile(input: V2CompileInput): V2CompileOutput {
    const {
      pages,
      pageWidthIn,
      pageHeightIn,
      pageTablixesByPage,
      coveredByTablixFn,
      paramCtx,
      registerEmbeddedImage,
      nextUniqueName,
    } = input;

    // 1. Stage 1: Repeating Header / Footer Detection + PrintOnFirstPage Auto-Detect
    const chrome = this.detectRepeatingHeaderFooter(pages, pageWidthIn, pageHeightIn, coveredByTablixFn);

    const pageHeaderSpec = chrome.pageHeader
      ? this.buildChromeBandSpec(
          'PageHeader',
          chrome.pageHeader.heightIn,
          0,
          pageWidthIn,
          chrome.pageHeader.printOnFirstPage,
          chrome.pageHeader.printOnLastPage,
          chrome.pageHeader.regions,
          paramCtx,
          registerEmbeddedImage,
          nextUniqueName
        )
      : undefined;

    const pageFooterSpec = chrome.pageFooter
      ? this.buildChromeBandSpec(
          'PageFooter',
          chrome.pageFooter.heightIn,
          chrome.pageFooter.topIn,
          pageWidthIn,
          chrome.pageFooter.printOnFirstPage,
          chrome.pageFooter.printOnLastPage,
          chrome.pageFooter.regions,
          paramCtx,
          registerEmbeddedImage,
          nextUniqueName
        )
      : undefined;

    // Compute body median font size for heading detection
    const allFontSizes = pages
      .flatMap((p) => p.regions)
      .filter((r) => r.type === 'text')
      .map((r) => r.style.fontSizePt)
      .sort((a, b) => a - b);
    const bodyMedianFontPt =
      allFontSizes.length > 0 ? allFontSizes[Math.floor(allFontSizes.length / 2)] : 9;

    // 2. Stage 2 & 3: Body Section Segmentation, Column Splitting, Line->Paragraph Grouping & Native Fills
    const bodySections: VisualRectItem[] = [];
    const sectionSummaries: LayoutSectionSummary[] = [];
    let sectionSeq = 1;
    let cumulativeBodyTopIn = 0;

    for (const page of pages) {
      const pNum = page.pageNumber;
      const showHeaderOnThisPage = Boolean(
        chrome.pageHeader && (pNum > 1 || chrome.pageHeader.printOnFirstPage)
      );
      const headerOffsetIn = showHeaderOnThisPage ? chrome.pageHeader!.heightIn : 0;
      const footerCutIn = chrome.pageFooter ? chrome.pageFooter.topIn : pageHeightIn;
      const pageBodyHeightIn = Math.max(
        1.0,
        roundIn(pageHeightIn - headerOffsetIn - (chrome.pageFooter ? chrome.pageFooter.heightIn : 0))
      );

      const headerExcludedIds = chrome.pageHeader?.matchedIdsByPage.get(pNum) ?? new Set<string>();
      const footerExcludedIds = chrome.pageFooter?.matchedIdsByPage.get(pNum) ?? new Set<string>();

      const bodyItems: BodyItemBox[] = [];
      let rawIdx = 0;

      // Add native Tablix items for this page
      const pTablixes = pageTablixesByPage.get(pNum) ?? [];
      for (const tbl of pTablixes) {
        const localTop = Math.max(0, tbl.topIn - headerOffsetIn);
        bodyItems.push({
          kind: 'tablix',
          x: tbl.leftIn,
          y: localTop,
          width: tbl.widthIn,
          height: tbl.heightIn,
          tablix: { ...tbl, topIn: roundIn(localTop) },
          rawIndex: rawIdx++,
        });
      }

      // Add remaining non-chrome, non-tablix regions
      for (const r of page.regions) {
        if (headerExcludedIds.has(r.id) || footerExcludedIds.has(r.id)) continue;
        if (showHeaderOnThisPage && r.y + r.height <= headerOffsetIn + 0.03) continue;
        if (chrome.pageFooter && r.y >= footerCutIn - 0.03) continue;
        if (coveredByTablixFn(pNum, r.x, r.y, r.width, r.height)) continue;

        // Skip invisible full-page white background fill
        if (
          r.type === 'vector_rect' &&
          r.width >= pageWidthIn - 0.12 &&
          r.height >= pageHeightIn - 0.12 &&
          (!r.style.backgroundColor || r.style.backgroundColor.toUpperCase() === '#FFFFFF') &&
          !r.style.borderColor
        ) {
          continue;
        }

        const localY = Math.max(0, r.y - headerOffsetIn);
        const clampedX = clamp(r.x, 0, Math.max(0, pageWidthIn - 0.04));
        const clampedW = clamp(r.width, 0.015, pageWidthIn - clampedX);
        const clampedH = clamp(r.height, 0.015, Math.max(0.015, pageBodyHeightIn - localY));

        const kind: BodyItemBox['kind'] =
          r.type === 'vector_line'
            ? 'line'
            : r.type === 'vector_rect'
              ? 'rect'
              : r.type === 'image' || r.type === 'vector_complex'
                ? 'image'
                : 'text';

        bodyItems.push({
          kind,
          x: clampedX,
          y: localY,
          width: clampedW,
          height: clampedH,
          region: r,
          rawIndex: rawIdx++,
        });
      }

      // Segment page body items into semantic sections without straddling objects
      const segmentedBands = this.segmentBodyIntoSections(
        bodyItems,
        pageBodyHeightIn,
        bodyMedianFontPt
      );

      for (let sIdx = 0; sIdx < segmentedBands.length; sIdx++) {
        const band = segmentedBands[sIdx];
        const isFirstOnNewPage = pNum > 1 && sIdx === 0;
        const secNum = String(sectionSeq++).padStart(2, '0');
        const headingText = band.heading?.region?.text ?? `Page${pNum}Band${sIdx + 1}`;
        const slug = makeSectionSlug(headingText, `Page${pNum}Block${sIdx + 1}`);
        const sectionName = sanitizeV2Identifier(`Section_${secNum}_${slug}`, `Section_${secNum}`);

        const secTopLocal = sIdx === 0 ? 0 : band.topIn;
        const secBottomLocal =
          sIdx === segmentedBands.length - 1
            ? Math.min(pageBodyHeightIn, Math.max(band.bottomIn + 0.04, secTopLocal + 0.25))
            : segmentedBands[sIdx + 1].topIn;
        const secHeight = roundIn(Math.max(0.25, secBottomLocal - secTopLocal));
        const secRdlcTop = roundIn(cumulativeBodyTopIn + secTopLocal);

        // Shift band item coordinates to be relative to section top (secTopLocal)
        const secRelItems: BodyItemBox[] = band.items.map((it) => ({
          ...it,
          y: Math.max(0, it.y - secTopLocal),
          tablix: it.tablix ? { ...it.tablix, topIn: roundIn(Math.max(0, it.y - secTopLocal)) } : undefined,
        }));

        // Detect two-column split inside this section
        const colSplit = this.detectTwoColumnSplit(secRelItems, pageWidthIn, secHeight);
        const children = this.buildSectionChildren(
          sectionName,
          secRelItems,
          pageWidthIn,
          secHeight,
          colSplit,
          pNum,
          paramCtx,
          registerEmbeddedImage,
          nextUniqueName,
          bodyMedianFontPt
        );

        const sectionRect: VisualRectItem = {
          kind: 'Rectangle',
          name: sectionName,
          leftIn: 0,
          topIn: secRdlcTop,
          widthIn: roundIn(pageWidthIn),
          heightIn: secHeight,
          zIndex: 0,
          role: 'section',
          pageNumber: pNum,
          pageBreakLocation: isFirstOnNewPage ? 'Start' : undefined,
          keepTogether: false,
          children,
        };
        bodySections.push(sectionRect);

        const hasTablix = secRelItems.some((it) => it.kind === 'tablix');
        const hasLeft = children.rectangles.some((r) => r.role === 'leftColumn');
        const hasRight = children.rectangles.some((r) => r.role === 'rightColumn');
        const hasHeaderBand = children.rectangles.some((r) => r.role === 'headerBand');
        const hasFooterBand = children.rectangles.some((r) => r.role === 'footerBand');
        const childCount =
          children.rectangles.length +
          children.images.length +
          children.textboxes.length +
          children.tablixes.length;

        sectionSummaries.push({
          name: sectionName,
          slug,
          pageNumber: pNum,
          pageBreakStart: isFirstOnNewPage,
          topIn: secRdlcTop,
          leftIn: 0,
          widthIn: roundIn(pageWidthIn),
          heightIn: secHeight,
          layoutType:
            hasLeft && hasRight ? 'Dual-Column' : hasTablix ? 'Tablix' : 'Single-Column',
          hasHeaderBand,
          hasLeftColumn: hasLeft,
          hasRightColumn: hasRight,
          hasFooterBand,
          childItemCount: childCount,
        });
      }

      cumulativeBodyTopIn = roundIn(cumulativeBodyTopIn + pageBodyHeightIn);
    }

    const hierarchy: RdlcDocumentHierarchy = {
      mode: 'v2-hierarchical-single-rdlc',
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

    this.logger.info('V2LayoutCompiler', 'Single-RDLC hierarchical compilation complete', {
      hasPageHeader: Boolean(pageHeaderSpec),
      printOnFirstPage: pageHeaderSpec?.printOnFirstPage,
      hasPageFooter: Boolean(pageFooterSpec),
      sections: sectionSummaries.length,
      dualColumnSections: sectionSummaries.filter((s) => s.layoutType === 'Dual-Column').length,
    });

    return {
      pageHeaderSpec,
      pageFooterSpec,
      bodySections,
      hierarchy,
    };
  }

  private detectRepeatingHeaderFooter(
    pages: LayoutPage[],
    pageWidthIn: number,
    pageHeightIn: number,
    coveredByTablixFn: (pageNumber: number, x: number, y: number, w: number, h: number) => boolean
  ): DetectedChrome {
    if (pages.length < 2) return {};

    const numPages = pages.length;
    const topBandLimitY = pageHeightIn * 0.18;
    const bottomBandLimitY = pageHeightIn * 0.915;
    const minConsensusAll = Math.max(2, Math.ceil(numPages * 0.6));
    const minConsensusTail = numPages >= 3 ? Math.max(2, Math.ceil((numPages - 1) * 0.6)) : 2;

    // --- HEADER DETECTION ---
    const headerSigCounts = new Map<string, { pages: Set<number>; sample: LayoutRegion }>();
    const tailSigCounts = new Map<string, { pages: Set<number>; sample: LayoutRegion }>();

    for (const p of pages) {
      const seenOnPage = new Set<string>();
      for (const r of p.regions) {
        if (r.y + r.height > topBandLimitY) continue;
        if (coveredByTablixFn(p.pageNumber, r.x, r.y, r.width, r.height)) continue;
        const sig = regionSignature(r);
        if (seenOnPage.has(sig)) continue;
        seenOnPage.add(sig);

        const allEntry = headerSigCounts.get(sig) ?? { pages: new Set<number>(), sample: r };
        allEntry.pages.add(p.pageNumber);
        headerSigCounts.set(sig, allEntry);

        if (p.pageNumber >= 2) {
          const tailEntry = tailSigCounts.get(sig) ?? { pages: new Set<number>(), sample: r };
          tailEntry.pages.add(p.pageNumber);
          tailSigCounts.set(sig, tailEntry);
        }
      }
    }

    const consensusTailSigs = new Set<string>();
    for (const [sig, info] of tailSigCounts.entries()) {
      if (info.pages.size >= minConsensusTail) {
        consensusTailSigs.add(sig);
      }
    }
    const consensusAllSigs = new Set<string>();
    for (const [sig, info] of headerSigCounts.entries()) {
      if (info.pages.size >= minConsensusAll) {
        consensusAllSigs.add(sig);
      }
    }

    const activeHeaderSigs =
      consensusAllSigs.size >= consensusTailSigs.size ? consensusAllSigs : consensusTailSigs;

    let pageHeader: DetectedChrome['pageHeader'];
    if (activeHeaderSigs.size > 0) {
      // Pick canonical template page (prefer page 2 if tail consensus, or page 1)
      const templatePage =
        pages.find((p) => p.pageNumber >= 2) ?? pages[0];
      const matchedHeaderRegions = templatePage.regions.filter((r) => {
        if (r.y + r.height > topBandLimitY) return false;
        return activeHeaderSigs.has(regionSignature(r));
      });

      if (matchedHeaderRegions.length > 0) {
        const headerHeightIn = roundIn(
          clamp(
            Math.max(...matchedHeaderRegions.map((r) => r.y + r.height)) + 0.03,
            0.2,
            topBandLimitY
          )
        );
        const page1Sigs = new Set(
          pages[0].regions
            .filter((r) => r.y + r.height <= headerHeightIn + 0.08)
            .map((r) => regionSignature(r))
        );
        let p1Matches = 0;
        for (const sig of activeHeaderSigs) {
          if (page1Sigs.has(sig)) p1Matches++;
        }
        const printOnFirstPage = p1Matches / activeHeaderSigs.size >= 0.6;

        const matchedIdsByPage = new Map<number, Set<string>>();
        for (const p of pages) {
          const ids = new Set<string>();
          if (p.pageNumber > 1 || printOnFirstPage) {
            for (const r of p.regions) {
              if (r.y + r.height <= headerHeightIn + 0.04 && activeHeaderSigs.has(regionSignature(r))) {
                ids.add(r.id);
              }
            }
          }
          matchedIdsByPage.set(p.pageNumber, ids);
        }

        pageHeader = {
          heightIn: headerHeightIn,
          printOnFirstPage,
          printOnLastPage: true,
          regions: matchedHeaderRegions,
          matchedIdsByPage,
        };
      }
    }

    // --- FOOTER DETECTION ---
    const footerSigCounts = new Map<string, { pages: Set<number>; sample: LayoutRegion }>();
    for (const p of pages) {
      const seenOnPage = new Set<string>();
      for (const r of p.regions) {
        if (r.y < bottomBandLimitY) continue;
        if (coveredByTablixFn(p.pageNumber, r.x, r.y, r.width, r.height)) continue;
        const sig = regionSignature(r);
        if (seenOnPage.has(sig)) continue;
        seenOnPage.add(sig);

        const entry = footerSigCounts.get(sig) ?? { pages: new Set<number>(), sample: r };
        entry.pages.add(p.pageNumber);
        footerSigCounts.set(sig, entry);
      }
    }

    const consensusFooterSigs = new Set<string>();
    for (const [sig, info] of footerSigCounts.entries()) {
      if (info.pages.size >= minConsensusAll) {
        consensusFooterSigs.add(sig);
      }
    }

    let pageFooter: DetectedChrome['pageFooter'];
    if (consensusFooterSigs.size > 0) {
      const templatePage = pages[0];
      let matchedFooterRegions = templatePage.regions.filter(
        (r) => r.y >= bottomBandLimitY && consensusFooterSigs.has(regionSignature(r))
      );
      if (matchedFooterRegions.length === 0 && pages[1]) {
        matchedFooterRegions = pages[1].regions.filter(
          (r) => r.y >= bottomBandLimitY && consensusFooterSigs.has(regionSignature(r))
        );
      }

      if (matchedFooterRegions.length > 0) {
        const minY = Math.min(...matchedFooterRegions.map((r) => r.y));
        const footerTopIn = roundIn(clamp(minY - 0.015, pageHeightIn * 0.9, pageHeightIn - 0.18));
        const footerHeightIn = roundIn(Math.max(0.18, pageHeightIn - footerTopIn));

        const matchedIdsByPage = new Map<number, Set<string>>();
        for (const p of pages) {
          const ids = new Set<string>();
          for (const r of p.regions) {
            if (r.y >= footerTopIn - 0.04 && consensusFooterSigs.has(regionSignature(r))) {
              ids.add(r.id);
            }
          }
          matchedIdsByPage.set(p.pageNumber, ids);
        }

        // Also include any full-width fill/bar sitting strictly inside [footerTopIn, pageHeightIn]
        pageFooter = {
          topIn: footerTopIn,
          heightIn: footerHeightIn,
          printOnFirstPage: true,
          printOnLastPage: true,
          regions: matchedFooterRegions,
          matchedIdsByPage,
        };
      }
    }

    void pageWidthIn;
    return { pageHeader, pageFooter };
  }

  private buildChromeBandSpec(
    kind: 'PageHeader' | 'PageFooter',
    bandHeightIn: number,
    bandTopIn: number,
    pageWidthIn: number,
    printOnFirstPage: boolean,
    printOnLastPage: boolean,
    regions: LayoutRegion[],
    paramCtx: ParameterDetectionContext,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string
  ): RdlcBandContainerSpec {
    const items: BodyItemBox[] = regions.map((r, idx) => ({
      kind:
        r.type === 'vector_line'
          ? 'line'
          : r.type === 'vector_rect'
            ? 'rect'
            : r.type === 'image' || r.type === 'vector_complex'
              ? 'image'
              : 'text',
      x: clamp(r.x, 0, pageWidthIn - 0.02),
      y: clamp(r.y - bandTopIn, 0, Math.max(0, bandHeightIn - 0.02)),
      width: clamp(r.width, 0.015, pageWidthIn - clamp(r.x, 0, pageWidthIn - 0.02)),
      height: clamp(r.height, 0.015, Math.max(0.015, bandHeightIn - clamp(r.y - bandTopIn, 0, bandHeightIn))),
      region: r,
      rawIndex: idx,
    }));

    const { rectangles, images, textboxes } = this.emitItemsIntoContainer(
      items,
      pageWidthIn,
      bandHeightIn,
      1,
      paramCtx,
      registerEmbeddedImage,
      nextUniqueName,
      9,
      { allowMultiLineGrouping: false, normalizeFooterExpressions: kind === 'PageFooter' }
    );

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

  private segmentBodyIntoSections(
    items: BodyItemBox[],
    pageBodyHeightIn: number,
    bodyMedianFontPt: number
  ): Array<{
    topIn: number;
    bottomIn: number;
    heading?: BodyItemBox;
    items: BodyItemBox[];
  }> {
    if (items.length === 0) {
      return [{ topIn: 0, bottomIn: Math.min(pageBodyHeightIn, 1.0), items: [] }];
    }

    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const minContentY = Math.min(...sorted.map((i) => i.y));
    const maxContentY = Math.max(...sorted.map((i) => i.y + i.height));

    // Find safe Y-cut points where ZERO items cross cutY
    const candidateCuts: number[] = [];
    const hasStraddler = (cutY: number): boolean =>
      sorted.some((it) => it.y < cutY - 0.02 && it.y + it.height > cutY + 0.02);

    // 1. Cut on significant vertical whitespace gaps (>= 0.32in)
    let runningBottom = sorted[0].y + sorted[0].height;
    for (let i = 1; i < sorted.length; i++) {
      const it = sorted[i];
      const gap = it.y - runningBottom;
      if (gap >= 0.30) {
        const cutY = roundIn(runningBottom + gap * 0.35);
        if (!hasStraddler(cutY)) {
          candidateCuts.push(cutY);
        }
      }
      // 2. Also cut above standalone section headings preceded by >= 0.14in clear gap
      if (
        it.kind === 'text' &&
        it.region &&
        gap >= 0.14 &&
        isLikelyHeadingRegion(it.region, bodyMedianFontPt)
      ) {
        const cutY = roundIn(it.y - Math.min(0.06, gap * 0.4));
        if (!hasStraddler(cutY)) {
          candidateCuts.push(cutY);
        }
      }
      runningBottom = Math.max(runningBottom, it.y + it.height);
    }

    // Deduplicate nearby cuts (< 0.55in apart) to prevent fragmented micro-sections
    const sortedCuts = [...new Set(candidateCuts)].sort((a, b) => a - b);
    const finalCuts: number[] = [];
    let lastCut = Math.max(0, minContentY);
    for (const c of sortedCuts) {
      if (c - lastCut >= 0.55 && maxContentY - c >= 0.35) {
        finalCuts.push(c);
        lastCut = c;
      }
    }

    const boundaries = [0, ...finalCuts, roundIn(Math.min(pageBodyHeightIn, maxContentY + 0.04))];
    const bands: Array<{
      topIn: number;
      bottomIn: number;
      heading?: BodyItemBox;
      items: BodyItemBox[];
    }> = [];

    for (let b = 0; b < boundaries.length - 1; b++) {
      const bTop = boundaries[b];
      const bBot = boundaries[b + 1];
      const bandItems = sorted.filter((it) => {
        const cy = it.y + it.height / 2;
        if (b === boundaries.length - 2) return cy >= bTop - 0.01;
        return cy >= bTop - 0.01 && cy < bBot;
      });
      if (bandItems.length === 0 && b > 0) continue;

      const heading = bandItems.find(
        (it) => it.kind === 'text' && it.region && isLikelyHeadingRegion(it.region, bodyMedianFontPt)
      ) ?? bandItems.find((it) => it.kind === 'text' && it.region?.text);

      bands.push({
        topIn: roundIn(bTop),
        bottomIn: roundIn(Math.max(bTop + 0.25, bBot)),
        heading,
        items: bandItems,
      });
    }

    return bands.length > 0
      ? bands
      : [{ topIn: 0, bottomIn: roundIn(Math.min(pageBodyHeightIn, maxContentY + 0.04)), items: sorted }];
  }

  private detectTwoColumnSplit(
    items: BodyItemBox[],
    sectionW: number,
    sectionH: number
  ): { splitX: number; bandTop: number; bandBottom: number } | undefined {
    const contentItems = items.filter((it) => it.kind === 'text' || it.kind === 'image');
    if (contentItems.length < 4) return undefined;

    const minXSearch = sectionW * 0.35;
    const maxXSearch = sectionW * 0.65;
    const minGutterIn = 0.216; // >= 0.55cm

    // Find horizontal whitespace gutter over text/image items inside 35%..65% X
    const nonWideItems = contentItems.filter((it) => it.width < sectionW * 0.56);
    if (nonWideItems.length < 4) return undefined;

    let bestSplit: { splitX: number; score: number; bandTop: number; bandBottom: number } | undefined;

    for (let x = minXSearch; x <= maxXSearch; x += 0.04) {
      const halfGutter = minGutterIn / 2;
      const gLeft = x - halfGutter;
      const gRight = x + halfGutter;

      // Collect left & right items NOT touching [gLeft, gRight]
      const crossing = nonWideItems.filter((it) => it.x < gRight && it.x + it.width > gLeft);

      // Compute Y-band free of crossing items
      let bandTop = 0;
      let bandBottom = sectionH;
      if (crossing.length > 0) {
        // Restrict to the largest vertical slice free of crossing items
        const crossIntervals = crossing
          .map((c) => ({ y1: c.y, y2: c.y + c.height }))
          .sort((a, b) => a.y1 - b.y1);
        const gaps: Array<{ y1: number; y2: number }> = [];
        let cur = 0;
        for (const iv of crossIntervals) {
          if (iv.y1 - cur >= 0.6) gaps.push({ y1: cur, y2: iv.y1 });
          cur = Math.max(cur, iv.y2);
        }
        if (sectionH - cur >= 0.6) gaps.push({ y1: cur, y2: sectionH });
        if (gaps.length === 0) continue;
        gaps.sort((a, b) => b.y2 - b.y1 - (a.y2 - a.y1));
        bandTop = gaps[0].y1;
        bandBottom = gaps[0].y2;
      }

      const leftItems = nonWideItems.filter(
        (it) => it.y + it.height / 2 >= bandTop && it.y + it.height / 2 <= bandBottom && it.x + it.width <= gLeft + 0.01
      );
      const rightItems = nonWideItems.filter(
        (it) => it.y + it.height / 2 >= bandTop && it.y + it.height / 2 <= bandBottom && it.x >= gRight - 0.01
      );

      if (leftItems.length < 2 || rightItems.length < 2) continue;

      // Require clear left AND right vertical span >= 0.78in (~2.0cm) or >= 3 paired Y-bands
      const lTop = Math.min(...leftItems.map((i) => i.y));
      const lBot = Math.max(...leftItems.map((i) => i.y + i.height));
      const rTop = Math.min(...rightItems.map((i) => i.y));
      const rBot = Math.max(...rightItems.map((i) => i.y + i.height));
      const overlapY = Math.min(lBot, rBot) - Math.max(lTop, rTop);
      if (overlapY < 0.45) continue;

      const actualBandTop = Math.max(bandTop, Math.min(lTop, rTop) - 0.02);
      const actualBandBot = Math.min(bandBottom, Math.max(lBot, rBot) + 0.02);
      const span = actualBandBot - actualBandTop;
      const pairedCount = Math.min(leftItems.length, rightItems.length);
      if (span < 0.78 && pairedCount < 3) continue;

      // Also check that no Tablix straddles splitX inside [actualBandTop, actualBandBot]
      const tablixCrosses = items.some(
        (it) =>
          it.kind === 'tablix' &&
          it.y < actualBandBot &&
          it.y + it.height > actualBandTop &&
          it.x < gRight &&
          it.x + it.width > gLeft
      );
      if (tablixCrosses) continue;

      const score = pairedCount * 10 + span;
      if (!bestSplit || score > bestSplit.score) {
        bestSplit = {
          splitX: roundIn(x),
          score,
          bandTop: roundIn(Math.max(0, actualBandTop)),
          bandBottom: roundIn(Math.min(sectionH, actualBandBot)),
        };
      }
    }

    return bestSplit
      ? { splitX: bestSplit.splitX, bandTop: bestSplit.bandTop, bandBottom: bestSplit.bandBottom }
      : undefined;
  }

  private buildSectionChildren(
    sectionName: string,
    secItems: BodyItemBox[],
    sectionW: number,
    sectionH: number,
    colSplit: { splitX: number; bandTop: number; bandBottom: number } | undefined,
    pageNumber: number,
    paramCtx: ParameterDetectionContext,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    bodyMedianFontPt: number
  ): NonNullable<VisualRectItem['children']> {
    if (!colSplit) {
      return this.emitItemsIntoContainer(
        secItems,
        sectionW,
        sectionH,
        pageNumber,
        paramCtx,
        registerEmbeddedImage,
        nextUniqueName,
        bodyMedianFontPt,
        { allowMultiLineGrouping: true }
      );
    }

    const { splitX, bandTop, bandBottom } = colSplit;
    const headerBandItems: BodyItemBox[] = [];
    const leftItems: BodyItemBox[] = [];
    const rightItems: BodyItemBox[] = [];
    const footerBandItems: BodyItemBox[] = [];
    const parentBackdropItems: BodyItemBox[] = [];

    for (const it of secItems) {
      const cy = it.y + it.height / 2;
      if (cy < bandTop - 0.01) {
        headerBandItems.push(it);
      } else if (cy > bandBottom + 0.01) {
        footerBandItems.push({ ...it, y: Math.max(0, it.y - bandBottom) });
      } else if (
        (it.kind === 'rect' || it.kind === 'line') &&
        it.x < splitX - 0.06 &&
        it.x + it.width > splitX + 0.06
      ) {
        // Backdrop fills / rules that span across the center gutter stay at ZIndex=0 on the Section parent
        parentBackdropItems.push(it);
      } else if (it.x + it.width <= splitX + 0.04) {
        leftItems.push({ ...it, y: Math.max(0, it.y - bandTop) });
      } else if (it.x >= splitX - 0.04) {
        rightItems.push({
          ...it,
          x: Math.max(0, it.x - splitX),
          y: Math.max(0, it.y - bandTop),
          tablix: it.tablix
            ? {
                ...it.tablix,
                leftIn: roundIn(Math.max(0, it.tablix.leftIn - splitX)),
                topIn: roundIn(Math.max(0, it.y - bandTop)),
              }
            : undefined,
        });
      } else {
        parentBackdropItems.push(it);
      }
    }

    const parentEmitted = this.emitItemsIntoContainer(
      parentBackdropItems,
      sectionW,
      sectionH,
      pageNumber,
      paramCtx,
      registerEmbeddedImage,
      nextUniqueName,
      bodyMedianFontPt,
      { allowMultiLineGrouping: false }
    );

    const outRectangles: VisualRectItem[] = [...parentEmitted.rectangles];

    if (headerBandItems.length > 0 && bandTop >= 0.12) {
      const hbChildren = this.emitItemsIntoContainer(
        headerBandItems,
        sectionW,
        bandTop,
        pageNumber,
        paramCtx,
        registerEmbeddedImage,
        nextUniqueName,
        bodyMedianFontPt,
        { allowMultiLineGrouping: true }
      );
      outRectangles.push({
        kind: 'Rectangle',
        name: `${sectionName}_HeaderBand`,
        leftIn: 0,
        topIn: 0,
        widthIn: roundIn(sectionW),
        heightIn: roundIn(bandTop),
        zIndex: 1,
        role: 'headerBand',
        children: hbChildren,
      });
    }

    const colH = roundIn(Math.max(0.25, bandBottom - bandTop));
    if (leftItems.length > 0) {
      const lcChildren = this.emitItemsIntoContainer(
        leftItems,
        splitX,
        colH,
        pageNumber,
        paramCtx,
        registerEmbeddedImage,
        nextUniqueName,
        bodyMedianFontPt,
        { allowMultiLineGrouping: true }
      );
      outRectangles.push({
        kind: 'Rectangle',
        name: `${sectionName}_LeftColumn`,
        leftIn: 0,
        topIn: roundIn(bandTop),
        widthIn: roundIn(splitX),
        heightIn: colH,
        zIndex: 1,
        role: 'leftColumn',
        children: lcChildren,
      });
    }

    const rightW = roundIn(Math.max(0.4, sectionW - splitX));
    if (rightItems.length > 0) {
      const rcChildren = this.emitItemsIntoContainer(
        rightItems,
        rightW,
        colH,
        pageNumber,
        paramCtx,
        registerEmbeddedImage,
        nextUniqueName,
        bodyMedianFontPt,
        { allowMultiLineGrouping: true }
      );
      outRectangles.push({
        kind: 'Rectangle',
        name: `${sectionName}_RightColumn`,
        leftIn: roundIn(splitX),
        topIn: roundIn(bandTop),
        widthIn: rightW,
        heightIn: colH,
        zIndex: 1,
        role: 'rightColumn',
        children: rcChildren,
      });
    }

    const footH = roundIn(Math.max(0.15, sectionH - bandBottom));
    if (footerBandItems.length > 0 && footH >= 0.15) {
      const fbChildren = this.emitItemsIntoContainer(
        footerBandItems,
        sectionW,
        footH,
        pageNumber,
        paramCtx,
        registerEmbeddedImage,
        nextUniqueName,
        bodyMedianFontPt,
        { allowMultiLineGrouping: true }
      );
      outRectangles.push({
        kind: 'Rectangle',
        name: `${sectionName}_FooterBand`,
        leftIn: 0,
        topIn: roundIn(bandBottom),
        widthIn: roundIn(sectionW),
        heightIn: footH,
        zIndex: 1,
        role: 'footerBand',
        children: fbChildren,
      });
    }

    return {
      rectangles: outRectangles,
      images: parentEmitted.images,
      textboxes: parentEmitted.textboxes,
      tablixes: parentEmitted.tablixes,
    };
  }

  private emitItemsIntoContainer(
    items: BodyItemBox[],
    containerW: number,
    containerH: number,
    pageNumber: number,
    paramCtx: ParameterDetectionContext,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    bodyMedianFontPt: number,
    opts: { allowMultiLineGrouping: boolean; normalizeFooterExpressions?: boolean }
  ): NonNullable<VisualRectItem['children']> {
    const shapeRects: VisualRectItem[] = [];
    const lineRects: VisualRectItem[] = [];
    const images: VisualImageItem[] = [];
    const tablixes: TablixRegion[] = [];
    const textItems: BodyItemBox[] = [];

    for (const it of items) {
      if (it.kind === 'tablix' && it.tablix) {
        tablixes.push({ ...it.tablix, zIndex: 1 });
        continue;
      }
      if ((it.kind === 'rect' || it.kind === 'line') && it.region) {
        const r = it.region;
        const x1 = clamp(it.x, 0, Math.max(0, containerW - 0.015));
        const y1 = clamp(it.y, 0, Math.max(0, containerH - 0.015));
        let w = roundIn(clamp(it.width, 0.015, containerW - x1));
        let h = roundIn(clamp(it.height, 0.015, containerH - y1));

        if (it.kind === 'line') {
          const horizontal = r.width >= r.height;
          if (horizontal) {
            if (w < 0.04) continue;
            h = Math.max(0.015, h);
          } else {
            if (h < 0.04) continue;
            w = Math.max(0.015, w);
          }
          const lineColor = r.style.borderColor ?? r.style.backgroundColor ?? '#CBD5E1';
          lineRects.push({
            kind: 'Rectangle',
            name: nextUniqueName('LineRect'),
            leftIn: roundIn(x1),
            topIn: roundIn(y1),
            widthIn: roundIn(Math.min(w, containerW - x1)),
            heightIn: roundIn(Math.min(h, containerH - y1)),
            backgroundColor: lineColor,
            zIndex: 0,
            role: 'line',
          });
          continue;
        }

        const bg = r.style.backgroundColor;
        const bc = r.style.borderColor;
        if (!bg && !bc) continue;
        shapeRects.push({
          kind: 'Rectangle',
          name: nextUniqueName('Rect'),
          leftIn: roundIn(x1),
          topIn: roundIn(y1),
          widthIn: w,
          heightIn: h,
          backgroundColor: bg,
          borderColor: bc,
          borderWidthPt: bc ? Math.max(0.5, r.style.borderWidthPt ?? 0.75) : undefined,
          zIndex: 0,
          role: 'fill',
        });
        continue;
      }

      if (it.kind === 'image' && it.region?.imageAssetBase64) {
        const x1 = clamp(it.x, 0, Math.max(0, containerW - 0.04));
        const y1 = clamp(it.y, 0, Math.max(0, containerH - 0.04));
        const w = roundIn(clamp(it.width, 0.06, containerW - x1));
        const h = roundIn(clamp(it.height, 0.06, containerH - y1));
        const isGlyphCrop = it.region.sourceObjectRefs.some((ref) => ref.includes('-glyph-'));
        const embName = registerEmbeddedImage(
          it.region.imageAssetBase64,
          it.region.imageAssetName ?? `Graphic_P${pageNumber}_${nextUniqueName('Asset')}`
        );
        images.push({
          kind: 'Image',
          name: nextUniqueName(isGlyphCrop ? 'ImgGlyph' : 'Img'),
          embeddedImageName: embName,
          leftIn: roundIn(x1),
          topIn: roundIn(y1),
          widthIn: w,
          heightIn: h,
          sizing: isGlyphCrop ? 'Fit' : 'FitProportional',
          zIndex: isGlyphCrop ? 2 : 1,
        });
        continue;
      }

      if (it.kind === 'text' && it.region?.text && it.region.text.trim().length > 0) {
        textItems.push(it);
      }
    }

    // Deduplicate identical stacked shapes while preserving painter order
    const rectangles: VisualRectItem[] = [];
    for (const rect of [...shapeRects, ...lineRects]) {
      const dupIdx = rectangles.findIndex(
        (prev) =>
          prev.role === rect.role &&
          Math.abs(prev.leftIn - rect.leftIn) <= 0.015 &&
          Math.abs(prev.topIn - rect.topIn) <= 0.015 &&
          Math.abs(prev.widthIn - rect.widthIn) <= 0.02 &&
          Math.abs(prev.heightIn - rect.heightIn) <= 0.02
      );
      if (dupIdx >= 0) {
        rectangles[dupIdx] = {
          ...rectangles[dupIdx],
          backgroundColor: rect.backgroundColor ?? rectangles[dupIdx].backgroundColor,
          borderColor: rect.borderColor ?? rectangles[dupIdx].borderColor,
          borderWidthPt: rect.borderWidthPt ?? rectangles[dupIdx].borderWidthPt,
        };
      } else {
        rectangles.push(rect);
      }
    }

    // Build single-line VisualTextboxItems first (sorted top->left) with padding-safe bounds
    textItems.sort((a, b) => (Math.abs(a.y - b.y) <= 0.05 ? a.x - b.x : a.y - b.y));
    const singleLineBoxes: Array<{
      tb: VisualTextboxItem;
      region: LayoutRegion;
      hasRightSibling: boolean;
      hasLeftSibling: boolean;
      isDynamicExpr: boolean;
    }> = [];

    for (let i = 0; i < textItems.length; i++) {
      const it = textItems[i];
      const r = it.region!;
      let relX = clamp(it.x, 0, Math.max(0, containerW - 0.08));
      const relY = clamp(it.y, 0, Math.max(0, containerH - 0.08));

      let nextLeft = containerW;
      let hasRightSibling = false;
      for (let j = i + 1; j < textItems.length; j++) {
        const sib = textItems[j];
        if (sib.y - it.y > 0.08) break;
        if (Math.abs(sib.y - it.y) <= 0.06 && sib.x > relX + it.width * 0.4) {
          nextLeft = Math.min(nextLeft, sib.x - 0.015);
          hasRightSibling = true;
          break;
        }
      }

      let precedingLabel: string | undefined;
      let hasLeftSibling = false;
      if (i > 0) {
        const prev = textItems[i - 1];
        if (Math.abs(prev.y - it.y) <= 0.06 && prev.x < it.x) {
          hasLeftSibling = true;
          if (
            prev.region?.text &&
            prev.region.text.trim().endsWith(':') &&
            prev.region.text.trim().length <= 32
          ) {
            precedingLabel = prev.region.text.trim();
          }
        }
      }

      // Padding-safe width calculation (1pt left/right padding -> compensate relX by 1pt for Left align so glyph x stays pixel-locked)
      const align = r.style.textAlign ?? 'Left';
      if (align === 'Left') {
        relX = Math.max(0, relX - 1 / 72);
      } else if (align === 'Center') {
        relX = Math.max(0, relX - Math.min(0.04, relX));
      } else if (align === 'Right') {
        relX = Math.max(0, relX - Math.min(0.06, relX));
      }
      const colRemaining = Math.max(0.08, nextLeft - relX);
      const rawW = it.width;
      const paddedW = rawW * 1.04 + 0.12;
      const boxW = clamp(paddedW, 0.08, colRemaining);

      const minFontHeightIn = Math.max(it.height, (r.style.fontSizePt / 72) * 1.25);
      const boxH = clamp(minFontHeightIn, 0.10, Math.max(0.10, containerH - relY));

      const baseRuns: VisualTextRun[] =
        r.runs && r.runs.length > 0
          ? r.runs.map((run) => ({ ...run }))
          : [
              {
                text: r.text ?? '',
                fontFamily: r.style.fontFamily,
                fontSizePt: r.style.fontSizePt,
                bold: r.style.bold,
                italic: r.style.italic,
                underline: r.style.underline,
                color: r.style.color,
              },
            ];

      let finalRuns = baseRuns;
      let isDynamicExpr = false;

      if (opts.normalizeFooterExpressions && r.text) {
        const expr = buildDynamicPageFooterExpr(r.text);
        if (expr) {
          finalRuns = [
            {
              ...baseRuns[0],
              text: expr,
            },
          ];
          isDynamicExpr = true;
        }
      } else {
        finalRuns = parameterizeTextRuns(paramCtx, baseRuns, pageNumber, precedingLabel);
        isDynamicExpr = finalRuns.some((rn) => Boolean(rn.parameterName));
      }

      const cleanStyle: RegionStyle = {
        ...r.style,
        backgroundColor: undefined,
        borderColor: undefined,
        borderWidthPt: undefined,
        verticalAlign: 'Top',
        paddingPt: { top: 0, right: 1, bottom: 0, left: 1 },
      };

      singleLineBoxes.push({
        tb: {
          kind: 'Textbox',
          name: nextUniqueName('Txt'),
          leftIn: roundIn(relX),
          topIn: roundIn(relY),
          widthIn: roundIn(boxW),
          heightIn: roundIn(boxH),
          text: r.text ?? '',
          runs: finalRuns,
          style: cleanStyle,
          canGrow: false,
          zIndex: 1,
        },
        region: r,
        hasRightSibling,
        hasLeftSibling,
        isDynamicExpr,
      });
    }

    // Group consecutive wrapped paragraph lines into multi-Paragraph Textboxes with exact LineHeight
    if (!opts.allowMultiLineGrouping || singleLineBoxes.length <= 1) {
      return {
        rectangles,
        images,
        textboxes: singleLineBoxes.map((s) => s.tb),
        tablixes,
      };
    }

    const groupedTextboxes: VisualTextboxItem[] = [];
    const consumed = new Set<number>();

    for (let i = 0; i < singleLineBoxes.length; i++) {
      if (consumed.has(i)) continue;
      consumed.add(i);
      const anchor = singleLineBoxes[i];
      const chain = [anchor];

      if (
        !anchor.isDynamicExpr &&
        !anchor.hasRightSibling &&
        !isLikelyHeadingRegion(anchor.region, bodyMedianFontPt) &&
        anchor.region.semanticRole !== 'fieldLabel'
      ) {
        let basePitch: number | undefined;
        let lastIdx = i;

        for (let j = i + 1; j < singleLineBoxes.length; j++) {
          if (consumed.has(j)) continue;
          const prevEntry = chain[chain.length - 1];
          const cand = singleLineBoxes[j];
          const dy = cand.tb.topIn - prevEntry.tb.topIn;

          const maxPitch = Math.max(0.24, (prevEntry.tb.style.fontSizePt / 72) * 1.85);
          if (dy > maxPitch + 0.04) break;
          if (dy < 0.065) continue;

          // Do not merge different columns, bullets, headings, labels, or dynamic parameters
          if (cand.isDynamicExpr || cand.hasLeftSibling || cand.hasRightSibling) continue;
          if (Math.abs(cand.tb.leftIn - anchor.tb.leftIn) > 0.045) continue;
          if (cand.tb.style.fontFamily !== anchor.tb.style.fontFamily) continue;
          if (Math.abs(cand.tb.style.fontSizePt - anchor.tb.style.fontSizePt) > 0.5) continue;
          if (cand.tb.style.textAlign !== anchor.tb.style.textAlign) continue;
          if (isLikelyHeadingRegion(cand.region, bodyMedianFontPt)) continue;
          if (isBulletStart(cand.tb.text)) continue;

          // Ensure no other non-chain item overlaps vertically between prevEntry and cand in the same X range
          const hasIntervening = singleLineBoxes.some((other, k) => {
            if (k === lastIdx || k === j || consumed.has(k)) return false;
            return (
              other.tb.topIn > prevEntry.tb.topIn + 0.01 &&
              other.tb.topIn < cand.tb.topIn - 0.01 &&
              other.tb.leftIn < Math.max(prevEntry.tb.leftIn + prevEntry.tb.widthIn, cand.tb.leftIn + cand.tb.widthIn) &&
              other.tb.leftIn + other.tb.widthIn > anchor.tb.leftIn
            );
          });
          if (hasIntervening) continue;

          if (basePitch === undefined) {
            basePitch = dy;
          } else if (Math.abs(dy - basePitch) > 0.03) {
            continue;
          }

          chain.push(cand);
          consumed.add(j);
          lastIdx = j;
        }
      }

      if (chain.length === 1) {
        groupedTextboxes.push(anchor.tb);
      } else {
        const first = chain[0].tb;
        const last = chain[chain.length - 1].tb;
        const avgPitchIn = (last.topIn - first.topIn) / (chain.length - 1);
        const pitchPt = Math.round(avgPitchIn * 72 * 10) / 10;
        const leftIn = Math.min(...chain.map((c) => c.tb.leftIn));
        const rightIn = Math.max(...chain.map((c) => c.tb.leftIn + c.tb.widthIn));
        const maxWidth = clamp(rightIn - leftIn, 0.1, containerW - leftIn);
        const totalH = clamp(
          last.topIn - first.topIn + last.heightIn + 0.02,
          first.heightIn,
          containerH - first.topIn
        );

        const paragraphLines: VisualParagraphSpec[] = chain.map((c) => ({
          runs: c.tb.runs ?? [],
          lineHeightPt: pitchPt,
          textAlign: c.tb.style.textAlign,
        }));

        groupedTextboxes.push({
          kind: 'Textbox',
          name: first.name,
          leftIn: roundIn(leftIn),
          topIn: roundIn(first.topIn),
          widthIn: roundIn(maxWidth),
          heightIn: roundIn(totalH),
          text: chain.map((c) => c.tb.text).join('\n'),
          runs: first.runs,
          paragraphLines,
          style: {
            ...first.style,
            lineHeightPt: pitchPt,
          },
          canGrow: false,
          zIndex: 1,
        });
      }
    }

    return {
      rectangles,
      images,
      textboxes: groupedTextboxes,
      tablixes,
    };
  }
}
