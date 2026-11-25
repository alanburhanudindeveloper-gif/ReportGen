import crypto from 'crypto';
import {
  LayoutPage,
  LayoutRegion,
  LayoutSectionSummary,
  RdlcBandContainerSpec,
  RdlcDocumentHierarchy,
  RdlcSchemaVersion,
  RegionStyle,
  ReportFieldDef,
  StructuredLogger,
  TablixArchetype,
  TablixCell,
  TablixRegion,
  TablixRow,
  VisualImageItem,
  VisualParagraphSpec,
  VisualRectItem,
  VisualTextboxItem,
  VisualTextRun,
} from '../core/types.ts';
import { ParameterDetectionContext, parameterizeTextRuns } from './parameterDetector.ts';
import { Rdlc2008LayoutCompiler } from './rdlc2008LayoutCompiler.ts';

const PT_PER_INCH = 72;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function roundIn(val: number): number {
  return Math.round(val * 1000) / 1000;
}

export function sanitizeV3Identifier(raw: string, fallback: string): string {
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
  return sanitizeV3Identifier(joined.slice(0, 28), fallback);
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
  if (!txt || txt.length > 95) return false;
  if (r.semanticRole === 'reportTitle' || r.semanticRole === 'sectionHeading') return true;
  if (r.style.fontSizePt >= bodyMedianFontPt + 1.5 && r.style.bold) return true;
  if (r.style.bold && txt.length <= 55 && txt === txt.toUpperCase() && /[A-Z]/.test(txt)) return true;
  if (/^(?:[A-Z]\.|BAB\s+[IVX0-9]+|PASAL\s+\d+)/i.test(txt) && r.style.bold) return true;
  return false;
}

const CLAUSE_PREFIX_RE = /^(\d+(?:\.\d+)*\.|\([ivxa-z0-9]+\)|[a-z][\.\)]|[•\u2022\-–*])\s+(.+)$/i;
const STANDALONE_MARKER_RE = /^(\d+(?:\.\d+)*\.?|\([ivxa-z0-9]+\)|[a-z][\.\)]|[•\u2022\-–*])$/i;

function isBulletStart(text: string): boolean {
  return /^(?:\d+(?:\.\d+)*[\.\)]|\([ivxa-z0-9]+\)|[a-z][\.\)]|[•\u2022\-–*])\s+/i.test(text.trim());
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
    paddingPt: { top: 0, right: 1, bottom: 0, left: 1 },
  };
}

export interface V3CompileInput {
  pages: LayoutPage[];
  pageWidthIn: number;
  pageHeightIn: number;
  fullPageWidthIn?: number;
  fullPageHeightIn?: number;
  marginsIn?: { top: number; right: number; bottom: number; left: number };
  schemaVersion?: RdlcSchemaVersion;
  dataSetName: string;
  pageTablixesByPage: Map<number, TablixRegion[]>;
  coveredByTablixFn: (pageNumber: number, x: number, y: number, w: number, h: number) => boolean;
  paramCtx: ParameterDetectionContext;
  registerEmbeddedImage: (base64Data: string, preferredName: string) => string;
  nextUniqueName: (prefix: string) => string;
  fieldMap: Map<string, ReportFieldDef>;
}

export interface V3CompileOutput {
  pageHeaderSpec?: RdlcBandContainerSpec;
  pageFooterSpec?: RdlcBandContainerSpec;
  bodyTablixes: TablixRegion[];
  hierarchy: RdlcDocumentHierarchy;
}

interface DetectedChrome {
  pageHeader?: {
    heightIn: number;
    printOnFirstPage: boolean;
    printOnLastPage: boolean;
    regions: LayoutRegion[];
    matchedIdsByPage: Map<number, Set<string>>;
    textSignatures: Array<{ norm: string; x: number }>;
    imageShas: Array<{ sha: string; x: number }>;
  };
  pageFooter?: {
    topIn: number;
    heightIn: number;
    printOnFirstPage: boolean;
    printOnLastPage: boolean;
    regions: LayoutRegion[];
    matchedIdsByPage: Map<number, Set<string>>;
    textSignatures: Array<{ norm: string; x: number }>;
    imageShas: Array<{ sha: string; x: number }>;
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

interface ColumnTrack {
  leftIn: number;
  rightIn: number;
  items: BodyItemBox[];
}

export class V3TablixCompiler {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public compile(input: V3CompileInput): V3CompileOutput {
    if ((input.schemaVersion ?? '2008') === '2008') {
      const compiler2008 = new Rdlc2008LayoutCompiler(this.logger);
      return compiler2008.compile({
        pages: input.pages,
        printableWidthIn: input.pageWidthIn,
        printableHeightIn: input.pageHeightIn,
        fullPageWidthIn: input.fullPageWidthIn ?? input.pageWidthIn,
        fullPageHeightIn: input.fullPageHeightIn ?? input.pageHeightIn,
        marginsIn: input.marginsIn ?? { top: 0, right: 0, bottom: 0, left: 0 },
        dataSetName: input.dataSetName,
        registerEmbeddedImage: input.registerEmbeddedImage,
        nextUniqueName: input.nextUniqueName,
      });
    }

    const {
      pages,
      pageWidthIn,
      pageHeightIn,
      dataSetName,
      pageTablixesByPage,
      coveredByTablixFn,
      paramCtx,
      registerEmbeddedImage,
      nextUniqueName,
    } = input;

    // Stage 1: Expanded Header (top 20%) & Footer (bottom 13%) detection + Hard Body Exclusion
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

    const allFontSizes = pages
      .flatMap((p) => p.regions)
      .filter((r) => r.type === 'text')
      .map((r) => r.style.fontSizePt)
      .sort((a, b) => a - b);
    const bodyMedianFontPt =
      allFontSizes.length > 0 ? allFontSizes[Math.floor(allFontSizes.length / 2)] : 9;

    const bodyTablixes: TablixRegion[] = [];
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

      const isHardExcludedChrome = (r: LayoutRegion): boolean => {
        if (headerExcludedIds.has(r.id) || footerExcludedIds.has(r.id)) return true;
        if (showHeaderOnThisPage && r.y + r.height <= headerOffsetIn + 0.03) return true;
        if (chrome.pageFooter && r.y >= footerCutIn - 0.03) return true;

        if (r.type === 'text' && r.text) {
          const norm = normalizeChromeText(r.text);
          if (
            showHeaderOnThisPage &&
            chrome.pageHeader &&
            r.y <= pageHeightIn * 0.22 &&
            chrome.pageHeader.textSignatures.some(
              (sig) => sig.norm === norm && Math.abs(sig.x - r.x) <= 0.12
            )
          ) {
            return true;
          }
          if (
            chrome.pageFooter &&
            r.y >= pageHeightIn * 0.85 &&
            chrome.pageFooter.textSignatures.some(
              (sig) => sig.norm === norm && Math.abs(sig.x - r.x) <= 0.12
            )
          ) {
            return true;
          }
        }

        if ((r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64) {
          const sha = crypto.createHash('sha256').update(r.imageAssetBase64).digest('hex').slice(0, 12);
          if (
            showHeaderOnThisPage &&
            chrome.pageHeader &&
            r.y <= pageHeightIn * 0.22 &&
            chrome.pageHeader.imageShas.some((s) => s.sha === sha && Math.abs(s.x - r.x) <= 0.12)
          ) {
            return true;
          }
          if (
            chrome.pageFooter &&
            r.y >= pageHeightIn * 0.85 &&
            chrome.pageFooter.imageShas.some((s) => s.sha === sha && Math.abs(s.x - r.x) <= 0.12)
          ) {
            return true;
          }
        }
        return false;
      };

      const bodyItems: BodyItemBox[] = [];
      let rawIdx = 0;

      // Preserve repeating detail Tablixes from TablixBuilder
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

      for (const r of page.regions) {
        if (isHardExcludedChrome(r)) continue;
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

        const isLineRegion = r.type === 'vector_line';
        const minDim = isLineRegion ? 0.005 : 0.015;
        const localY = Math.max(0, r.y - headerOffsetIn);
        const clampedX = clamp(r.x, 0, Math.max(0, pageWidthIn - minDim));
        const clampedW = clamp(r.width, minDim, pageWidthIn - clampedX);
        const clampedH = clamp(r.height, minDim, Math.max(minDim, pageBodyHeightIn - localY));

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

      // Stage 2: Segment page body into semantic sections (never straddling items)
      const segmentedBands = this.segmentBodyIntoSections(
        bodyItems,
        pageBodyHeightIn,
        bodyMedianFontPt
      );

      for (let sIdx = 0; sIdx < segmentedBands.length; sIdx++) {
        const band = segmentedBands[sIdx];
        const isFirstOnNewPage = pNum > 1 && sIdx === 0;
        const secNum = String(sectionSeq++).padStart(2, '0');
        const headingText = band.heading?.region?.text ?? band.items.find((i) => i.tablix)?.tablix?.name ?? `Page${pNum}Band${sIdx + 1}`;
        const slug = makeSectionSlug(headingText, `Page${pNum}Block${sIdx + 1}`);
        const tablixName = sanitizeV3Identifier(`Tablix_${secNum}_${slug}`, `Tablix_${secNum}`);

        const secTopLocal = sIdx === 0 ? 0 : band.topIn;
        const secBottomLocal =
          sIdx === segmentedBands.length - 1
            ? Math.min(pageBodyHeightIn, Math.max(band.bottomIn + 0.04, secTopLocal + 0.25))
            : segmentedBands[sIdx + 1].topIn;
        const secHeight = roundIn(Math.max(0.25, secBottomLocal - secTopLocal));
        const secRdlcTop = roundIn(cumulativeBodyTopIn + secTopLocal);

        const secRelItems: BodyItemBox[] = band.items.map((it) => ({
          ...it,
          y: Math.max(0, it.y - secTopLocal),
          tablix: it.tablix ? { ...it.tablix, topIn: roundIn(Math.max(0, it.y - secTopLocal)) } : undefined,
        }));

        const compiled = this.compileItemsToTablix(
          tablixName,
          secRelItems,
          roundIn(pageWidthIn),
          secHeight,
          0,
          secRdlcTop,
          pNum,
          dataSetName,
          paramCtx,
          registerEmbeddedImage,
          nextUniqueName,
          bodyMedianFontPt,
          isFirstOnNewPage,
          0
        );

        compiled.tablix.slug = slug;
        compiled.tablix.keepTogether = false;
        bodyTablixes.push(compiled.tablix);

        sectionSummaries.push({
          name: compiled.tablix.name,
          slug,
          pageNumber: pNum,
          pageBreakStart: isFirstOnNewPage,
          topIn: compiled.tablix.topIn,
          leftIn: compiled.tablix.leftIn,
          widthIn: compiled.tablix.widthIn,
          heightIn: compiled.tablix.heightIn,
          layoutType: compiled.layoutType,
          archetype: compiled.archetype,
          rowCount: compiled.tablix.rows.length,
          colCount: compiled.tablix.columnWidthsIn.length,
          hasNestedTablixes: compiled.hasNestedTablixes,
          columnCount: compiled.columnCount,
          hasHeaderBand: compiled.hasHeaderBand,
          hasLeftColumn: compiled.columnCount >= 2,
          hasRightColumn: compiled.columnCount >= 2,
          hasFooterBand: compiled.hasFooterBand,
          childItemCount: compiled.childItemCount,
        });
      }

      cumulativeBodyTopIn = roundIn(cumulativeBodyTopIn + pageBodyHeightIn);
    }

    // Strict non-overlap guarantee across sequential body Tablixes on the same page
    for (let i = 0; i < bodyTablixes.length - 1; i++) {
      const prev = bodyTablixes[i];
      const next = bodyTablixes[i + 1];
      if (next.pageBreakBefore || next.pageNumber !== prev.pageNumber) continue;
      const overflow = roundIn(prev.topIn + prev.heightIn - next.topIn);
      if (overflow > 0) {
        const lastRow = prev.rows[prev.rows.length - 1];
        if (lastRow && lastRow.heightIn > overflow + 0.03) {
          lastRow.heightIn = roundIn(lastRow.heightIn - overflow);
          prev.heightIn = roundIn(prev.rows.reduce((s, r) => s + r.heightIn, 0));
        } else {
          prev.heightIn = roundIn(Math.max(0.1, next.topIn - prev.topIn));
        }
        const sumEntry = sectionSummaries[i];
        if (sumEntry) sumEntry.heightIn = prev.heightIn;
      }
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

    this.logger.info('V3TablixCompiler', 'Single-RDLC v3 Full-Tablix compilation complete', {
      hasPageHeader: Boolean(pageHeaderSpec),
      printOnFirstPage: pageHeaderSpec?.printOnFirstPage,
      hasPageFooter: Boolean(pageFooterSpec),
      bodyTablixes: bodyTablixes.length,
      archetypes: {
        A: sectionSummaries.filter((s) => s.archetype === 'A').length,
        B: sectionSummaries.filter((s) => s.archetype === 'B').length,
        C: sectionSummaries.filter((s) => s.archetype === 'C').length,
        D: sectionSummaries.filter((s) => s.archetype === 'D').length,
      },
    });

    return {
      pageHeaderSpec,
      pageFooterSpec,
      bodyTablixes,
      hierarchy,
    };
  }

  private detectRepeatingHeaderFooter(
    pages: LayoutPage[],
    _pageWidthIn: number,
    pageHeightIn: number,
    coveredByTablixFn: (pageNumber: number, x: number, y: number, w: number, h: number) => boolean
  ): DetectedChrome {
    if (pages.length < 2) return {};

    const numPages = pages.length;
    const topBandLimitY = pageHeightIn * 0.20;
    const bottomBandLimitY = pageHeightIn * 0.87;
    const minConsensusAll = Math.max(2, Math.ceil(numPages * 0.6));
    const minConsensusTail = numPages >= 3 ? Math.max(2, Math.ceil((numPages - 1) * 0.6)) : 2;

    // --- HEADER DETECTION (top 20%) ---
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
      if (info.pages.size >= minConsensusTail) consensusTailSigs.add(sig);
    }
    const consensusAllSigs = new Set<string>();
    for (const [sig, info] of headerSigCounts.entries()) {
      if (info.pages.size >= minConsensusAll) consensusAllSigs.add(sig);
    }

    const activeHeaderSigs =
      consensusAllSigs.size >= consensusTailSigs.size ? consensusAllSigs : consensusTailSigs;

    let pageHeader: DetectedChrome['pageHeader'];
    if (activeHeaderSigs.size > 0) {
      const templatePage = pages.find((p) => p.pageNumber >= 2) ?? pages[0];
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
          textSignatures: matchedHeaderRegions
            .filter((r) => r.type === 'text' && r.text)
            .map((r) => ({ norm: normalizeChromeText(r.text!), x: r.x })),
          imageShas: matchedHeaderRegions
            .filter((r) => (r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64)
            .map((r) => ({
              sha: crypto.createHash('sha256').update(r.imageAssetBase64!).digest('hex').slice(0, 12),
              x: r.x,
            })),
        };
      }
    }

    // --- FOOTER DETECTION (bottom 13%) ---
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
        const footerTopIn = roundIn(clamp(minY - 0.015, pageHeightIn * 0.85, pageHeightIn - 0.16));
        const footerHeightIn = roundIn(Math.max(0.16, pageHeightIn - footerTopIn));

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

        pageFooter = {
          topIn: footerTopIn,
          heightIn: footerHeightIn,
          printOnFirstPage: true,
          printOnLastPage: true,
          regions: matchedFooterRegions,
          matchedIdsByPage,
          textSignatures: matchedFooterRegions
            .filter((r) => r.type === 'text' && r.text)
            .map((r) => ({ norm: normalizeChromeText(r.text!), x: r.x })),
          imageShas: matchedFooterRegions
            .filter((r) => (r.type === 'image' || r.type === 'vector_complex') && r.imageAssetBase64)
            .map((r) => ({
              sha: crypto.createHash('sha256').update(r.imageAssetBase64!).digest('hex').slice(0, 12),
              x: r.x,
            })),
        };
      }
    }

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
      width: clamp(r.width, r.type === 'vector_line' ? 0.005 : 0.015, pageWidthIn - clamp(r.x, 0, pageWidthIn - 0.02)),
      height: clamp(
        r.height,
        r.type === 'vector_line' ? 0.005 : 0.015,
        Math.max(r.type === 'vector_line' ? 0.005 : 0.015, bandHeightIn - clamp(r.y - bandTopIn, 0, bandHeightIn))
      ),
      region: r,
      rawIndex: idx,
    }));

    const { rectangles, images, textboxes } = this.emitItemsIntoFlatBoxLayer(
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

    const hasStraddler = (cutY: number): boolean =>
      sorted.some((it) => it.y < cutY - 0.02 && it.y + it.height > cutY + 0.02);

    const candidateCuts: number[] = [];
    // Isolate repeating Tablixes as clean sections
    for (const it of sorted) {
      if (it.kind === 'tablix') {
        const beforeCut = roundIn(Math.max(0, it.y - 0.03));
        const afterCut = roundIn(Math.min(pageBodyHeightIn, it.y + it.height + 0.03));
        if (!hasStraddler(beforeCut)) candidateCuts.push(beforeCut);
        if (!hasStraddler(afterCut)) candidateCuts.push(afterCut);
      }
    }

    let runningBottom = sorted[0].y + sorted[0].height;
    for (let i = 1; i < sorted.length; i++) {
      const it = sorted[i];
      const gap = it.y - runningBottom;
      if (gap >= 0.24) {
        const cutY = roundIn(runningBottom + gap * 0.35);
        if (!hasStraddler(cutY)) candidateCuts.push(cutY);
      }
      // Full-width colored section banner bar (e.g. RIPLAY blue section bars) marks a natural section cut
      if (
        it.kind === 'rect' &&
        it.width >= 4.5 &&
        it.height >= 0.14 &&
        it.height <= 0.45 &&
        it.region?.style.backgroundColor &&
        it.region.style.backgroundColor.toUpperCase() !== '#FFFFFF'
      ) {
        const cutY = roundIn(Math.max(0, it.y - 0.03));
        if (cutY > 0.2 && !hasStraddler(cutY)) candidateCuts.push(cutY);
      }
      if (
        it.kind === 'text' &&
        it.region &&
        gap >= 0.12 &&
        isLikelyHeadingRegion(it.region, bodyMedianFontPt)
      ) {
        const cutY = roundIn(it.y - Math.min(0.05, gap * 0.4));
        if (!hasStraddler(cutY)) candidateCuts.push(cutY);
      }
      runningBottom = Math.max(runningBottom, it.y + it.height);
    }

    const sortedCuts = [...new Set(candidateCuts)].sort((a, b) => a - b);
    const finalCuts: number[] = [];
    let lastCut = Math.max(0, minContentY);
    for (const c of sortedCuts) {
      const nearTablix = sorted.some(
        (it) =>
          it.kind === 'tablix' &&
          (Math.abs(it.y - c) <= 0.08 || Math.abs(it.y + it.height - c) <= 0.08)
      );
      if ((nearTablix || c - lastCut >= 0.42) && maxContentY - c >= 0.25) {
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

      const heading =
        bandItems.find((it) => it.kind === 'text' && it.region && isLikelyHeadingRegion(it.region, bodyMedianFontPt)) ??
        bandItems.find((it) => it.kind === 'text' && it.region?.text);

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

  private detectMultiColumnSplit(
    items: BodyItemBox[],
    sectionW: number,
    sectionH: number
  ): { tracks: ColumnTrack[]; bandTop: number; bandBottom: number } | undefined {
    const contentItems = items.filter((it) => it.kind === 'text' || it.kind === 'image');
    if (contentItems.length < 4) return undefined;

    const nonWideItems = items.filter(
      (it) =>
        (it.kind === 'text' || it.kind === 'image' || it.kind === 'rect') &&
        it.width < sectionW * 0.58
    );
    const wideCrossingItems = items.filter(
      (it) =>
        ((it.kind === 'text' || it.kind === 'image' || it.kind === 'tablix') &&
          it.width >= sectionW * 0.58) ||
        ((it.kind === 'rect' || it.kind === 'line') &&
          it.width >= sectionW * 0.58 &&
          it.height <= 0.85)
    );

    // Find tallest vertical slice free of wide crossing items
    const intervals = wideCrossingItems
      .map((c) => ({ y1: c.y, y2: c.y + c.height }))
      .sort((a, b) => a.y1 - b.y1);
    const slices: Array<{ y1: number; y2: number }> = [];
    let curY = 0;
    for (const iv of intervals) {
      if (iv.y1 - curY >= 0.55) slices.push({ y1: curY, y2: iv.y1 });
      curY = Math.max(curY, iv.y2);
    }
    if (sectionH - curY >= 0.55) slices.push({ y1: curY, y2: sectionH });
    slices.sort((a, b) => b.y2 - b.y1 - (a.y2 - a.y1));

    for (const sl of slices) {
      const sliceItems = nonWideItems.filter((it) => {
        const cy = it.y + it.height / 2;
        return cy >= sl.y1 - 0.01 && cy <= sl.y2 + 0.01;
      });
      const sliceContent = sliceItems.filter((it) => it.kind === 'text' || it.kind === 'image');
      if (sliceContent.length < 4) continue;

      // Project X intervals onto 1D axis
      const xIntervals = sliceItems
        .filter((it) => it.kind === 'text' || it.kind === 'image' || (it.kind === 'rect' && it.width >= 0.3 && it.height >= 0.25))
        .map((it) => ({ x1: it.x, x2: it.x + it.width }))
        .sort((a, b) => a.x1 - b.x1);
      if (xIntervals.length === 0) continue;

      const mergedX: Array<{ x1: number; x2: number }> = [{ ...xIntervals[0] }];
      for (let i = 1; i < xIntervals.length; i++) {
        const cur = xIntervals[i];
        const prev = mergedX[mergedX.length - 1];
        if (cur.x1 <= prev.x2 + 0.09) {
          prev.x2 = Math.max(prev.x2, cur.x2);
        } else {
          mergedX.push({ ...cur });
        }
      }

      if (mergedX.length < 2 || mergedX.length > 4) continue;
      // Validate gutters sit cleanly inside 20%..80% or separate 3-4 card columns
      const allGuttersValid = mergedX.slice(0, -1).every((m, idx) => {
        const next = mergedX[idx + 1];
        const gutterW = next.x1 - m.x2;
        const center = (m.x2 + next.x1) / 2;
        return gutterW >= 0.09 && center >= sectionW * 0.16 && center <= sectionW * 0.84;
      });
      if (!allGuttersValid) continue;

      const tracks: ColumnTrack[] = mergedX.map((m, idx) => {
        const prevEnd = idx === 0 ? 0 : mergedX[idx - 1].x2;
        const nextStart = idx === mergedX.length - 1 ? sectionW : mergedX[idx + 1].x1;
        const leftBound = idx === 0 ? 0 : roundIn((prevEnd + m.x1) / 2);
        const rightBound = idx === mergedX.length - 1 ? sectionW : roundIn((m.x2 + nextStart) / 2);
        return {
          leftIn: roundIn(m.x1),
          rightIn: roundIn(m.x2),
          items: items.filter((it) => {
            const cy = it.y + it.height / 2;
            const cx = it.x + it.width / 2;
            if (cy < sl.y1 - 0.01 || cy > sl.y2 + 0.01) return false;
            if (it.width >= sectionW * 0.62 && it.height <= 0.85) return false;
            return cx >= leftBound - 0.02 && cx <= rightBound + 0.02;
          }),
        };
      });

      const validTracks = tracks.every(
        (tr) => tr.items.filter((i) => i.kind === 'text' || i.kind === 'image').length >= 2
      );
      if (!validTracks) continue;

      const lTop = Math.min(...tracks.map((tr) => Math.min(...tr.items.map((i) => i.y))));
      const lBot = Math.max(...tracks.map((tr) => Math.max(...tr.items.map((i) => i.y + i.height))));
      const span = lBot - lTop;
      if (span < 0.55) continue;

      return {
        tracks,
        bandTop: roundIn(Math.max(sl.y1, lTop - 0.02)),
        bandBottom: roundIn(Math.min(sl.y2, lBot + 0.02)),
      };
    }

    return undefined;
  }

  private tryBuildArchetypeATable(
    tablixName: string,
    items: BodyItemBox[],
    containerW: number,
    containerH: number,
    leftIn: number,
    topIn: number,
    pageNumber: number,
    dataSetName: string,
    paramCtx: ParameterDetectionContext,
    nextUniqueName: (prefix: string) => string,
    pageBreakBefore: boolean
  ): TablixRegion | undefined {
    const allCandidateRects = items.filter(
      (it) =>
        it.kind === 'rect' &&
        it.region &&
        it.height >= 0.12 &&
        it.height <= 1.4 &&
        it.width >= 0.22 &&
        it.width <= containerW + 0.05 &&
        Boolean(it.region.style.backgroundColor || it.region.style.borderColor)
    );
    const allTextItems = items.filter((it) => it.kind === 'text' && it.region?.text);
    const imageItems = items.filter((it) => it.kind === 'image');
    if (allCandidateRects.length < 6 || allTextItems.length < 4 || imageItems.length > 0) return undefined;

    // Identify true multi-column table grid rows (where >= 2 cell rects sit side-by-side) vs an optional full-width top section banner
    const sortedRectsY = [...allCandidateRects].sort((a, b) => a.y - b.y || a.x - b.x);
    let gridMinY = Math.min(...sortedRectsY.map((r) => r.y));
    for (const r of sortedRectsY) {
      const sideBySideCount = allCandidateRects.filter(
        (other) => Math.abs(other.y - r.y) <= 0.08 && other.width <= containerW * 0.72
      ).length;
      if (sideBySideCount >= 2) {
        gridMinY = r.y;
        break;
      }
    }

    const bannerItems = items.filter((it) => it.y + it.height <= gridMinY - 0.025);
    const gridItems = items.filter((it) => it.y + it.height > gridMinY - 0.025);
    const cellRects = gridItems.filter(
      (it) =>
        it.kind === 'rect' &&
        it.region &&
        it.height >= 0.12 &&
        it.height <= 1.4 &&
        it.width >= 0.22 &&
        it.width <= containerW + 0.05 &&
        Boolean(it.region.style.backgroundColor || it.region.style.borderColor)
    );
    const lineItems = gridItems.filter((it) => it.kind === 'line' && it.region);
    const textItems = gridItems.filter((it) => it.kind === 'text' && it.region?.text);
    if (cellRects.length < 6 || textItems.length < 4) return undefined;

    const rawXs: number[] = [];
    const rawYs: number[] = [];
    for (const r of cellRects) {
      rawXs.push(r.x, r.x + r.width);
      rawYs.push(r.y, r.y + r.height);
    }
    const minRectX = Math.min(...rawXs);
    const maxRectX = Math.max(...rawXs);
    const minRectY = Math.min(...rawYs);
    const maxRectY = Math.max(...rawYs);

    const colEdges = clusterValues(rawXs, 0.03).filter((v, idx, arr) => idx === 0 || v - arr[idx - 1] >= 0.12);
    const rowEdges = clusterValues(rawYs, 0.03).filter((v, idx, arr) => idx === 0 || v - arr[idx - 1] >= 0.08);
    if (colEdges.length < 3 || colEdges.length > 21 || rowEdges.length < 3) return undefined;

    // Ensure at least 75% of grid text items lie inside [minRectX..maxRectX] x [minRectY..maxRectY]
    const insideCount = textItems.filter(
      (t) =>
        t.x >= minRectX - 0.05 &&
        t.x + t.width <= maxRectX + 0.05 &&
        t.y >= minRectY - 0.05 &&
        t.y + t.height <= maxRectY + 0.05
    ).length;
    if (insideCount / textItems.length < 0.75) return undefined;

    const fullCols: number[] = [];
    if (colEdges[0] > 0.03) fullCols.push(0);
    fullCols.push(...colEdges);
    if (containerW - colEdges[colEdges.length - 1] > 0.03) fullCols.push(containerW);

    const hasBannerRow = bannerItems.length > 0 && rowEdges[0] >= 0.14;
    const fullRows: number[] = [];
    if (!hasBannerRow && rowEdges[0] > 0.02) fullRows.push(0);
    fullRows.push(...rowEdges);
    if (containerH - rowEdges[rowEdges.length - 1] > 0.02) fullRows.push(containerH);

    const numCols = fullCols.length - 1;
    const numRows = fullRows.length - 1;
    const columnWidthsIn = Array.from({ length: numCols }, (_, c) => Math.max(0.05, roundIn(fullCols[c + 1] - fullCols[c])));

    const findIdx = (edges: number[], val: number): number => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < edges.length; i++) {
        const d = Math.abs(edges[i] - val);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    };

    const findGridLineBorder = (
      x1: number,
      spanX2: number,
      y1: number,
      spanY2: number
    ): { color?: string; widthPt?: number } => {
      for (const ln of lineItems) {
        const lc = ln.region?.style.borderColor ?? ln.region?.style.backgroundColor;
        if (!lc) continue;
        const horizontal = ln.width >= ln.height;
        if (horizontal) {
          const onTopOrBot = Math.abs(ln.y - y1) <= 0.022 || Math.abs(ln.y - spanY2) <= 0.022;
          const overlapX = Math.min(spanX2, ln.x + ln.width) - Math.max(x1, ln.x);
          if (onTopOrBot && overlapX >= Math.min(spanX2 - x1, ln.width) * 0.55) {
            return { color: lc, widthPt: Math.max(0.4, ln.region?.style.borderWidthPt ?? 0.5) };
          }
        } else {
          const onLeftOrRight = Math.abs(ln.x - x1) <= 0.022 || Math.abs(ln.x - spanX2) <= 0.022;
          const overlapY = Math.min(spanY2, ln.y + ln.height) - Math.max(y1, ln.y);
          if (onLeftOrRight && overlapY >= Math.min(spanY2 - y1, ln.height) * 0.55) {
            return { color: lc, widthPt: Math.max(0.4, ln.region?.style.borderWidthPt ?? 0.5) };
          }
        }
      }
      return {};
    };

    const occupied = new Set<string>();
    const rows: TablixRow[] = [];

    if (hasBannerRow) {
      const bannerH = roundIn(Math.max(0.14, rowEdges[0]));
      const flatBanner = this.emitItemsIntoFlatBoxLayer(
        bannerItems,
        containerW,
        bannerH,
        pageNumber,
        paramCtx,
        () => 'EmbeddedGraphic',
        nextUniqueName,
        9,
        { allowMultiLineGrouping: false }
      );
      const bannerCells: TablixCell[] = Array.from({ length: numCols }, (_, cIdx) =>
        cIdx === 0
          ? {
              colIndex: 0,
              rowIndex: 0,
              colSpan: numCols,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Rectangle',
                name: nextUniqueName(`${tablixName}_Banner`),
                rectangles: flatBanner.rectangles,
                images: flatBanner.images,
                textboxes: flatBanner.textboxes,
                tablixes: [],
              },
            }
          : {
              colIndex: cIdx,
              rowIndex: 0,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: true,
              content: { kind: 'Empty', name: nextUniqueName('Empty') },
            }
      );
      rows.push({
        heightIn: bannerH,
        isDetailRow: false,
        pageBreakBefore: pageBreakBefore ? true : undefined,
        cells: bannerCells,
      });
    }

    for (let rIdx = 0; rIdx < numRows; rIdx++) {
      const y1 = fullRows[rIdx];
      const y2 = fullRows[rIdx + 1];
      const rowH = Math.max(0.025, roundIn(y2 - y1));
      const actualRowIdx = rows.length;
      const cells: TablixCell[] = [];

      for (let cIdx = 0; cIdx < numCols; cIdx++) {
        const key = `${rIdx}:${cIdx}`;
        if (occupied.has(key)) {
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

        const x1 = fullCols[cIdx];
        const x2 = fullCols[cIdx + 1];

        const isOutsideGridRects =
          y2 <= minRectY + 0.005 ||
          y1 >= maxRectY - 0.005 ||
          x2 <= minRectX + 0.005 ||
          x1 >= maxRectX - 0.005;

        const matchingRect = isOutsideGridRects
          ? undefined
          : cellRects
              .filter((vr) => {
                const cx = (x1 + x2) / 2;
                const cy = (y1 + y2) / 2;
                return (
                  cx >= vr.x - 0.004 &&
                  cx <= vr.x + vr.width + 0.004 &&
                  cy >= vr.y - 0.004 &&
                  cy <= vr.y + vr.height + 0.004
                );
              })
              .sort((a, b) => a.width * a.height - b.width * b.height)[0];

        let colSpan = 1;
        let rowSpan = 1;
        if (matchingRect) {
          const endC = clamp(findIdx(fullCols, matchingRect.x + matchingRect.width), cIdx + 1, numCols);
          const endR = clamp(findIdx(fullRows, matchingRect.y + matchingRect.height), rIdx + 1, numRows);
          const candCS = endC - cIdx;
          const candRS = endR - rIdx;
          let cleanSpan = true;
          for (let rr = rIdx; rr < rIdx + candRS; rr++) {
            for (let cc = cIdx; cc < cIdx + candCS; cc++) {
              if ((rr !== rIdx || cc !== cIdx) && occupied.has(`${rr}:${cc}`)) cleanSpan = false;
            }
          }
          if (cleanSpan) {
            colSpan = candCS;
            rowSpan = candRS;
          }
        }

        for (let rr = rIdx; rr < rIdx + rowSpan; rr++) {
          for (let cc = cIdx; cc < cIdx + colSpan; cc++) {
            if (rr !== rIdx || cc !== cIdx) occupied.add(`${rr}:${cc}`);
          }
        }

        const spanX2 = fullCols[cIdx + colSpan];
        const spanY2 = fullRows[rIdx + rowSpan];
        const cellTexts = textItems
          .filter((t) => {
            const cx = t.x + t.width / 2;
            const cy = t.y + t.height / 2;
            return cx >= x1 - 0.004 && cx <= spanX2 + 0.004 && cy >= y1 - 0.004 && cy <= spanY2 + 0.004;
          })
          .sort((a, b) => a.y - b.y || a.x - b.x);

        const inferredBorder =
          matchingRect?.region?.style.borderColor
            ? { color: matchingRect.region.style.borderColor, widthPt: matchingRect.region.style.borderWidthPt }
            : !isOutsideGridRects &&
                x1 >= minRectX - 0.02 &&
                spanX2 <= maxRectX + 0.02 &&
                y1 >= minRectY - 0.02 &&
                spanY2 <= maxRectY + 0.02
              ? findGridLineBorder(x1, spanX2, y1, spanY2)
              : {};

        if (cellTexts.length === 0 && !matchingRect && !inferredBorder.color) {
          cells.push({
            colIndex: cIdx,
            rowIndex: actualRowIdx,
            colSpan,
            rowSpan,
            skipBecauseMerged: false,
            content: { kind: 'Empty', name: nextUniqueName('Empty') },
          });
          continue;
        }

        // Group same-Y spans horizontally into logical lines before alignment & paragraph construction
        const groupedCellLines: BodyItemBox[][] = [];
        for (const ct of cellTexts) {
          const curLine = groupedCellLines[groupedCellLines.length - 1];
          if (curLine && Math.abs(ct.y - curLine[0].y) <= 0.045) {
            curLine.push(ct);
          } else {
            groupedCellLines.push([ct]);
          }
        }
        for (const line of groupedCellLines) {
          line.sort((a, b) => a.x - b.x);
        }

        const firstLine = groupedCellLines[0];
        const firstTxt = firstLine?.[0];
        const computeLineAlign = (lineSpans: BodyItemBox[]): 'Left' | 'Center' | 'Right' => {
          if (lineSpans.length === 0) return 'Left';
          const lineLeft = Math.min(...lineSpans.map((t) => t.x));
          const lineRight = Math.max(...lineSpans.map((t) => t.x + t.width));
          const leftPad = lineLeft - x1;
          const rightPad = spanX2 - lineRight;
          if (leftPad >= 0.05 && rightPad >= 0.05 && Math.abs(leftPad - rightPad) <= 0.14) {
            return 'Center';
          }
          return 'Left';
        };
        const detectedAlign = firstLine ? computeLineAlign(firstLine) : 'Left';

        const st: RegionStyle = {
          ...(firstTxt?.region?.style ?? defaultTextStyle(7.5)),
          backgroundColor: matchingRect?.region?.style.backgroundColor ?? firstTxt?.region?.style.backgroundColor,
          borderColor: inferredBorder.color ?? firstTxt?.region?.style.borderColor,
          borderWidthPt: inferredBorder.widthPt ?? firstTxt?.region?.style.borderWidthPt,
          textAlign: detectedAlign,
          verticalAlign: 'Middle',
          paddingPt: { top: 0.5, right: 1, bottom: 0.5, left: 1 },
        };

        const paragraphLines: VisualParagraphSpec[] = groupedCellLines.map((lineSpans, idx) => {
          const mergedRuns: VisualTextRun[] = [];
          let prevSpanEnd = lineSpans[0]?.x ?? 0;
          for (let sIdx = 0; sIdx < lineSpans.length; sIdx++) {
            const ct = lineSpans[sIdx];
            const spanRuns = parameterizeTextRuns(
              paramCtx,
              ct.region?.runs ?? [
                {
                  text: ct.region?.text ?? '',
                  fontFamily: st.fontFamily,
                  fontSizePt: st.fontSizePt,
                  bold: st.bold,
                  italic: st.italic,
                  underline: st.underline,
                  color: st.color,
                },
              ],
              pageNumber
            );
            const gap = sIdx > 0 ? ct.x - prevSpanEnd : 0;
            for (let rIdx = 0; rIdx < spanRuns.length; rIdx++) {
              const r = spanRuns[rIdx];
              const last = mergedRuns[mergedRuns.length - 1];
              const needSpace =
                sIdx > 0 &&
                rIdx === 0 &&
                gap > 0.022 &&
                last &&
                !last.text.endsWith(' ') &&
                !r.text.startsWith(' ');
              if (
                last &&
                last.fontFamily === r.fontFamily &&
                Math.abs(last.fontSizePt - r.fontSizePt) <= 0.3 &&
                last.bold === r.bold &&
                last.italic === r.italic &&
                Boolean(last.underline) === Boolean(r.underline) &&
                last.color === r.color &&
                last.parameterName === r.parameterName
              ) {
                last.text = `${last.text}${needSpace ? ' ' : ''}${r.text}`;
              } else {
                if (needSpace && last && !last.text.endsWith(' ')) {
                  last.text = `${last.text} `;
                }
                mergedRuns.push({ ...r });
              }
            }
            prevSpanEnd = ct.x + ct.width;
          }
          const dy = idx + 1 < groupedCellLines.length ? groupedCellLines[idx + 1][0].y - lineSpans[0].y : 0;
          const lhPt = dy > 0.05 ? Math.round(dy * PT_PER_INCH * 10) / 10 : Math.round(st.fontSizePt * 1.12 * 10) / 10;
          return { runs: mergedRuns, lineHeightPt: lhPt, textAlign: computeLineAlign(lineSpans) };
        });

        cells.push({
          colIndex: cIdx,
          rowIndex: actualRowIdx,
          colSpan,
          rowSpan,
          skipBecauseMerged: false,
          content: {
            kind: 'Textbox',
            name: nextUniqueName('Txt'),
            value: paragraphLines.map((p) => p.runs.map((r) => r.text).join('')).join('\n'),
            runs: paragraphLines[0]?.runs,
            paragraphLines: paragraphLines.length > 0 ? paragraphLines : undefined,
            isExpression: Boolean(paragraphLines[0]?.runs.some((r) => Boolean(r.parameterName))),
            style: st,
            canGrow: false,
          },
        });
      }

      rows.push({
        heightIn: rowH,
        isDetailRow: false,
        pageBreakBefore: actualRowIdx === 0 && pageBreakBefore ? true : undefined,
        cells,
      });
    }

    // Clamp cumulative row height to containerH so Archetype A never overflows into next section
    const targetH = roundIn(Math.max(0.25, containerH));
    let totalRowH = roundIn(rows.reduce((s, r) => s + r.heightIn, 0));
    if (totalRowH > targetH && rows.length > 0) {
      const last = rows[rows.length - 1];
      const trim = roundIn(totalRowH - targetH);
      if (last.heightIn > trim + 0.025) {
        last.heightIn = roundIn(last.heightIn - trim);
      }
      totalRowH = roundIn(rows.reduce((s, r) => s + r.heightIn, 0));
    }

    return {
      id: tablixName,
      name: tablixName,
      pageNumber,
      bandKind: 'Detail',
      archetype: 'A',
      pageBreakBefore,
      topIn: roundIn(topIn),
      leftIn: roundIn(leftIn),
      widthIn: roundIn(columnWidthsIn.reduce((s, w) => s + w, 0)),
      heightIn: totalRowH,
      dataSetName,
      isRepeatingDetail: false,
      columnWidthsIn,
      rows,
      zIndex: 1,
    };
  }

  private tryBuildArchetypeBClauseList(
    tablixName: string,
    items: BodyItemBox[],
    containerW: number,
    containerH: number,
    leftIn: number,
    topIn: number,
    pageNumber: number,
    dataSetName: string,
    paramCtx: ParameterDetectionContext,
    nextUniqueName: (prefix: string) => string,
    pageBreakBefore: boolean
  ): TablixRegion | undefined {
    const hasGraphics = items.some((it) => it.kind === 'image');
    const hasShadedRects = items.some((it) => it.kind === 'rect' && (it.region?.style.backgroundColor || it.region?.style.borderColor));
    if (hasGraphics || hasShadedRects) return undefined;

    const textItems = items
      .filter((it) => it.kind === 'text' && it.region?.text)
      .sort((a, b) => (Math.abs(a.y - b.y) <= 0.04 ? a.x - b.x : a.y - b.y));
    if (textItems.length < 3) return undefined;

    // Pair hanging-indent marker + text OR inline marker prefix lines
    interface ClauseEntry {
      topY: number;
      bottomY: number;
      markerX: number;
      markerText: string;
      markerStyle: RegionStyle;
      bodyX: number;
      bodyLines: BodyItemBox[];
    }

    const clauses: ClauseEntry[] = [];
    const consumed = new Set<number>();

    for (let i = 0; i < textItems.length; i++) {
      if (consumed.has(i)) continue;
      const cur = textItems[i];
      const txt = cur.region!.text!.trim();

      // Case 1: Standalone marker followed by body on same baseline
      if (STANDALONE_MARKER_RE.test(txt) && cur.width <= 0.36 && i + 1 < textItems.length) {
        const nxt = textItems[i + 1];
        if (Math.abs(nxt.y - cur.y) <= 0.045 && nxt.x > cur.x + 0.06 && nxt.x - cur.x <= 0.45) {
          consumed.add(i);
          consumed.add(i + 1);
          const entry: ClauseEntry = {
            topY: Math.min(cur.y, nxt.y),
            bottomY: Math.max(cur.y + cur.height, nxt.y + nxt.height),
            markerX: cur.x,
            markerText: txt,
            markerStyle: cur.region!.style,
            bodyX: nxt.x,
            bodyLines: [nxt],
          };
          // Absorb continuation lines aligned with bodyX
          for (let j = i + 2; j < textItems.length; j++) {
            const cand = textItems[j];
            const cTxt = cand.region!.text!.trim();
            if (STANDALONE_MARKER_RE.test(cTxt) || CLAUSE_PREFIX_RE.test(cTxt)) break;
            if (Math.abs(cand.x - entry.bodyX) <= 0.05 && cand.y - entry.bottomY <= 0.16) {
              consumed.add(j);
              entry.bodyLines.push(cand);
              entry.bottomY = Math.max(entry.bottomY, cand.y + cand.height);
            } else {
              break;
            }
          }
          clauses.push(entry);
          continue;
        }
      }

      // Case 2: Inline bullet/number prefix with continuation lines indented cleanly
      const m = txt.match(CLAUSE_PREFIX_RE);
      if (m) {
        let indentContX: number | undefined;
        const conts: BodyItemBox[] = [];
        let bot = cur.y + cur.height;
        for (let j = i + 1; j < textItems.length; j++) {
          const cand = textItems[j];
          const cTxt = cand.region!.text!.trim();
          if (STANDALONE_MARKER_RE.test(cTxt) || CLAUSE_PREFIX_RE.test(cTxt)) break;
          if (cand.x > cur.x + 0.10 && cand.x <= cur.x + 0.42 && cand.y - bot <= 0.16) {
            if (indentContX === undefined) indentContX = cand.x;
            if (Math.abs(cand.x - indentContX) <= 0.04) {
              conts.push(cand);
              bot = Math.max(bot, cand.y + cand.height);
              continue;
            }
          }
          break;
        }
        if (indentContX !== undefined) {
          consumed.add(i);
          conts.forEach((_, idx) => consumed.add(i + 1 + idx));
          clauses.push({
            topY: cur.y,
            bottomY: bot,
            markerX: cur.x,
            markerText: m[1],
            markerStyle: cur.region!.style,
            bodyX: indentContX,
            bodyLines: [{ ...cur, x: indentContX, region: { ...cur.region!, text: m[2], runs: undefined } }, ...conts],
          });
        }
      }
    }

    if (clauses.length < 2 || consumed.size / textItems.length < 0.7) return undefined;

    const avgMarkerX = roundIn(clauses.reduce((s, c) => s + c.markerX, 0) / clauses.length);
    const avgBodyX = roundIn(clauses.reduce((s, c) => s + c.bodyX, 0) / clauses.length);
    const markerW = Math.max(0.14, roundIn(avgBodyX - avgMarkerX));
    const leadW = avgMarkerX > 0.02 ? roundIn(avgMarkerX) : 0;
    const bodyW = Math.max(0.5, roundIn(containerW - leadW - markerW));
    const columnWidthsIn = leadW > 0 ? [leadW, markerW, bodyW] : [markerW, bodyW];

    const rows: TablixRow[] = [];
    let curTop = 0;

    for (let idx = 0; idx < clauses.length; idx++) {
      const cl = clauses[idx];
      if (cl.topY - curTop > 0.04) {
        rows.push({
          heightIn: roundIn(cl.topY - curTop),
          isDetailRow: false,
          pageBreakBefore: rows.length === 0 && pageBreakBefore ? true : undefined,
          cells: columnWidthsIn.map((_, cIdx) => ({
            colIndex: cIdx,
            rowIndex: rows.length,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: false,
            content: { kind: 'Empty', name: nextUniqueName('Empty') },
          })),
        });
      }

      const nextTop = idx + 1 < clauses.length ? clauses[idx + 1].topY : Math.max(cl.bottomY, containerH);
      const rowH = Math.max(0.14, roundIn(Math.min(nextTop, Math.max(cl.bottomY + 0.03, cl.topY + 0.14)) - cl.topY));
      const rowCells: TablixCell[] = [];
      let colOffset = 0;

      if (leadW > 0) {
        rowCells.push({
          colIndex: 0,
          rowIndex: rows.length,
          colSpan: 1,
          rowSpan: 1,
          skipBecauseMerged: false,
          content: { kind: 'Empty', name: nextUniqueName('Empty') },
        });
        colOffset = 1;
      }

      rowCells.push({
        colIndex: colOffset,
        rowIndex: rows.length,
        colSpan: 1,
        rowSpan: 1,
        skipBecauseMerged: false,
        content: {
          kind: 'Textbox',
          name: nextUniqueName('Txt'),
          value: cl.markerText,
          isExpression: false,
          style: {
            ...cl.markerStyle,
            backgroundColor: undefined,
            borderColor: undefined,
            verticalAlign: 'Top',
            paddingPt: { top: 0, right: 1, bottom: 0, left: 0 },
          },
          canGrow: true,
        },
      });

      const paragraphLines: VisualParagraphSpec[] = cl.bodyLines.map((ln, lIdx) => {
        const baseRuns = ln.region?.runs ?? [
          {
            text: ln.region?.text ?? '',
            fontFamily: ln.region!.style.fontFamily,
            fontSizePt: ln.region!.style.fontSizePt,
            bold: ln.region!.style.bold,
            italic: ln.region!.style.italic,
            underline: ln.region!.style.underline,
            color: ln.region!.style.color,
          },
        ];
        const runs = parameterizeTextRuns(paramCtx, baseRuns, pageNumber);
        const dy = lIdx + 1 < cl.bodyLines.length ? cl.bodyLines[lIdx + 1].y - ln.y : 0;
        const lhPt = dy > 0.05 ? Math.round(dy * PT_PER_INCH * 10) / 10 : Math.round(ln.region!.style.fontSizePt * 1.12 * 10) / 10;
        return { runs, lineHeightPt: lhPt, textAlign: ln.region!.style.textAlign };
      });

      rowCells.push({
        colIndex: colOffset + 1,
        rowIndex: rows.length,
        colSpan: 1,
        rowSpan: 1,
        skipBecauseMerged: false,
        content: {
          kind: 'Textbox',
          name: nextUniqueName('Txt'),
          value: cl.bodyLines.map((l) => l.region?.text ?? '').join('\n'),
          runs: paragraphLines[0]?.runs,
          paragraphLines,
          isExpression: paragraphLines.some((p) => p.runs.some((r) => Boolean(r.parameterName))),
          style: {
            ...cl.bodyLines[0].region!.style,
            backgroundColor: undefined,
            borderColor: undefined,
            verticalAlign: 'Top',
            paddingPt: { top: 0, right: 1, bottom: 0, left: 0 },
          },
          canGrow: true,
        },
      });

      rows.push({
        heightIn: rowH,
        isDetailRow: false,
        pageBreakBefore: rows.length === 0 && pageBreakBefore ? true : undefined,
        cells: rowCells,
      });
      curTop = cl.topY + rowH;
    }

    return {
      id: tablixName,
      name: tablixName,
      pageNumber,
      bandKind: 'Notes',
      archetype: 'B',
      pageBreakBefore,
      topIn: roundIn(topIn),
      leftIn: roundIn(leftIn),
      widthIn: roundIn(columnWidthsIn.reduce((s, w) => s + w, 0)),
      heightIn: roundIn(rows.reduce((s, r) => s + r.heightIn, 0)),
      dataSetName,
      isRepeatingDetail: false,
      columnWidthsIn,
      rows,
      zIndex: 1,
    };
  }

  private compileItemsToTablix(
    tablixName: string,
    items: BodyItemBox[],
    containerW: number,
    containerH: number,
    leftIn: number,
    topIn: number,
    pageNumber: number,
    dataSetName: string,
    paramCtx: ParameterDetectionContext,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    bodyMedianFontPt: number,
    pageBreakBefore: boolean,
    depth: number
  ): {
    tablix: TablixRegion;
    archetype: TablixArchetype;
    layoutType: LayoutSectionSummary['layoutType'];
    hasNestedTablixes: boolean;
    columnCount: number;
    hasHeaderBand: boolean;
    hasFooterBand: boolean;
    childItemCount: number;
  } {
    // 0. Repeating detail Tablix directly preserved
    const repeatingTbl = items.find((i) => i.kind === 'tablix' && i.tablix?.isRepeatingDetail)?.tablix;
    if (repeatingTbl && items.filter((i) => i.kind === 'text' || i.kind === 'image').length <= 1) {
      const cloned: TablixRegion = {
        ...repeatingTbl,
        id: tablixName,
        name: tablixName,
        archetype: 'A',
        pageBreakBefore,
        topIn: roundIn(topIn + repeatingTbl.topIn),
        rows: repeatingTbl.rows.map((r, rIdx) => ({
          ...r,
          pageBreakBefore: rIdx === 0 && pageBreakBefore ? true : undefined,
        })),
      };
      return {
        tablix: cloned,
        archetype: 'A',
        layoutType: 'Tablix',
        hasNestedTablixes: false,
        columnCount: cloned.columnWidthsIn.length,
        hasHeaderBand: false,
        hasFooterBand: false,
        childItemCount: cloned.rows.length,
      };
    }

    // 1. Archetype C: 2-, 3-, or 4-column split with nested sub-Tablixes
    if (depth < 3) {
      const multiCol = this.detectMultiColumnSplit(items, containerW, containerH);
      if (multiCol) {
        const { tracks, bandTop, bandBottom } = multiCol;
        const headerItems = items.filter((it) => it.y + it.height / 2 < bandTop - 0.01);
        const footerItems = items
          .filter((it) => it.y + it.height / 2 > bandBottom + 0.01)
          .map((it) => ({
            ...it,
            y: Math.max(0, it.y - bandBottom),
            tablix: it.tablix ? { ...it.tablix, topIn: roundIn(Math.max(0, it.tablix.topIn - bandBottom)) } : undefined,
          }));

        // Build columns [LeadSpacer?, Col0, Gutter01, Col1, ... TrailSpacer?]
        const colDefs: Array<{ kind: 'spacer' | 'track'; trackIdx?: number; left: number; width: number }> = [];
        let cursorX = 0;
        tracks.forEach((tr, idx) => {
          if (tr.leftIn - cursorX >= 0.02) {
            colDefs.push({ kind: 'spacer', left: roundIn(cursorX), width: roundIn(tr.leftIn - cursorX) });
          }
          const trackW = Math.max(0.25, roundIn(tr.rightIn - tr.leftIn));
          colDefs.push({ kind: 'track', trackIdx: idx, left: roundIn(tr.leftIn), width: trackW });
          cursorX = tr.leftIn + trackW;
        });
        if (containerW - cursorX >= 0.02) {
          colDefs.push({ kind: 'spacer', left: roundIn(cursorX), width: roundIn(containerW - cursorX) });
        }

        const totalCols = colDefs.length;
        const columnWidthsIn = colDefs.map((c) => c.width);
        const rows: TablixRow[] = [];

        if (bandTop >= 0.03) {
          if (headerItems.length > 0) {
            const headerSub = this.compileItemsToTablix(
              `${tablixName}_HeaderSub`,
              headerItems,
              containerW,
              bandTop,
              0,
              0,
              pageNumber,
              dataSetName,
              paramCtx,
              registerEmbeddedImage,
              nextUniqueName,
              bodyMedianFontPt,
              false,
              depth + 1
            );
            const cells: TablixCell[] = colDefs.map((_, cIdx) =>
              cIdx === 0
                ? {
                    colIndex: 0,
                    rowIndex: rows.length,
                    colSpan: totalCols,
                    rowSpan: 1,
                    skipBecauseMerged: false,
                    content: { kind: 'Tablix', name: headerSub.tablix.name, tablix: headerSub.tablix },
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
              heightIn: roundIn(bandTop),
              isDetailRow: false,
              pageBreakBefore: pageBreakBefore ? true : undefined,
              cells,
            });
          } else {
            const spacerCells: TablixCell[] = colDefs.map((_, cIdx) => ({
              colIndex: cIdx,
              rowIndex: rows.length,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: { kind: 'Empty', name: nextUniqueName('Empty') },
            }));
            rows.push({
              heightIn: roundIn(bandTop),
              isDetailRow: false,
              pageBreakBefore: pageBreakBefore ? true : undefined,
              cells: spacerCells,
            });
          }
        }

        const colH = roundIn(Math.max(0.25, bandBottom - bandTop));
        const trackRowCells: TablixCell[] = colDefs.map((cd, cIdx) => {
          if (cd.kind === 'spacer' || cd.trackIdx === undefined) {
            return {
              colIndex: cIdx,
              rowIndex: rows.length,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: { kind: 'Empty', name: nextUniqueName('Empty') },
            };
          }
          const tr = tracks[cd.trackIdx];
          const relItems = tr.items.map((it) => ({
            ...it,
            x: Math.max(0, it.x - cd.left),
            y: Math.max(0, it.y - bandTop),
            tablix: it.tablix
              ? { ...it.tablix, leftIn: roundIn(Math.max(0, it.tablix.leftIn - cd.left)), topIn: roundIn(Math.max(0, it.y - bandTop)) }
              : undefined,
          }));
          const sub = this.compileItemsToTablix(
            `${tablixName}_Col${cd.trackIdx + 1}`,
            relItems,
            cd.width,
            colH,
            0,
            0,
            pageNumber,
            dataSetName,
            paramCtx,
            registerEmbeddedImage,
            nextUniqueName,
            bodyMedianFontPt,
            false,
            depth + 1
          );
          return {
            colIndex: cIdx,
            rowIndex: rows.length,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: false,
            content: { kind: 'Tablix', name: sub.tablix.name, tablix: sub.tablix },
          };
        });
        rows.push({
          heightIn: colH,
          isDetailRow: false,
          pageBreakBefore: rows.length === 0 && pageBreakBefore ? true : undefined,
          cells: trackRowCells,
        });

        const footH = roundIn(Math.max(0.15, containerH - bandBottom));
        if (footerItems.length > 0 && footH >= 0.15) {
          const footerSub = this.compileItemsToTablix(
            `${tablixName}_FooterSub`,
            footerItems,
            containerW,
            footH,
            0,
            0,
            pageNumber,
            dataSetName,
            paramCtx,
            registerEmbeddedImage,
            nextUniqueName,
            bodyMedianFontPt,
            false,
            depth + 1
          );
          const cells: TablixCell[] = colDefs.map((_, cIdx) =>
            cIdx === 0
              ? {
                  colIndex: 0,
                  rowIndex: rows.length,
                  colSpan: totalCols,
                  rowSpan: 1,
                  skipBecauseMerged: false,
                  content: { kind: 'Tablix', name: footerSub.tablix.name, tablix: footerSub.tablix },
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
          rows.push({ heightIn: footH, isDetailRow: false, cells });
        }

        const tablix: TablixRegion = {
          id: tablixName,
          name: tablixName,
          pageNumber,
          bandKind: 'Detail',
          archetype: 'C',
          pageBreakBefore,
          topIn: roundIn(topIn),
          leftIn: roundIn(leftIn),
          widthIn: roundIn(columnWidthsIn.reduce((s, w) => s + w, 0)),
          heightIn: roundIn(rows.reduce((s, r) => s + r.heightIn, 0)),
          dataSetName,
          isRepeatingDetail: false,
          columnWidthsIn,
          rows,
          zIndex: 1,
        };
        return {
          tablix,
          archetype: 'C',
          layoutType: tracks.length === 2 ? 'Dual-Column' : 'Multi-Column',
          hasNestedTablixes: true,
          columnCount: tracks.length,
          hasHeaderBand: headerItems.length > 0,
          hasFooterBand: footerItems.length > 0,
          childItemCount: tracks.length + (headerItems.length > 0 ? 1 : 0) + (footerItems.length > 0 ? 1 : 0),
        };
      }
    }

    // 2. Archetype A: Bordered multi-column grid (2..20 cols, including 12-col benefit schedule)
    const archATable = this.tryBuildArchetypeATable(
      tablixName,
      items,
      containerW,
      containerH,
      leftIn,
      topIn,
      pageNumber,
      dataSetName,
      paramCtx,
      nextUniqueName,
      pageBreakBefore
    );
    if (archATable) {
      return {
        tablix: archATable,
        archetype: 'A',
        layoutType: 'Tablix',
        hasNestedTablixes: false,
        columnCount: archATable.columnWidthsIn.length,
        hasHeaderBand: false,
        hasFooterBand: false,
        childItemCount: archATable.rows.length,
      };
    }

    // 3. Archetype B: Hanging-indent clause list
    const archBList = this.tryBuildArchetypeBClauseList(
      tablixName,
      items,
      containerW,
      containerH,
      leftIn,
      topIn,
      pageNumber,
      dataSetName,
      paramCtx,
      nextUniqueName,
      pageBreakBefore
    );
    if (archBList) {
      return {
        tablix: archBList,
        archetype: 'B',
        layoutType: 'Clause-List',
        hasNestedTablixes: false,
        columnCount: archBList.columnWidthsIn.length,
        hasHeaderBand: false,
        hasFooterBand: false,
        childItemCount: archBList.rows.length,
      };
    }

    // 4. Archetype D vs Clean Flowing Archetype A
    const flat = this.emitItemsIntoFlatBoxLayer(
      items,
      containerW,
      containerH,
      pageNumber,
      paramCtx,
      registerEmbeddedImage,
      nextUniqueName,
      bodyMedianFontPt,
      { allowMultiLineGrouping: true }
    );

    const hasImages = flat.images.length > 0;
    const hasRects = flat.rectangles.length > 0;
    const canEmitPureSingleColRows =
      !hasImages &&
      !hasRects &&
      flat.tablixes.length === 0 &&
      flat.textboxes.length > 0 &&
      this.canStackTextboxesWithoutXOverlap(flat.textboxes);

    if (canEmitPureSingleColRows) {
      const sortedTbs = [...flat.textboxes].sort((a, b) => a.topIn - b.topIn || a.leftIn - b.leftIn);
      const colLefts = clusterValues(sortedTbs.map((t) => t.leftIn), 0.04);
      const leadX = colLefts.length === 1 && colLefts[0] > 0.02 ? colLefts[0] : 0;
      const columnWidthsIn = leadX > 0 ? [roundIn(leadX), roundIn(Math.max(0.2, containerW - leadX))] : [roundIn(containerW)];
      const rows: TablixRow[] = [];
      let curY = 0;

      for (let i = 0; i < sortedTbs.length; i++) {
        const tb = sortedTbs[i];
        if (tb.topIn - curY > 0.03) {
          rows.push({
            heightIn: roundIn(tb.topIn - curY),
            isDetailRow: false,
            pageBreakBefore: rows.length === 0 && pageBreakBefore ? true : undefined,
            cells: columnWidthsIn.map((_, cIdx) => ({
              colIndex: cIdx,
              rowIndex: rows.length,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: { kind: 'Empty', name: nextUniqueName('Empty') },
            })),
          });
          curY = tb.topIn;
        }
        const nextTop = i + 1 < sortedTbs.length ? sortedTbs[i + 1].topIn : containerH;
        const maxAvailH = Math.max(0.06, containerH - curY);
        const rowH = clamp(
          roundIn(Math.max(tb.heightIn, Math.min(nextTop, tb.topIn + tb.heightIn + 0.04)) - curY),
          Math.min(0.08, maxAvailH),
          maxAvailH
        );
        const rowCells: TablixCell[] = [];
        if (leadX > 0) {
          rowCells.push({
            colIndex: 0,
            rowIndex: rows.length,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: false,
            content: { kind: 'Empty', name: nextUniqueName('Empty') },
          });
        }
        rowCells.push({
          colIndex: leadX > 0 ? 1 : 0,
          rowIndex: rows.length,
          colSpan: 1,
          rowSpan: 1,
          skipBecauseMerged: false,
          content: {
            kind: 'Textbox',
            name: tb.name,
            value: tb.text,
            runs: tb.runs,
            paragraphLines: tb.paragraphLines,
            isExpression: Boolean(tb.runs?.some((r) => Boolean(r.parameterName))),
            style: tb.style,
            canGrow: false,
          },
        });
        rows.push({
          heightIn: rowH,
          isDetailRow: false,
          pageBreakBefore: rows.length === 0 && pageBreakBefore ? true : undefined,
          cells: rowCells,
        });
        curY += rowH;
      }

      const tablix: TablixRegion = {
        id: tablixName,
        name: tablixName,
        pageNumber,
        bandKind: 'Detail',
        archetype: 'A',
        pageBreakBefore,
        topIn: roundIn(topIn),
        leftIn: roundIn(leftIn),
        widthIn: roundIn(columnWidthsIn.reduce((s, w) => s + w, 0)),
        heightIn: roundIn(rows.reduce((s, r) => s + r.heightIn, 0)),
        dataSetName,
        isRepeatingDetail: false,
        columnWidthsIn,
        rows,
        zIndex: 1,
      };
      return {
        tablix,
        archetype: 'A',
        layoutType: 'Single-Column',
        hasNestedTablixes: false,
        columnCount: 1,
        hasHeaderBand: false,
        hasFooterBand: false,
        childItemCount: rows.length,
      };
    }

    // Archetype D (or coordinate-locked single-cell Tablix wrapper containing native rects, images, and non-overlapping textboxes)
    const archetype: TablixArchetype = hasImages || hasRects ? 'D' : 'A';
    const cellRectName = `${tablixName}_Canvas`;
    const rowH = roundIn(Math.max(0.25, containerH));
    const cellTablix: TablixRegion = {
      id: tablixName,
      name: tablixName,
      pageNumber,
      bandKind: 'Detail',
      archetype,
      pageBreakBefore,
      topIn: roundIn(topIn),
      leftIn: roundIn(leftIn),
      widthIn: roundIn(containerW),
      heightIn: rowH,
      dataSetName,
      isRepeatingDetail: false,
      columnWidthsIn: [roundIn(containerW)],
      rows: [
        {
          heightIn: rowH,
          isDetailRow: false,
          pageBreakBefore: pageBreakBefore ? true : undefined,
          cells: [
            {
              colIndex: 0,
              rowIndex: 0,
              colSpan: 1,
              rowSpan: 1,
              skipBecauseMerged: false,
              content: {
                kind: 'Rectangle',
                name: cellRectName,
                rectangles: flat.rectangles,
                images: flat.images,
                textboxes: flat.textboxes,
                tablixes: flat.tablixes,
              },
            },
          ],
        },
      ],
      zIndex: 1,
    };

    return {
      tablix: cellTablix,
      archetype,
      layoutType: archetype === 'D' ? 'Hybrid-Callout' : 'Single-Column',
      hasNestedTablixes: flat.tablixes.length > 0,
      columnCount: 1,
      hasHeaderBand: false,
      hasFooterBand: false,
      childItemCount: flat.rectangles.length + flat.images.length + flat.textboxes.length + flat.tablixes.length,
    };
  }

  private canStackTextboxesWithoutXOverlap(tbs: VisualTextboxItem[]): boolean {
    const sorted = [...tbs].sort((a, b) => a.topIn - b.topIn || a.leftIn - b.leftIn);
    for (let i = 1; i < sorted.length; i++) {
      // If two items are on the same Y line side-by-side, single-column stacking is not appropriate
      if (sorted[i].topIn < sorted[i - 1].topIn + sorted[i - 1].heightIn - 0.015) {
        return false;
      }
    }
    return true;
  }

  private emitItemsIntoFlatBoxLayer(
    items: BodyItemBox[],
    containerW: number,
    containerH: number,
    pageNumber: number,
    paramCtx: ParameterDetectionContext,
    registerEmbeddedImage: (base64Data: string, preferredName: string) => string,
    nextUniqueName: (prefix: string) => string,
    bodyMedianFontPt: number,
    opts: { allowMultiLineGrouping: boolean; normalizeFooterExpressions?: boolean }
  ): {
    rectangles: VisualRectItem[];
    images: VisualImageItem[];
    textboxes: VisualTextboxItem[];
    tablixes: TablixRegion[];
  } {
    const orderedItems = [...items].sort((a, b) => a.rawIndex - b.rawIndex);
    const orderedRects: VisualRectItem[] = [];
    const images: VisualImageItem[] = [];
    const tablixes: TablixRegion[] = [];
    const textItems: BodyItemBox[] = [];

    for (const it of orderedItems) {
      if (it.kind === 'tablix' && it.tablix) {
        tablixes.push({ ...it.tablix, zIndex: 1 });
        continue;
      }
      if ((it.kind === 'rect' || it.kind === 'line') && it.region) {
        const r = it.region;
        const minDim = it.kind === 'line' ? 0.005 : 0.015;
        const x1 = clamp(it.x, 0, Math.max(0, containerW - minDim));
        const y1 = clamp(it.y, 0, Math.max(0, containerH - minDim));
        let w = roundIn(clamp(it.width, minDim, containerW - x1));
        let h = roundIn(clamp(it.height, minDim, containerH - y1));

        if (it.kind === 'line') {
          const horizontal = r.width >= r.height;
          if (horizontal) {
            if (w < 0.04) continue;
            h = Math.max(0.005, h);
          } else {
            if (h < 0.04) continue;
            w = Math.max(0.005, w);
          }
          const lineColor = r.style.borderColor ?? r.style.backgroundColor ?? '#CBD5E1';
          orderedRects.push({
            kind: 'Rectangle',
            name: nextUniqueName('LineRect'),
            leftIn: roundIn(x1),
            topIn: roundIn(y1),
            widthIn: roundIn(Math.min(w, containerW - x1)),
            heightIn: roundIn(Math.min(h, containerH - y1)),
            backgroundColor: lineColor,
            borderWidthPt: r.style.borderWidthPt ?? 0.5,
            zIndex: 0,
            role: 'line',
          });
          continue;
        }

        const bg = r.style.backgroundColor;
        const bc = r.style.borderColor;
        if (!bg && !bc) continue;
        orderedRects.push({
          kind: 'Rectangle',
          name: nextUniqueName('Rect'),
          leftIn: roundIn(x1),
          topIn: roundIn(y1),
          widthIn: w,
          heightIn: h,
          backgroundColor: bg,
          borderColor: bc,
          borderWidthPt: bc ? Math.max(0.4, r.style.borderWidthPt ?? 0.75) : undefined,
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
        const isVectorCrop = it.region.type === 'vector_complex';
        const overlapsText = items.some(
          (other) =>
            other.kind === 'text' &&
            other.x < x1 + w &&
            other.x + other.width > x1 &&
            other.y < y1 + h &&
            other.y + other.height > y1
        );
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
          sizing: isGlyphCrop || (isVectorCrop && overlapsText) ? 'Fit' : 'FitProportional',
          zIndex: overlapsText ? 0 : isGlyphCrop ? 2 : 1,
        });
        continue;
      }

      if (it.kind === 'text' && it.region?.text && it.region.text.trim().length > 0) {
        textItems.push(it);
      }
    }

    // Deduplicate only consecutive identical rects so PDF z-order is never reordered
    const rectangles: VisualRectItem[] = [];
    for (const rect of orderedRects) {
      const prev = rectangles[rectangles.length - 1];
      if (
        prev &&
        prev.role === rect.role &&
        Math.abs(prev.leftIn - rect.leftIn) <= 0.01 &&
        Math.abs(prev.topIn - rect.topIn) <= 0.01 &&
        Math.abs(prev.widthIn - rect.widthIn) <= 0.015 &&
        Math.abs(prev.heightIn - rect.heightIn) <= 0.015 &&
        (!rect.backgroundColor || !prev.backgroundColor || prev.backgroundColor === rect.backgroundColor)
      ) {
        rectangles[rectangles.length - 1] = {
          ...prev,
          backgroundColor: rect.backgroundColor ?? prev.backgroundColor,
          borderColor: rect.borderColor ?? prev.borderColor,
          borderWidthPt: rect.borderWidthPt ?? prev.borderWidthPt,
        };
      } else {
        rectangles.push(rect);
      }
    }

    textItems.sort((a, b) => (Math.abs(a.y - b.y) <= 0.045 ? a.x - b.x : a.y - b.y));
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
      const curTextH = Math.min(it.height, (r.style.fontSizePt / PT_PER_INCH) * 1.08);
      const idealH = Math.max(it.height, (r.style.fontSizePt / PT_PER_INCH) * 1.15);
      for (let j = 0; j < textItems.length; j++) {
        if (j === i) continue;
        const sib = textItems[j];
        const sibFontPt = sib.region?.style.fontSizePt ?? r.style.fontSizePt;
        const sibTextH = Math.min(sib.height, (sibFontPt / PT_PER_INCH) * 1.08);
        const vertOverlap = Math.min(relY + curTextH, sib.y + sibTextH) - Math.max(relY, sib.y);
        if (sib.x >= relX + it.width * 0.45 && vertOverlap > 0.015) {
          nextLeft = Math.min(nextLeft, sib.x - 0.01);
          if (Math.abs(sib.y - it.y) <= 0.045) hasRightSibling = true;
        }
      }

      let precedingLabel: string | undefined;
      let hasLeftSibling = false;
      if (i > 0) {
        const prev = textItems[i - 1];
        if (Math.abs(prev.y - it.y) <= 0.045 && prev.x < it.x) {
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

      const align = r.style.textAlign ?? 'Left';
      if (align === 'Left') {
        relX = Math.max(0, relX - 1 / PT_PER_INCH);
      } else if (align === 'Center') {
        relX = Math.max(0, relX - Math.min(0.04, relX));
      } else if (align === 'Right') {
        relX = Math.max(0, relX - Math.min(0.06, relX));
      }
      const colRemaining = Math.max(0.06, nextLeft - relX);
      const paddedW = it.width * 1.06 + 0.08;
      const boxW = clamp(paddedW, 0.06, colRemaining);

      // Compute non-overlapping vertical clearance below this box
      let nextBelowTop = containerH;
      for (let j = i + 1; j < textItems.length; j++) {
        const below = textItems[j];
        if (below.y <= relY + 0.025) continue;
        if (below.x < relX + boxW && below.x + below.width > relX) {
          nextBelowTop = Math.min(nextBelowTop, below.y - 0.004);
          break;
        }
      }

      const maxNoOverlapH =
        nextBelowTop < containerH
          ? Math.max(0.06, nextBelowTop - relY)
          : Math.max((r.style.fontSizePt / PT_PER_INCH) * 1.02, containerH - relY);
      const boxH = clamp(Math.min(idealH, maxNoOverlapH), 0.06, Math.max(0.06, containerH - relY));

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
          finalRuns = [{ ...baseRuns[0], text: expr }];
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

    if (!opts.allowMultiLineGrouping || singleLineBoxes.length <= 1) {
      return {
        rectangles,
        images,
        textboxes: singleLineBoxes.map((s) => s.tb),
        tablixes,
      };
    }

    // Group consecutive wrapped paragraph lines into multi-Paragraph Textboxes with 96% calibrated LineHeight
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

          const maxPitch = Math.max(0.22, (prevEntry.tb.style.fontSizePt / PT_PER_INCH) * 1.85);
          if (dy > maxPitch + 0.04) break;
          if (dy < 0.065) continue;

          if (cand.isDynamicExpr || cand.hasLeftSibling || cand.hasRightSibling) continue;
          if (Math.abs(cand.tb.leftIn - anchor.tb.leftIn) > 0.045) continue;
          if (cand.tb.style.fontFamily !== anchor.tb.style.fontFamily) continue;
          if (Math.abs(cand.tb.style.fontSizePt - anchor.tb.style.fontSizePt) > 0.5) continue;
          if (cand.tb.style.textAlign !== anchor.tb.style.textAlign) continue;
          if (isLikelyHeadingRegion(cand.region, bodyMedianFontPt)) continue;
          if (isBulletStart(cand.tb.text)) continue;

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
          } else if (Math.abs(dy - basePitch) > 0.025) {
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
        const rawPitchPt = avgPitchIn * PT_PER_INCH;
        const calibratedLhPt = Math.round(rawPitchPt * 10) / 10;
        const leftIn = Math.min(...chain.map((c) => c.tb.leftIn));
        const rightIn = Math.max(...chain.map((c) => c.tb.leftIn + c.tb.widthIn));
        const maxWidth = clamp(rightIn - leftIn, 0.1, containerW - leftIn);

        let nextBelowTop = containerH;
        for (let j = 0; j < singleLineBoxes.length; j++) {
          if (consumed.has(j)) continue;
          const other = singleLineBoxes[j].tb;
          if (other.topIn > last.topIn + 0.01 && other.leftIn < leftIn + maxWidth && other.leftIn + other.widthIn > leftIn) {
            nextBelowTop = Math.min(nextBelowTop, other.topIn - 0.004);
            break;
          }
        }
        const totalH = clamp(
          Math.min(last.topIn - first.topIn + last.heightIn + 0.01, nextBelowTop - first.topIn),
          first.heightIn,
          Math.max(first.heightIn, containerH - first.topIn)
        );

        const paragraphLines: VisualParagraphSpec[] = chain.map((c) => ({
          runs: c.tb.runs ?? [],
          lineHeightPt: calibratedLhPt,
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
            lineHeightPt: calibratedLhPt,
          },
          canGrow: false,
          zIndex: 1,
        });
      }
    }

    // Deterministic non-overlap guarantee across all grouped textboxes
    const sortedOut = [...groupedTextboxes].sort((a, b) => a.topIn - b.topIn || a.leftIn - b.leftIn);
    for (let i = 0; i < sortedOut.length; i++) {
      const a = sortedOut[i];
      for (let j = i + 1; j < sortedOut.length; j++) {
        const b = sortedOut[j];
        if (b.topIn >= a.topIn + a.heightIn - 0.015) break;
        const ox = Math.min(a.leftIn + a.widthIn, b.leftIn + b.widthIn) - Math.max(a.leftIn, b.leftIn);
        const oy = Math.min(a.topIn + a.heightIn, b.topIn + b.heightIn) - Math.max(a.topIn, b.topIn);
        if (ox > 0.015 && oy > 0.015) {
          if (b.leftIn > a.leftIn + 0.05 && a.leftIn + a.widthIn > b.leftIn) {
            a.widthIn = roundIn(Math.max(0.06, b.leftIn - a.leftIn - 0.008));
          } else if (a.leftIn > b.leftIn + 0.05 && b.leftIn + b.widthIn > a.leftIn) {
            b.widthIn = roundIn(Math.max(0.06, a.leftIn - b.leftIn - 0.008));
          } else if (b.topIn > a.topIn + 0.02) {
            a.heightIn = roundIn(Math.max(0.05, b.topIn - a.topIn - 0.006));
          }
        }
      }
    }

    return {
      rectangles,
      images,
      textboxes: sortedOut,
      tablixes,
    };
  }
}
