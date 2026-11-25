import fs from 'fs';
import fontkit from '@pdf-lib/fontkit';
import { XMLParser } from 'fast-xml-parser';
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { StructuredLogger } from '../core/types.ts';

export interface RdlcPreviewCollision {
  page: number;
  container: string;
  itemA: string;
  itemB: string;
  overlapCm: string;
}

export interface RdlcPreviewResult {
  html: string;
  pageCount: number;
  pageWidth: string;
  pageHeight: string;
  stats: {
    rectangles: number;
    tablixes: number;
    mergedCells: number;
    textboxes: number;
    images: number;
    embeddedImages: number;
    parameters: number;
  };
  collisions: RdlcPreviewCollision[];
}

export interface RdlcRenderOptions {
  title?: string;
  sampleFields?: Record<string, unknown>;
  parameterOverrides?: Record<string, string>;
}

export interface RdlcParameterDescriptor {
  name: string;
  dataType: string;
  prompt: string;
  defaultValue: string;
}

interface OrderedNode {
  [tag: string]: unknown;
  ':@'?: Record<string, unknown>;
}

const ALLOWED_IMAGE_MIME = /^image\/(png|jpeg|jpg|gif|webp)$/i;
const SAFE_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24})$/;
const SAFE_DIM_RE = /^(-?\d+(?:\.\d+)?)\s*(cm|in|mm|pt|px)$/i;
const SAFE_ALIGN_RE = /^(Left|Center|Right|Justify|General|Top|Middle|Bottom)$/i;
const SAFE_FONT_RE = /^[A-Za-z0-9 _,-]{1,64}$/;

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [220, 38, 38],
  blue: [37, 99, 235],
  navy: [0, 48, 135],
  green: [22, 163, 74],
  gray: [100, 116, 139],
  grey: [100, 116, 139],
  lightgray: [226, 232, 240],
  lightgrey: [226, 232, 240],
  silver: [203, 213, 225],
  yellow: [250, 204, 21],
  orange: [249, 115, 22],
  slate: [71, 85, 105],
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeColor(value: string | undefined, fallback = ''): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (/^transparent$/i.test(trimmed)) return '';
  return SAFE_COLOR_RE.test(trimmed) ? trimmed : fallback;
}

function parseColorRgb(value: string | undefined): ReturnType<typeof rgb> | undefined {
  const c = safeColor(value);
  if (!c) return undefined;
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return rgb(r / 255, g / 255, b / 255);
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every((n) => !Number.isNaN(n))) {
        return rgb(r / 255, g / 255, b / 255);
      }
    }
    return undefined;
  }
  const named = NAMED_COLORS[c.toLowerCase()];
  if (named) return rgb(named[0] / 255, named[1] / 255, named[2] / 255);
  return undefined;
}

function safeDim(value: string | undefined, fallback = ''): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  const m = trimmed.match(SAFE_DIM_RE);
  return m ? `${m[1]}${m[2].toLowerCase()}` : fallback;
}

function dimToPt(value: string | undefined, fallbackPt = 0): number {
  if (!value) return fallbackPt;
  const m = value.trim().match(SAFE_DIM_RE);
  if (!m) return fallbackPt;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'pt') return n;
  if (unit === 'in') return n * 72;
  if (unit === 'cm') return (n * 72) / 2.54;
  if (unit === 'mm') return (n * 72) / 25.4;
  if (unit === 'px') return n * 0.75;
  return fallbackPt;
}

function dimToCm(value: string | undefined): number {
  const pt = dimToPt(value, NaN);
  return Number.isFinite(pt) ? (pt * 2.54) / 72 : NaN;
}

function tagName(node: OrderedNode): string | undefined {
  return Object.keys(node).find((k) => k !== ':@' && k !== '#text');
}

function childrenOf(node: OrderedNode | undefined, name?: string): OrderedNode[] {
  if (!node) return [];
  const k = tagName(node);
  if (!k) return [];
  const raw = node[k];
  const arr = Array.isArray(raw) ? (raw as OrderedNode[]) : [];
  return arr.filter((c) => {
    const ck = tagName(c);
    if (!ck) return false;
    return name ? ck === name : true;
  });
}

function childOf(node: OrderedNode | undefined, name: string): OrderedNode | undefined {
  return childrenOf(node, name)[0];
}

function textOf(node: OrderedNode | undefined, childName?: string): string {
  const target = childName ? childOf(node, childName) : node;
  if (!target) return '';
  const k = tagName(target);
  if (!k) return '';
  const raw = target[k];
  const arr = Array.isArray(raw) ? (raw as OrderedNode[]) : [];
  return arr.map((c) => (c['#text'] !== undefined ? String(c['#text']) : '')).join('');
}

function attrOf(node: OrderedNode | undefined, name: string): string {
  const attrs = node?.[':@'];
  if (!attrs) return '';
  const val = attrs[`@_${name}`];
  return val !== undefined && val !== null ? String(val) : '';
}

interface ParsedBorder {
  style: string;
  color: string;
  width: string;
}

interface ParsedStyle {
  Border?: ParsedBorder;
  TopBorder?: ParsedBorder;
  BottomBorder?: ParsedBorder;
  LeftBorder?: ParsedBorder;
  RightBorder?: ParsedBorder;
  [key: string]: unknown;
}

function parseBorderNode(node: OrderedNode | undefined): ParsedBorder | undefined {
  if (!node) return undefined;
  return {
    style: textOf(node, 'Style') || 'None',
    color: safeColor(textOf(node, 'Color'), '#000000'),
    width: safeDim(textOf(node, 'Width'), '0.75pt'),
  };
}

function parseStyle(styleNode: OrderedNode | undefined): ParsedStyle {
  if (!styleNode) return {};
  const out: ParsedStyle = {};
  for (const ch of childrenOf(styleNode)) {
    const k = tagName(ch);
    if (!k) continue;
    if (k === 'Border' || k === 'TopBorder' || k === 'BottomBorder' || k === 'LeftBorder' || k === 'RightBorder') {
      out[k] = parseBorderNode(ch);
    } else {
      out[k] = textOf(ch);
    }
  }
  return out;
}

function effectiveSideBorder(st: ParsedStyle, side: 'TopBorder' | 'BottomBorder' | 'LeftBorder' | 'RightBorder'): ParsedBorder | undefined {
  const specific = st[side] as ParsedBorder | undefined;
  if (specific) return specific;
  return st.Border;
}

function borderCss(st: ParsedStyle): string {
  const b = st.Border;
  const hasSpecific = Boolean(st.TopBorder || st.RightBorder || st.BottomBorder || st.LeftBorder);
  const sideToCss = (prop: string, sb: ParsedBorder | undefined): string => {
    if (!sb) return '';
    if (sb.style === 'None') return `${prop}:none;`;
    const tok = /^(Solid|Dashed|Dotted|Double)$/i.test(sb.style) ? sb.style.toLowerCase() : 'solid';
    return `${prop}:${sb.width} ${tok} ${sb.color};`;
  };

  if (!hasSpecific) {
    if (!b || b.style === 'None') return 'border:none;';
    const tok = /^(Solid|Dashed|Dotted|Double)$/i.test(b.style) ? b.style.toLowerCase() : 'solid';
    return `border:${b.width} ${tok} ${b.color};`;
  }

  return [
    sideToCss('border-top', effectiveSideBorder(st, 'TopBorder')),
    sideToCss('border-right', effectiveSideBorder(st, 'RightBorder')),
    sideToCss('border-bottom', effectiveSideBorder(st, 'BottomBorder')),
    sideToCss('border-left', effectiveSideBorder(st, 'LeftBorder')),
  ].join('');
}

function sanitizeTextForFont(font: PDFFont, raw: string, isEmbeddedTtf = false): string {
  const mapped = isEmbeddedTtf
    ? raw.replace(/\u00A0/g, ' ').replace(/\r/g, '')
    : raw
        .replace(/\u00A0/g, ' ')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2013|\u2014/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/\u2264/g, '<=')
        .replace(/\u2265/g, '>=')
        .replace(/\r/g, '');
  let safe = '';
  for (const ch of mapped) {
    if (ch === '\n' || ch === '\t') {
      safe += ch;
      continue;
    }
    try {
      font.encodeText(ch);
      safe += ch;
    } catch {
      safe += ch === '\u2022' ? '*' : '?';
    }
  }
  return safe;
}

interface ParsedPageSlice {
  pageNum: number;
  rectContainer?: OrderedNode;
  items: Array<{ node: OrderedNode; topOffsetPt: number }>;
}

interface EmbeddedImgEntry {
  name: string;
  mime: string;
  base64: string;
  dataUrl: string;
}

interface ParsedRdlcContext {
  reportNode: OrderedNode;
  embeddedImages: Map<string, EmbeddedImgEntry>;
  params: Map<string, string>;
  fieldsMap: Map<string, string>;
  detailRows: Array<Map<string, string>>;
  pageWStr: string;
  pageHStr: string;
  leftMStr: string;
  rightMStr: string;
  topMStr: string;
  bottomMStr: string;
  pageWPt: number;
  pageHPt: number;
  leftMPt: number;
  rightMPt: number;
  topMPt: number;
  bottomMPt: number;
  headerHStr: string;
  headerHPt: number;
  headerPrintOnFirstPage: boolean;
  headerPrintOnLastPage: boolean;
  headerItemsNode?: OrderedNode;
  footerHStr: string;
  footerHPt: number;
  footerPrintOnFirstPage: boolean;
  footerPrintOnLastPage: boolean;
  footerItemsNode?: OrderedNode;
  bodyNode?: OrderedNode;
  pages: ParsedPageSlice[];
}

export class RdlcVisualPreviewRenderer {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  private zIndexOf(node: OrderedNode): number {
    const raw = textOf(node, 'ZIndex');
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  public extractParameters(rdlcXml: string): RdlcParameterDescriptor[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      preserveOrder: true,
      trimValues: false,
      parseTagValue: false,
      removeNSPrefix: true,
    });
    const ast = parser.parse(rdlcXml) as OrderedNode[];
    const reportNode = ast.find((n) => tagName(n) === 'Report');
    if (!reportNode) return [];
    const paramsParent = childOf(reportNode, 'ReportParameters');
    const list: RdlcParameterDescriptor[] = [];
    for (const pNode of childrenOf(paramsParent, 'ReportParameter')) {
      const name = attrOf(pNode, 'Name');
      if (!name) continue;
      const dataType = textOf(pNode, 'DataType') || 'String';
      const prompt = textOf(pNode, 'Prompt') || name;
      const defVal = childOf(pNode, 'DefaultValue');
      const vals = childOf(defVal, 'Values');
      const valNode = childOf(vals, 'Value');
      list.push({
        name,
        dataType,
        prompt,
        defaultValue: valNode ? textOf(valNode) : '',
      });
    }
    return list;
  }

  private parseRdlc(
    rdlcXml: string,
    sampleFields?: Record<string, unknown>,
    parameterOverrides?: Record<string, string>
  ): ParsedRdlcContext {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      preserveOrder: true,
      trimValues: false,
      parseTagValue: false,
      removeNSPrefix: true,
    });
    const ast = parser.parse(rdlcXml) as OrderedNode[];
    const reportNode = ast.find((n) => tagName(n) === 'Report');
    if (!reportNode) {
      throw new Error('Invalid RDLC XML: missing <Report> root element.');
    }

    const embeddedImages = new Map<string, EmbeddedImgEntry>();
    const embParent = childOf(reportNode, 'EmbeddedImages');
    for (const imgNode of childrenOf(embParent, 'EmbeddedImage')) {
      const name = attrOf(imgNode, 'Name');
      const mime = (textOf(imgNode, 'MIMEType').trim() || 'image/png').toLowerCase();
      const b64 = textOf(imgNode, 'ImageData').replace(/\s+/g, '');
      if (name && ALLOWED_IMAGE_MIME.test(mime) && /^[A-Za-z0-9+/=]+$/.test(b64)) {
        embeddedImages.set(name, {
          name,
          mime,
          base64: b64,
          dataUrl: `data:${mime};base64,${b64}`,
        });
      }
    }

    const params = new Map<string, string>();
    const paramsParent = childOf(reportNode, 'ReportParameters');
    for (const pNode of childrenOf(paramsParent, 'ReportParameter')) {
      const pName = attrOf(pNode, 'Name');
      const defVal = childOf(pNode, 'DefaultValue');
      const vals = childOf(defVal, 'Values');
      const valNode = childOf(vals, 'Value');
      if (pName) {
        params.set(pName, valNode ? textOf(valNode) : `[${pName}]`);
      }
    }
    if (sampleFields && typeof (sampleFields as { Parameters?: unknown }).Parameters === 'object') {
      const sampleParams = (sampleFields as { Parameters?: Record<string, unknown> }).Parameters;
      if (sampleParams) {
        for (const [k, v] of Object.entries(sampleParams)) {
          if (v !== null && v !== undefined && (!params.has(k) || params.get(k) === `[${k}]`)) {
            params.set(k, String(v));
          }
        }
      }
    }
    if (parameterOverrides) {
      for (const [k, v] of Object.entries(parameterOverrides)) {
        if (v !== undefined && v !== null) {
          params.set(k, String(v));
        }
      }
    }

    const fieldsMap = new Map<string, string>();
    const detailRows: Array<Map<string, string>> = [];
    if (sampleFields) {
      for (const [k, v] of Object.entries(sampleFields)) {
        if (v === null || v === undefined || typeof v === 'object') continue;
        fieldsMap.set(k, String(v));
      }
      const dsName = String((sampleFields as { DataSetName?: unknown }).DataSetName ?? '');
      const rawRows = Array.isArray((sampleFields as { detailRows?: unknown[] }).detailRows)
        ? ((sampleFields as { detailRows: unknown[] }).detailRows)
        : dsName && Array.isArray((sampleFields as Record<string, unknown[]>)[dsName])
        ? ((sampleFields as Record<string, unknown[]>)[dsName])
        : [];
      for (const item of rawRows) {
        if (!item || typeof item !== 'object') continue;
        const rowMap = new Map<string, string>();
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          if (v !== null && v !== undefined && typeof v !== 'object') {
            rowMap.set(k, String(v));
          }
        }
        if (rowMap.size > 0) detailRows.push(rowMap);
      }
      if (detailRows.length > 0) {
        for (const [k, v] of detailRows[0].entries()) {
          if (!fieldsMap.has(k)) fieldsMap.set(k, v);
        }
      }
    }

    const sectionNode = childOf(childOf(reportNode, 'ReportSections'), 'ReportSection');
    const bodyNode = sectionNode ? childOf(sectionNode, 'Body') : childOf(reportNode, 'Body');
    const pageNode = sectionNode ? childOf(sectionNode, 'Page') : childOf(reportNode, 'Page');

    const pageWStr = safeDim(textOf(pageNode, 'PageWidth'), '21.00cm');
    const pageHStr = safeDim(textOf(pageNode, 'PageHeight'), '29.70cm');
    const leftMStr = safeDim(textOf(pageNode, 'LeftMargin'), '0cm');
    const rightMStr = safeDim(textOf(pageNode, 'RightMargin'), '0cm');
    const topMStr = safeDim(textOf(pageNode, 'TopMargin'), '0cm');
    const bottomMStr = safeDim(textOf(pageNode, 'BottomMargin'), '0cm');

    const pageWPt = Math.max(72, dimToPt(pageWStr, 595.28));
    const pageHPt = Math.max(72, dimToPt(pageHStr, 841.89));
    const leftMPt = Math.max(0, dimToPt(leftMStr, 0));
    const rightMPt = Math.max(0, dimToPt(rightMStr, 0));
    const topMPt = Math.max(0, dimToPt(topMStr, 0));
    const bottomMPt = Math.max(0, dimToPt(bottomMStr, 0));

    const headerNode = childOf(pageNode, 'PageHeader');
    const headerHStr = headerNode ? safeDim(textOf(headerNode, 'Height'), '0cm') : '0cm';
    const headerHPt = headerNode ? Math.max(0, dimToPt(headerHStr, 0)) : 0;
    const headerPrintOnFirstPage = headerNode
      ? textOf(headerNode, 'PrintOnFirstPage').trim().toLowerCase() !== 'false'
      : true;
    const headerPrintOnLastPage = headerNode
      ? textOf(headerNode, 'PrintOnLastPage').trim().toLowerCase() !== 'false'
      : true;
    const headerItemsNode = headerNode ? childOf(headerNode, 'ReportItems') : undefined;

    const footerNode = childOf(pageNode, 'PageFooter');
    const footerHStr = footerNode ? safeDim(textOf(footerNode, 'Height'), '0cm') : '0cm';
    const footerHPt = footerNode ? Math.max(0, dimToPt(footerHStr, 0)) : 0;
    const footerPrintOnFirstPage = footerNode
      ? textOf(footerNode, 'PrintOnFirstPage').trim().toLowerCase() !== 'false'
      : true;
    const footerPrintOnLastPage = footerNode
      ? textOf(footerNode, 'PrintOnLastPage').trim().toLowerCase() !== 'false'
      : true;
    const footerItemsNode = footerNode ? childOf(footerNode, 'ReportItems') : undefined;

    const bodyItems = childOf(bodyNode, 'ReportItems');
    const allTopItems = childrenOf(bodyItems).filter((n) => {
      const k = tagName(n);
      return Boolean(k && ['Rectangle', 'Textbox', 'Image', 'Tablix', 'Line'].includes(k));
    });
    const topLevelRects = allTopItems.filter((n) => tagName(n) === 'Rectangle');
    const isMultiPageContainers =
      topLevelRects.length > 0 &&
      topLevelRects.length === allTopItems.length &&
      topLevelRects.every((r) => /^PageContainer_/i.test(attrOf(r, 'Name')));

    let pages: ParsedPageSlice[] = [];
    if (isMultiPageContainers) {
      pages = topLevelRects.map((rectNode, idx) => ({
        pageNum: idx + 1,
        rectContainer: rectNode,
        items: childrenOf(childOf(rectNode, 'ReportItems')).map((n) => ({ node: n, topOffsetPt: 0 })),
      }));
    } else {
      const usableBodyPt = Math.max(144, pageHPt - topMPt - bottomMPt - headerHPt - footerHPt);
      const maxTopPt = allTopItems.reduce((mx, n) => {
        const t = dimToPt(textOf(n, 'Top'), 0);
        const h = dimToPt(textOf(n, 'Height'), 18);
        return Math.max(mx, t + h);
      }, 0);

      const hasExplicitBreaks = allTopItems.some((n) => Boolean(childOf(n, 'PageBreak')));
      if (hasExplicitBreaks) {
        let currentItems: Array<{ node: OrderedNode; topOffsetPt: number }> = [];
        let pageOriginPt = 0;
        for (const item of allTopItems) {
          const pb = childOf(item, 'PageBreak');
          const loc = textOf(pb, 'BreakLocation');
          if (loc === 'Start' && currentItems.length > 0) {
            pages.push({ pageNum: pages.length + 1, items: currentItems });
            currentItems = [];
            pageOriginPt = dimToPt(textOf(item, 'Top'), 0);
          }
          currentItems.push({ node: item, topOffsetPt: pageOriginPt });
          if (loc === 'End') {
            pages.push({ pageNum: pages.length + 1, items: currentItems });
            currentItems = [];
            pageOriginPt = dimToPt(textOf(item, 'Top'), 0) + dimToPt(textOf(item, 'Height'), 0);
          }
        }
        if (currentItems.length > 0 || pages.length === 0) {
          pages.push({ pageNum: pages.length + 1, items: currentItems });
        }
      } else if (maxTopPt > pageHPt + 18) {
        const estimatedPages = Math.max(1, Math.ceil(maxTopPt / pageHPt));
        const buckets: Array<Array<{ node: OrderedNode; topOffsetPt: number }>> = Array.from(
          { length: estimatedPages },
          () => []
        );
        for (const item of allTopItems) {
          const itemTop = dimToPt(textOf(item, 'Top'), 0);
          const pIdx = Math.min(estimatedPages - 1, Math.max(0, Math.floor(itemTop / pageHPt)));
          buckets[pIdx].push({ node: item, topOffsetPt: pIdx * pageHPt });
        }
        pages = buckets
          .map((items, idx) => ({ pageNum: idx + 1, items }))
          .filter((p) => p.items.length > 0 || p.pageNum === 1);
      } else {
        void usableBodyPt;
        pages = [{ pageNum: 1, items: allTopItems.map((n) => ({ node: n, topOffsetPt: 0 })) }];
      }
    }

    if (pages.length === 0) {
      pages = [{ pageNum: 1, items: [] }];
    }

    return {
      reportNode,
      embeddedImages,
      params,
      fieldsMap,
      detailRows,
      pageWStr,
      pageHStr,
      leftMStr,
      rightMStr,
      topMStr,
      bottomMStr,
      pageWPt,
      pageHPt,
      leftMPt,
      rightMPt,
      topMPt,
      bottomMPt,
      headerHStr,
      headerHPt,
      headerPrintOnFirstPage,
      headerPrintOnLastPage,
      headerItemsNode,
      footerHStr,
      footerHPt,
      footerPrintOnFirstPage,
      footerPrintOnLastPage,
      footerItemsNode,
      bodyNode,
      pages,
    };
  }

  private evalExpr(
    ctx: ParsedRdlcContext,
    raw: string,
    pageNum: number,
    totalPages: number,
    rowFields?: Map<string, string>
  ): string {
    if (!raw.startsWith('=')) return raw;
    const expr = raw.slice(1).trim();
    const activeFields = rowFields ?? ctx.fieldsMap;

    const singleParam = expr.match(/^Parameters!([A-Za-z0-9_]+)\.Value$/);
    if (singleParam) return ctx.params.get(singleParam[1]) ?? `[${singleParam[1]}]`;

    const singleField = expr.match(/^Fields!([A-Za-z0-9_]+)\.Value$/);
    if (singleField) return activeFields.get(singleField[1]) ?? `[${singleField[1]}]`;

    if (expr === 'Globals!PageNumber') return String(pageNum);
    if (expr === 'Globals!TotalPages') return String(totalPages);

    const resolveArg = (tok: string): string => {
      const t = tok.trim();
      if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
      if (t === 'Globals!PageNumber') return String(pageNum);
      if (t === 'Globals!TotalPages') return String(totalPages);
      const pm = t.match(/^Parameters!([A-Za-z0-9_]+)\.Value$/);
      if (pm) return ctx.params.get(pm[1]) ?? '';
      const fm = t.match(/^Fields!([A-Za-z0-9_]+)\.Value$/);
      if (fm) return activeFields.get(fm[1]) ?? '';
      return t;
    };

    const parseNumArg = (tok: string): number => {
      const s = resolveArg(tok).replace(/[^0-9.-]/g, '');
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    };

    const calcLineMatch = expr.match(/^Code\.CalculateLineTotal\(([^)]+)\)$/i);
    if (calcLineMatch) {
      const args = calcLineMatch[1].split(',');
      const qty = parseNumArg(args[0] ?? '0');
      const price = parseNumArg(args[1] ?? '0');
      const disc = parseNumArg(args[2] ?? '0');
      const computed = Math.round(qty * price * (1 - disc / 100) * 100) / 100;
      const rawLineTotal = activeFields.get('LineTotal');
      if (rawLineTotal !== undefined) {
        const parsedLt = Number(rawLineTotal.replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(parsedLt) && Math.abs(parsedLt - computed) < 0.01) {
          return rawLineTotal;
        }
      }
      const priceArg = resolveArg(args[1] ?? '');
      return /\.\d{2}$/.test(priceArg) ? computed.toFixed(2) : String(computed);
    }

    const calcNetMatch = expr.match(/^Code\.CalculateNetTotal\(([^)]+)\)$/i);
    if (calcNetMatch) {
      const args = calcNetMatch[1].split(',');
      const sub = parseNumArg(args[0] ?? '0');
      const tax = parseNumArg(args[1] ?? '0');
      const computed = Math.round((sub + Math.round(sub * (tax / 100) * 100) / 100) * 100) / 100;
      return computed.toFixed(2);
    }

    const iifMatch = expr.match(
      /^IIf\(\s*Fields!([A-Za-z0-9_]+)\.Value\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)$/i
    );
    if (iifMatch) {
      const val = activeFields.get(iifMatch[1]);
      return val === iifMatch[2] ? iifMatch[3] : iifMatch[4];
    }

    if (expr.includes('&')) {
      const tokens: string[] = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
          cur += ch;
        } else if (ch === '&' && !inQuotes) {
          tokens.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) tokens.push(cur.trim());

      if (tokens.length > 1) {
        return tokens
          .map((part) => {
            if (part.startsWith('"') && part.endsWith('"')) return part.slice(1, -1);
            if (part === 'Globals!PageNumber') return String(pageNum);
            if (part === 'Globals!TotalPages') return String(totalPages);
            const pm = part.match(/^Parameters!([A-Za-z0-9_]+)\.Value$/);
            if (pm) return ctx.params.get(pm[1]) ?? `[${pm[1]}]`;
            const fm = part.match(/^Fields!([A-Za-z0-9_]+)\.Value$/);
            if (fm) return activeFields.get(fm[1]) ?? `[${fm[1]}]`;
            return part;
          })
          .join('');
      }
    }

    return raw;
  }

  private expandTablixRows(
    tblNode: OrderedNode,
    ctx: ParsedRdlcContext
  ): Array<{ rowNode: OrderedNode; rowFields?: Map<string, string> }> {
    const tBody = childOf(tblNode, 'TablixBody');
    const rows = childrenOf(childOf(tBody, 'TablixRows'), 'TablixRow');
    const rowMembers = childrenOf(
      childOf(childOf(tblNode, 'TablixRowHierarchy'), 'TablixMembers'),
      'TablixMember'
    );

    const expanded: Array<{ rowNode: OrderedNode; rowFields?: Map<string, string> }> = [];
    rows.forEach((rowNode, idx) => {
      const member = rowMembers[idx];
      const hasDetailGroup = Boolean(member && childOf(member, 'Group'));
      if (hasDetailGroup && ctx.detailRows.length > 0) {
        for (const rowMap of ctx.detailRows) {
          expanded.push({ rowNode, rowFields: rowMap });
        }
      } else {
        expanded.push({ rowNode, rowFields: ctx.detailRows[0] ?? ctx.fieldsMap });
      }
    });
    return expanded;
  }

  public renderHtml(rdlcXml: string, options?: RdlcRenderOptions): RdlcPreviewResult {
    const ctx = this.parseRdlc(rdlcXml, options?.sampleFields, options?.parameterOverrides);
    const totalPages = ctx.pages.length;

    const stats = {
      rectangles: 0,
      tablixes: 0,
      mergedCells: 0,
      textboxes: 0,
      images: 0,
      embeddedImages: ctx.embeddedImages.size,
      parameters: ctx.params.size,
    };

    const renderParagraphs = (
      tbNode: OrderedNode,
      pageNum: number,
      rowFields?: Map<string, string>
    ): string => {
      const parasNode = childOf(tbNode, 'Paragraphs');
      return childrenOf(parasNode, 'Paragraph')
        .map((p) => {
          const ps = parseStyle(childOf(p, 'Style'));
          const leftIndent = safeDim(ps.LeftIndent as string | undefined);
          const hanging = safeDim(ps.HangingIndent as string | undefined);
          const alignRaw = String(ps.TextAlign || 'Left');
          const align = SAFE_ALIGN_RE.test(alignRaw) ? alignRaw.toLowerCase() : 'left';
          const spaceBefore = safeDim(ps.SpaceBefore as string | undefined, '0');
          const spaceAfter = safeDim(ps.SpaceAfter as string | undefined, '0');
          const lineHeight = safeDim(ps.LineHeight as string | undefined) || '1.22';

          const runs = childrenOf(childOf(p, 'TextRuns'), 'TextRun');
          const firstVal =
            runs.length > 0
              ? this.evalExpr(ctx, textOf(runs[0], 'Value'), pageNum, totalPages, rowFields)
              : '';
          const hasTabHanging = Boolean(leftIndent && hanging.startsWith('-') && firstVal.endsWith('\t'));

          const pCss = [
            `text-align:${align};`,
            `margin-top:${spaceBefore};`,
            `margin-bottom:${spaceAfter};`,
            `line-height:${lineHeight};`,
            leftIndent ? `padding-left:${leftIndent};` : '',
            hanging ? `text-indent:${hanging};` : '',
          ].join('');

          const runsHtml = runs
            .map((r, idx) => {
              const rs = parseStyle(childOf(r, 'Style'));
              const val = this.evalExpr(ctx, textOf(r, 'Value'), pageNum, totalPages, rowFields);
              const ffRaw = String(rs.FontFamily || '');
              const fontFamily = SAFE_FONT_RE.test(ffRaw)
                ? `'${ffRaw}',Calibri,Arial,sans-serif`
                : 'Calibri,Arial,sans-serif';
              const fontSize = safeDim(rs.FontSize as string | undefined, '7.5pt');
              const fontColor = safeColor(rs.Color as string | undefined, '#2C2E35') || '#2C2E35';
              const rCss = [
                `font-family:${fontFamily};`,
                `font-size:${fontSize};`,
                rs.FontWeight === 'Bold' ? 'font-weight:700;' : '',
                rs.FontStyle === 'Italic' ? 'font-style:italic;' : '',
                rs.TextDecoration === 'Underline' ? 'text-decoration:underline;' : '',
                `color:${fontColor};`,
              ].join('');

              if (hasTabHanging && idx === 0) {
                const label = val.slice(0, -1);
                const hangAbs = hanging.slice(1);
                return `<span style="${rCss}display:inline-block;min-width:${hangAbs};text-indent:0;">${escapeHtml(label)}</span>`;
              }
              return `<span style="${rCss}">${escapeHtml(val).replace(/\n/g, '<br/>')}</span>`;
            })
            .join('');

          return `<div class="rdlc-p" style="${pCss}">${runsHtml}</div>`;
        })
        .join('');
    };

    const topCssValue = (node: OrderedNode, offsetPt: number): string => {
      if (!offsetPt) return safeDim(textOf(node, 'Top'), '0cm');
      const relPt = Math.max(0, dimToPt(textOf(node, 'Top'), 0) - offsetPt);
      return `${Math.round(relPt * 100) / 100}pt`;
    };

    const renderTextbox = (tbNode: OrderedNode, pageNum: number, topOffsetPt = 0): string => {
      stats.textboxes++;
      const name = escapeHtml(attrOf(tbNode, 'Name'));
      const st = parseStyle(childOf(tbNode, 'Style'));
      const zIdx = this.zIndexOf(tbNode);
      const vAlignMap: Record<string, string> = {
        Top: 'flex-start',
        Middle: 'center',
        Bottom: 'flex-end',
      };
      const justify = vAlignMap[String(st.VerticalAlign || 'Top')] ?? 'flex-start';
      const padCss = `padding:${safeDim(st.PaddingTop as string | undefined, '0pt')} ${safeDim(st.PaddingRight as string | undefined, '0pt')} ${safeDim(st.PaddingBottom as string | undefined, '0pt')} ${safeDim(st.PaddingLeft as string | undefined, '0pt')};`;
      const bg = safeColor(st.BackgroundColor as string | undefined);
      const bgCss = bg ? `background:${bg};` : '';
      const posCss = `position:absolute;z-index:${zIdx};top:${topCssValue(tbNode, topOffsetPt)};left:${safeDim(textOf(tbNode, 'Left'), '0cm')};width:${safeDim(textOf(tbNode, 'Width'), '2cm')};height:${safeDim(textOf(tbNode, 'Height'), '0.5cm')};`;
      return `<div data-rdlc-name="${name}" style="${posCss}${bgCss}${borderCss(st)}${padCss}box-sizing:border-box;display:flex;flex-direction:column;justify-content:${justify};overflow:visible;">${renderParagraphs(tbNode, pageNum)}</div>`;
    };

    const renderImage = (imNode: OrderedNode, isCell = false, topOffsetPt = 0): string => {
      stats.images++;
      const name = escapeHtml(attrOf(imNode, 'Name'));
      const imgKey = textOf(imNode, 'Value');
      const sizing = textOf(imNode, 'Sizing') || 'FitProportional';
      const fit = sizing === 'Fit' ? 'fill' : 'contain';
      const zIdx = this.zIndexOf(imNode);
      const src = ctx.embeddedImages.get(imgKey)?.dataUrl;
      const posCss = isCell
        ? 'width:100%;height:100%;max-height:100%;'
        : `position:absolute;z-index:${zIdx};top:${topCssValue(imNode, topOffsetPt)};left:${safeDim(textOf(imNode, 'Left'), '0cm')};width:${safeDim(textOf(imNode, 'Width'), '1cm')};height:${safeDim(textOf(imNode, 'Height'), '1cm')};`;
      if (!src) {
        return `<div data-rdlc-name="${name}" style="${posCss}display:flex;align-items:center;justify-content:center;border:0.5pt dashed #94a3b8;font-size:7pt;color:#64748b;">[${escapeHtml(imgKey || 'Image')}]</div>`;
      }
      return `<img data-rdlc-name="${name}" alt="${escapeHtml(imgKey)}" src="${src}" style="${posCss}object-fit:${fit};display:block;" />`;
    };

    const renderTablix = (
      tblNode: OrderedNode,
      pageNum: number,
      topOffsetPt = 0,
      nested = false,
      flowStyleCss?: string
    ): string => {
      stats.tablixes++;
      const name = escapeHtml(attrOf(tblNode, 'Name'));
      const zIdx = this.zIndexOf(tblNode);
      const top = topCssValue(tblNode, topOffsetPt);
      const left = safeDim(textOf(tblNode, 'Left'), '0cm');
      const width = safeDim(textOf(tblNode, 'Width'), '100%');
      const tBody = childOf(tblNode, 'TablixBody');
      const colWidths = childrenOf(childOf(tBody, 'TablixColumns'), 'TablixColumn').map((c) =>
        safeDim(textOf(c, 'Width'), 'auto')
      );
      const expandedRows = this.expandTablixRows(tblNode, ctx);
      const colgroup = `<colgroup>${colWidths.map((w) => `<col style="width:${w};" />`).join('')}</colgroup>`;
      const covered = Array.from({ length: expandedRows.length }, () => Array(colWidths.length).fill(false));

      const trs = expandedRows
        .map(({ rowNode: r, rowFields }, rIdx) => {
          const rH = safeDim(textOf(r, 'Height'), 'auto');
          const cells = childrenOf(childOf(r, 'TablixCells'), 'TablixCell');
          const tds: string[] = [];
          cells.forEach((cell, cIdx) => {
            if (covered[rIdx]?.[cIdx]) return;
            const cc = childOf(cell, 'CellContents');
            if (!cc) {
              tds.push('<td></td>');
              return;
            }
            const cs = Math.max(1, Number(textOf(cc, 'ColSpan') || 1));
            const rs = Math.max(1, Number(textOf(cc, 'RowSpan') || 1));
            if (cs > 1 || rs > 1) stats.mergedCells++;
            for (let rr = rIdx; rr < Math.min(expandedRows.length, rIdx + rs); rr++) {
              for (let ccIdx = cIdx; ccIdx < Math.min(colWidths.length, cIdx + cs); ccIdx++) {
                if (rr !== rIdx || ccIdx !== cIdx) covered[rr][ccIdx] = true;
              }
            }
            const subTbl = childOf(cc, 'Tablix');
            const subRect = childOf(cc, 'Rectangle');
            const tb = childOf(cc, 'Textbox');
            const img = childOf(cc, 'Image');
            const spanAttrs = `${cs > 1 ? ` colspan="${cs}"` : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}`;

            if (subTbl) {
              const innerTbl = renderTablix(subTbl, pageNum, 0, true);
              tds.push(
                `<td${spanAttrs} style="padding:0;border:none;vertical-align:top;box-sizing:border-box;">${innerTbl}</td>`
              );
              return;
            }

            if (subRect) {
              stats.rectangles++;
              const rName = escapeHtml(attrOf(subRect, 'Name'));
              const rst = parseStyle(childOf(subRect, 'Style'));
              const rBg = safeColor(rst.BackgroundColor as string | undefined);
              const rBgCss = rBg ? `background:${rBg};` : '';
              const inner = renderReportItems(childOf(subRect, 'ReportItems'), pageNum, 0);
              tds.push(
                `<td${spanAttrs} style="padding:0;border:none;vertical-align:top;box-sizing:border-box;"><div data-rdlc-name="${rName}" style="position:relative;width:100%;min-height:${rH};${rBgCss}${borderCss(rst)}box-sizing:border-box;">${inner}</div></td>`
              );
              return;
            }

            if (img && !tb) {
              tds.push(
                `<td${spanAttrs} style="padding:0;border:none;vertical-align:middle;box-sizing:border-box;">${renderImage(img, true)}</td>`
              );
              return;
            }

            const st = tb ? parseStyle(childOf(tb, 'Style')) : {};
            const bg = safeColor(st.BackgroundColor as string | undefined);
            const bgCss = bg ? `background:${bg};` : '';
            const padCss = `padding:${safeDim(st.PaddingTop as string | undefined, '2pt')} ${safeDim(st.PaddingRight as string | undefined, '3pt')} ${safeDim(st.PaddingBottom as string | undefined, '2pt')} ${safeDim(st.PaddingLeft as string | undefined, '3pt')};`;
            const vAlignRaw = String(st.VerticalAlign || 'Middle');
            const vAlign = SAFE_ALIGN_RE.test(vAlignRaw) ? vAlignRaw.toLowerCase() : 'middle';
            const inner = tb ? renderParagraphs(tb, pageNum, rowFields) : '';
            tds.push(
              `<td${spanAttrs} style="${bgCss}${borderCss(st)}${padCss}vertical-align:${vAlign};box-sizing:border-box;">${inner}</td>`
            );
          });
          const rowHeightCss = flowStyleCss ? `min-height:${rH};` : `height:${rH};`;
          return `<tr style="${rowHeightCss}">${tds.join('')}</tr>`;
        })
        .join('');

      const tablePosCss = nested
        ? 'position:relative;width:100%;height:100%;border-collapse:collapse;table-layout:fixed;'
        : flowStyleCss
          ? `${flowStyleCss}width:${width};border-collapse:collapse;table-layout:fixed;`
          : `position:absolute;z-index:${zIdx};top:${top};left:${left};width:${width};border-collapse:collapse;table-layout:fixed;`;
      return `<table data-rdlc-name="${name}" class="${flowStyleCss ? 'rdlc-flow-table' : ''}" style="${tablePosCss}">${colgroup}<tbody>${trs}</tbody></table>`;
    };

    const renderSingleItem = (item: OrderedNode, pageNum: number, topOffsetPt = 0): string => {
      const k = tagName(item);
      if (k === 'Rectangle') {
        stats.rectangles++;
        const name = escapeHtml(attrOf(item, 'Name'));
        const zIdx = this.zIndexOf(item);
        const st = parseStyle(childOf(item, 'Style'));
        const bg = safeColor(st.BackgroundColor as string | undefined);
        const bgCss = bg ? `background:${bg};` : '';
        const inner = renderReportItems(childOf(item, 'ReportItems'), pageNum, 0);
        return `<div data-rdlc-name="${name}" style="position:absolute;z-index:${zIdx};top:${topCssValue(item, topOffsetPt)};left:${safeDim(textOf(item, 'Left'), '0cm')};width:${safeDim(textOf(item, 'Width'), '100%')};height:${safeDim(textOf(item, 'Height'), '1cm')};${bgCss}${borderCss(st)}box-sizing:border-box;">${inner}</div>`;
      }
      if (k === 'Textbox') return renderTextbox(item, pageNum, topOffsetPt);
      if (k === 'Image') return renderImage(item, false, topOffsetPt);
      if (k === 'Tablix') return renderTablix(item, pageNum, topOffsetPt, false);
      return '';
    };

    const renderFlowItem = (
      item: OrderedNode,
      pageNum: number,
      topOffsetPt: number,
      marginLeftPt: number,
      marginTopPt: number
    ): string => {
      const k = tagName(item);
      const marginCss = `${marginLeftPt > 0.5 ? `margin-left:${Math.round(marginLeftPt * 100) / 100}pt;` : ''}${marginTopPt > 0.5 ? `margin-top:${Math.round(marginTopPt * 100) / 100}pt;` : ''}`;
      if (k === 'Tablix') {
        return renderTablix(item, pageNum, topOffsetPt, false, marginCss || 'display:table;');
      }
      if (k === 'Textbox') {
        stats.textboxes++;
        const name = escapeHtml(attrOf(item, 'Name'));
        const st = parseStyle(childOf(item, 'Style'));
        const padCss = `padding:${safeDim(st.PaddingTop as string | undefined, '0pt')} ${safeDim(st.PaddingRight as string | undefined, '0pt')} ${safeDim(st.PaddingBottom as string | undefined, '0pt')} ${safeDim(st.PaddingLeft as string | undefined, '0pt')};`;
        const bg = safeColor(st.BackgroundColor as string | undefined);
        const bgCss = bg ? `background:${bg};` : '';
        const width = safeDim(textOf(item, 'Width'), '100%');
        const minH = safeDim(textOf(item, 'Height'), 'auto');
        return `<div data-rdlc-name="${name}" style="${marginCss}width:${width};min-height:${minH};${bgCss}${borderCss(st)}${padCss}box-sizing:border-box;">${renderParagraphs(item, pageNum)}</div>`;
      }
      if (k === 'Image') {
        stats.images++;
        const name = escapeHtml(attrOf(item, 'Name'));
        const imgKey = textOf(item, 'Value');
        const sizing = textOf(item, 'Sizing') || 'FitProportional';
        const fit = sizing === 'Fit' ? 'fill' : 'contain';
        const src = ctx.embeddedImages.get(imgKey)?.dataUrl;
        const width = safeDim(textOf(item, 'Width'), '1cm');
        const height = safeDim(textOf(item, 'Height'), '1cm');
        if (!src) {
          return `<div data-rdlc-name="${name}" style="${marginCss}width:${width};height:${height};display:flex;align-items:center;justify-content:center;border:0.5pt dashed #94a3b8;font-size:7pt;color:#64748b;">[${escapeHtml(imgKey || 'Image')}]</div>`;
        }
        return `<img data-rdlc-name="${name}" alt="${escapeHtml(imgKey)}" src="${src}" style="${marginCss}width:${width};height:${height};object-fit:${fit};display:block;" />`;
      }
      if (k === 'Rectangle') {
        stats.rectangles++;
        const name = escapeHtml(attrOf(item, 'Name'));
        const st = parseStyle(childOf(item, 'Style'));
        const bg = safeColor(st.BackgroundColor as string | undefined);
        const bgCss = bg ? `background:${bg};` : '';
        const inner = renderReportItems(childOf(item, 'ReportItems'), pageNum, 0);
        return `<div data-rdlc-name="${name}" style="position:relative;${marginCss}width:${safeDim(textOf(item, 'Width'), '100%')};min-height:${safeDim(textOf(item, 'Height'), '1cm')};${bgCss}${borderCss(st)}box-sizing:border-box;">${inner}</div>`;
      }
      return '';
    };

    const renderFlowBody = (
      sliceItems: Array<{ node: OrderedNode; topOffsetPt: number }>,
      pageNum: number
    ): string => {
      if (sliceItems.length === 0) return '';
      const positioned = sliceItems
        .map(({ node, topOffsetPt }) => {
          const xPt = Math.max(0, dimToPt(textOf(node, 'Left'), 0));
          const yPt = Math.max(0, dimToPt(textOf(node, 'Top'), 0) - topOffsetPt);
          const wPt = Math.max(8, dimToPt(textOf(node, 'Width'), 100));
          const hPt = Math.max(8, dimToPt(textOf(node, 'Height'), 16));
          return { node, topOffsetPt, xPt, yPt, wPt, hPt };
        })
        .sort((a, b) => a.yPt - b.yPt || a.xPt - b.xPt);

      // Partition page into monotonic Y flow bands; side-by-side Tablix_Left & Tablix_Right share a Y band
      interface FlowBand {
        y0: number;
        y1: number;
        items: typeof positioned;
      }
      const bands: FlowBand[] = [];
      for (const it of positioned) {
        const last = bands[bands.length - 1];
        if (last && it.yPt < last.y1 - 2) {
          last.items.push(it);
          last.y1 = Math.max(last.y1, it.yPt + it.hPt);
        } else {
          bands.push({ y0: it.yPt, y1: it.yPt + it.hPt, items: [it] });
        }
      }

      let cursorY = 0;
      const chunks: string[] = [];

      for (const band of bands) {
        const gapAboveBandPt = Math.max(0, band.y0 - cursorY);

        // Group items inside the band into horizontal tracks (CSS Grid columns when >= 2 tracks exist)
        const xTracks: Array<{ x0: number; x1: number; items: typeof positioned }> = [];
        for (const it of [...band.items].sort((a, b) => a.xPt - b.xPt || a.yPt - b.yPt)) {
          const existing = xTracks.find(
            (tr) => Math.min(tr.x1, it.xPt + it.wPt) - Math.max(tr.x0, it.xPt) > 4
          );
          if (existing) {
            existing.items.push(it);
            existing.x0 = Math.min(existing.x0, it.xPt);
            existing.x1 = Math.max(existing.x1, it.xPt + it.wPt);
          } else {
            xTracks.push({ x0: it.xPt, x1: it.xPt + it.wPt, items: [it] });
          }
        }
        xTracks.sort((a, b) => a.x0 - b.x0);

        if (xTracks.length >= 2) {
          const gridLeftPt = xTracks[0].x0;
          const colDefs: string[] = [];
          const colHtmls: string[] = [];

          xTracks.forEach((tr, trIdx) => {
            const trW = Math.max(24, Math.round((tr.x1 - tr.x0) * 100) / 100);
            if (trIdx > 0) {
              const prevEnd = xTracks[trIdx - 1].x1;
              const spacerPt = Math.max(0, Math.round((tr.x0 - prevEnd) * 100) / 100);
              if (spacerPt > 1) {
                colDefs.push(`${spacerPt}pt`);
                colHtmls.push('<div class="rdlc-flow-gutter"></div>');
              }
            }
            colDefs.push(`${trW}pt`);

            const sortedTrItems = [...tr.items].sort((a, b) => a.yPt - b.yPt);
            let trCursorY = band.y0;
            const trInner = sortedTrItems
              .map((it) => {
                const gapY = Math.max(0, it.yPt - trCursorY);
                trCursorY = Math.max(trCursorY, it.yPt + it.hPt);
                const relLeft = Math.max(0, it.xPt - tr.x0);
                return renderFlowItem(it.node, pageNum, it.topOffsetPt, relLeft, gapY);
              })
              .join('');
            colHtmls.push(`<div class="rdlc-flow-track" style="display:flex;flex-direction:column;">${trInner}</div>`);
          });

          const topCss = gapAboveBandPt > 0.5 ? `margin-top:${Math.round(gapAboveBandPt * 100) / 100}pt;` : '';
          const leftCss = gridLeftPt > 0.5 ? `margin-left:${Math.round(gridLeftPt * 100) / 100}pt;` : '';
          chunks.push(
            `<div class="rdlc-flow-grid" style="display:grid;grid-template-columns:${colDefs.join(' ')};align-items:start;${topCss}${leftCss}">${colHtmls.join('')}</div>`
          );
        } else {
          const sortedBand = [...band.items].sort((a, b) => a.yPt - b.yPt || a.xPt - b.xPt);
          let innerY = band.y0;
          sortedBand.forEach((it, idx) => {
            const topGap = idx === 0 ? gapAboveBandPt : Math.max(0, it.yPt - innerY);
            innerY = Math.max(innerY, it.yPt + it.hPt);
            chunks.push(renderFlowItem(it.node, pageNum, it.topOffsetPt, it.xPt, topGap));
          });
        }

        cursorY = Math.max(cursorY, band.y1);
      }

      return chunks.join('');
    };

    const renderReportItems = (riNode: OrderedNode | undefined, pageNum: number, topOffsetPt = 0): string => {
      if (!riNode) return '';
      return childrenOf(riNode)
        .sort((a, b) => this.zIndexOf(a) - this.zIndexOf(b))
        .map((item) => renderSingleItem(item, pageNum, topOffsetPt))
        .join('');
    };

    const collisions: RdlcPreviewCollision[] = [];
    const checkCollisions = (nodes: OrderedNode[], pageNum: number, containerName: string) => {
      const containerBoxes: Array<{ name: string; x1: number; y1: number; x2: number; y2: number }> = [];
      const fgBoxes: Array<{ name: string; x1: number; y1: number; x2: number; y2: number }> = [];

      const recurseTablix = (tblNode: OrderedNode, tblName: string) => {
        const tBody = childOf(tblNode, 'TablixBody');
        const tRows = childrenOf(childOf(tBody, 'TablixRows'), 'TablixRow');
        for (const r of tRows) {
          for (const cell of childrenOf(childOf(r, 'TablixCells'), 'TablixCell')) {
            const cc = childOf(cell, 'CellContents');
            if (!cc) continue;
            const subTbl = childOf(cc, 'Tablix');
            if (subTbl) recurseTablix(subTbl, attrOf(subTbl, 'Name') || tblName);
            const subRect = childOf(cc, 'Rectangle');
            if (subRect) {
              const subRi = childOf(subRect, 'ReportItems');
              if (subRi) {
                checkCollisions(childrenOf(subRi), pageNum, attrOf(subRect, 'Name') || tblName);
              }
            }
          }
        }
      };

      for (const ch of nodes) {
        const k = tagName(ch);
        if (!k || !['Rectangle', 'Textbox', 'Image', 'Tablix'].includes(k)) continue;
        const itemName = attrOf(ch, 'Name') || k;
        if (itemName.startsWith('Img_Layer0_') || itemName.startsWith('Layer0_')) continue;
        const childReportItems = k === 'Rectangle' ? childOf(ch, 'ReportItems') : undefined;
        if (childReportItems) {
          checkCollisions(childrenOf(childReportItems), pageNum, itemName);
        }
        if (k === 'Tablix') {
          recurseTablix(ch, itemName);
        }
        const zIdx = this.zIndexOf(ch);
        const x1 = dimToCm(textOf(ch, 'Left'));
        const y1 = dimToCm(textOf(ch, 'Top'));
        const w = dimToCm(textOf(ch, 'Width'));
        const h = dimToCm(textOf(ch, 'Height'));
        if (![x1, y1, w, h].every((n) => Number.isFinite(n))) continue;
        const box = { name: itemName, x1, y1, x2: x1 + w, y2: y1 + h };
        if (k === 'Rectangle' && childReportItems) {
          containerBoxes.push(box);
        } else if (k === 'Textbox' || k === 'Tablix' || (k === 'Image' && zIdx >= 1)) {
          fgBoxes.push(box);
        }
      }
      const checkSet = (boxes: Array<{ name: string; x1: number; y1: number; x2: number; y2: number }>) => {
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
            const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
            if (ox > 0.05 && oy > 0.05) {
              collisions.push({
                page: pageNum,
                container: containerName,
                itemA: a.name,
                itemB: b.name,
                overlapCm: `${ox.toFixed(2)}cm × ${oy.toFixed(2)}cm`,
              });
            }
          }
        }
      };
      checkSet(containerBoxes);
      checkSet(fgBoxes);
    };

    const pagesHtml = ctx.pages
      .map((slice) => {
        const pNum = slice.pageNum;
        if (slice.rectContainer) {
          stats.rectangles++;
        }
        checkCollisions(
          slice.items.map((x) => x.node),
          pNum,
          slice.rectContainer ? attrOf(slice.rectContainer, 'Name') || `Page${pNum}` : `Page${pNum}`
        );

        const showHeader =
          Boolean(ctx.headerItemsNode) &&
          !(pNum === 1 && !ctx.headerPrintOnFirstPage) &&
          !(pNum === totalPages && !ctx.headerPrintOnLastPage);
        const showFooter =
          Boolean(ctx.footerItemsNode) &&
          !(pNum === 1 && !ctx.footerPrintOnFirstPage) &&
          !(pNum === totalPages && !ctx.footerPrintOnLastPage);

        const headerHtml = showHeader && ctx.headerItemsNode
          ? `<header class="rdlc-page-header" style="position:relative;width:100%;height:${ctx.headerHStr};overflow:visible;">${renderReportItems(ctx.headerItemsNode, pNum)}</header>`
          : '';
        const bodyHtml = renderFlowBody(slice.items, pNum);
        const footerHtml = showFooter && ctx.footerItemsNode
          ? `<footer class="rdlc-page-footer" style="position:relative;width:100%;height:${ctx.footerHStr};margin-top:auto;overflow:visible;">${renderReportItems(ctx.footerItemsNode, pNum)}</footer>`
          : '';

        return `<section class="rdlc-page" data-page="${pNum}">
  <div class="rdlc-page-inner" style="padding:${ctx.topMStr} ${ctx.rightMStr} ${ctx.bottomMStr} ${ctx.leftMStr};width:100%;min-height:${ctx.pageHStr};display:flex;flex-direction:column;">
    ${headerHtml}
    <main class="rdlc-page-body" style="width:100%;flex:1 1 auto;">${bodyHtml}</main>
    ${footerHtml}
  </div>
</section>`;
      })
      .join('\n');

    const titleText = escapeHtml(options?.title || 'RDLC Visual Render Preview');
    const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <title>${titleText}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px 0;
      background: #1e293b;
      font-family: Calibri, 'Segoe UI', Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
    }
    .preview-toolbar {
      color: #e2e8f0;
      font-size: 12px;
      background: #0f172a;
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid #334155;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .rdlc-page {
      width: ${ctx.pageWStr};
      min-height: ${ctx.pageHStr};
      background: #ffffff;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
      position: relative;
      flex-shrink: 0;
    }
    .rdlc-flow-table td {
      word-break: break-word;
    }
    .rdlc-p {
      margin: 0;
      word-wrap: break-word;
    }
    @media print {
      body { background: #fff; padding: 0; gap: 0; }
      .preview-toolbar { display: none; }
      .rdlc-page { box-shadow: none; page-break-after: always; }
    }
  </style>
</head>
<body>
  <div class="preview-toolbar">${titleText} · ${totalPages} page(s) (${ctx.pageWStr} × ${ctx.pageHStr}) · ${stats.tablixes} Tablix · ${stats.embeddedImages} Embedded PNG · ${collisions.length} overlap(s)</div>
  ${pagesHtml}
</body>
</html>`;

    this.logger.info('RdlcPreviewRenderer', 'Rendered flow-based semantic HTML table preview', {
      pageCount: totalPages,
      tablixes: stats.tablixes,
      embeddedImages: stats.embeddedImages,
      collisions: collisions.length,
    });

    return {
      html,
      pageCount: totalPages,
      pageWidth: ctx.pageWStr,
      pageHeight: ctx.pageHStr,
      stats,
      collisions,
    };
  }

  public async renderPdf(rdlcXml: string, options?: RdlcRenderOptions): Promise<Uint8Array> {
    const ctx = this.parseRdlc(rdlcXml, options?.sampleFields, options?.parameterOverrides);
    const totalPages = ctx.pages.length;

    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(options?.title || 'RDLC Rendered Report');
    pdfDoc.setCreator('ReportGen RDLC Visual Engine');
    pdfDoc.registerFontkit(fontkit);

    const loadTtfOrStd = async (paths: string[], stdFont: StandardFonts): Promise<{ font: PDFFont; isTtf: boolean }> => {
      for (const p of paths) {
        try {
          if (fs.existsSync(p)) {
            const fontBytes = fs.readFileSync(p);
            const font = await pdfDoc.embedFont(fontBytes, { subset: true });
            return { font, isTtf: true };
          }
        } catch {
          // Try next font path or fall back to StandardFonts
        }
      }
      return { font: await pdfDoc.embedFont(stdFont), isTtf: false };
    };

    const fonts = {
      sans: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf'],
        StandardFonts.Helvetica
      ),
      sansBold: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'],
        StandardFonts.HelveticaBold
      ),
      sansItalic: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Italic.ttf'],
        StandardFonts.HelveticaOblique
      ),
      sansBoldItalic: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf', '/usr/share/fonts/truetype/noto/NotoSans-BoldItalic.ttf'],
        StandardFonts.HelveticaBoldOblique
      ),
      serif: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSerif-Regular.ttf'],
        StandardFonts.TimesRoman
      ),
      serifBold: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf', '/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf'],
        StandardFonts.TimesRomanBold
      ),
      serifItalic: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf', '/usr/share/fonts/truetype/noto/NotoSerif-Italic.ttf'],
        StandardFonts.TimesRomanItalic
      ),
      serifBoldItalic: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf', '/usr/share/fonts/truetype/noto/NotoSerif-BoldItalic.ttf'],
        StandardFonts.TimesRomanBoldItalic
      ),
      mono: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'],
        StandardFonts.Courier
      ),
      monoBold: await loadTtfOrStd(
        ['/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'],
        StandardFonts.CourierBold
      ),
    };

    const pickFont = (family: string, bold: boolean, italic: boolean): { font: PDFFont; isTtf: boolean } => {
      const f = family.toLowerCase();
      if (f.includes('times') || f.includes('garamond') || (/(?:^|[^a-z])serif(?:$|[^a-z])/.test(f) && !f.includes('sans'))) {
        if (bold && italic) return fonts.serifBoldItalic;
        if (bold) return fonts.serifBold;
        if (italic) return fonts.serifItalic;
        return fonts.serif;
      }
      if (f.includes('courier') || f.includes('consolas') || f.includes('mono')) {
        return bold ? fonts.monoBold : fonts.mono;
      }
      if (bold && italic) return fonts.sansBoldItalic;
      if (bold) return fonts.sansBold;
      if (italic) return fonts.sansItalic;
      return fonts.sans;
    };

    const pdfImages = new Map<string, PDFImage>();
    for (const [name, entry] of ctx.embeddedImages.entries()) {
      try {
        const bytes = Buffer.from(entry.base64, 'base64');
        if (entry.mime.includes('jpeg') || entry.mime.includes('jpg')) {
          pdfImages.set(name, await pdfDoc.embedJpg(bytes));
        } else {
          pdfImages.set(name, await pdfDoc.embedPng(bytes));
        }
      } catch {
        // Ignore unreadable image bytes so PDF rendering continues cleanly
      }
    }

    const drawSideBorders = (
      page: PDFPage,
      x: number,
      topPt: number,
      w: number,
      h: number,
      st: ParsedStyle,
      pageHPt: number
    ) => {
      const drawOne = (
        b: ParsedBorder | undefined,
        x1: number,
        y1: number,
        x2: number,
        y2: number
      ) => {
        if (!b || b.style === 'None') return;
        const c = parseColorRgb(b.color) ?? rgb(0, 0, 0);
        const thickness = Math.max(0.25, dimToPt(b.width, 0.75));
        page.drawLine({
          start: { x: x1, y: pageHPt - y1 },
          end: { x: x2, y: pageHPt - y2 },
          thickness,
          color: c,
        });
      };
      drawOne(effectiveSideBorder(st, 'TopBorder'), x, topPt, x + w, topPt);
      drawOne(effectiveSideBorder(st, 'BottomBorder'), x, topPt + h, x + w, topPt + h);
      drawOne(effectiveSideBorder(st, 'LeftBorder'), x, topPt, x, topPt + h);
      drawOne(effectiveSideBorder(st, 'RightBorder'), x + w, topPt, x + w, topPt + h);
    };

    const drawStyledBox = (
      page: PDFPage,
      x: number,
      topPt: number,
      w: number,
      h: number,
      st: ParsedStyle,
      pageHPt: number
    ) => {
      const fill = parseColorRgb(st.BackgroundColor as string | undefined);
      if (fill && w > 0 && h > 0) {
        page.drawRectangle({
          x,
          y: pageHPt - topPt - h,
          width: w,
          height: h,
          color: fill,
        });
      }
      drawSideBorders(page, x, topPt, w, h, st, pageHPt);
    };

    const wrapParagraphSegments = (
      segments: Array<{ text: string; font: PDFFont; isTtf: boolean; size: number; color: ReturnType<typeof rgb>; underline?: boolean }>,
      maxWidth: number
    ): Array<Array<{ text: string; font: PDFFont; size: number; color: ReturnType<typeof rgb>; width: number; underline?: boolean }>> => {
      const lines: Array<Array<{ text: string; font: PDFFont; size: number; color: ReturnType<typeof rgb>; width: number; underline?: boolean }>> = [];
      let currentLine: Array<{ text: string; font: PDFFont; size: number; color: ReturnType<typeof rgb>; width: number; underline?: boolean }> = [];
      let lineW = 0;

      const pushLine = () => {
        lines.push(currentLine);
        currentLine = [];
        lineW = 0;
      };

      const safeW = Math.max(8, maxWidth);
      for (const seg of segments) {
        const cleanText = sanitizeTextForFont(seg.font, seg.text, seg.isTtf);
        const hardLines = cleanText.split('\n');
        hardLines.forEach((hardPart, hIdx) => {
          if (hIdx > 0) pushLine();
          const tokens = hardPart.split(/(\s+)/).filter((t) => t.length > 0);
          for (const tok of tokens) {
            const w = seg.font.widthOfTextAtSize(tok, seg.size);
            if (lineW > 0 && lineW + w > safeW + 0.5 && tok.trim().length > 0) {
              pushLine();
            }
            if (currentLine.length === 0 && tok.trim().length === 0) continue;
            currentLine.push({
              text: tok,
              font: seg.font,
              size: seg.size,
              color: seg.color,
              width: w,
              underline: seg.underline,
            });
            lineW += w;
          }
        });
      }
      if (currentLine.length > 0 || lines.length === 0) {
        lines.push(currentLine);
      }
      return lines;
    };

    const drawTextboxText = (
      page: PDFPage,
      tbNode: OrderedNode,
      boxX: number,
      boxTopPt: number,
      boxW: number,
      boxH: number,
      defaultPadPt: number,
      defaultVAlign: string,
      pageNum: number,
      rowFields?: Map<string, string>
    ) => {
      const st = parseStyle(childOf(tbNode, 'Style'));
      const padL = dimToPt(st.PaddingLeft as string | undefined, defaultPadPt);
      const padR = dimToPt(st.PaddingRight as string | undefined, defaultPadPt);
      const padT = dimToPt(st.PaddingTop as string | undefined, defaultPadPt > 0 ? 1.5 : 0);
      const padB = dimToPt(st.PaddingBottom as string | undefined, defaultPadPt > 0 ? 1.5 : 0);
      const vAlign = String(st.VerticalAlign || defaultVAlign);

      const innerX = boxX + padL;
      const innerW = Math.max(8, boxW - padL - padR);

      interface RenderedPara {
        spaceBefore: number;
        spaceAfter: number;
        lineH: number;
        fontSize: number;
        align: string;
        contentStartX: number;
        bullet?: { text: string; font: PDFFont; size: number; color: ReturnType<typeof rgb>; x: number };
        lines: Array<Array<{ text: string; font: PDFFont; size: number; color: ReturnType<typeof rgb>; width: number; underline?: boolean }>>;
      }

      const parasNode = childOf(tbNode, 'Paragraphs');
      const renderedParas: RenderedPara[] = [];

      const paras = childrenOf(parasNode, 'Paragraph');
      const isSingleLineFixedBox =
        defaultPadPt === 0 &&
        textOf(tbNode, 'CanGrow').toLowerCase() === 'false' &&
        paras.length === 1;

      for (const p of paras) {
        const ps = parseStyle(childOf(p, 'Style'));
        const leftIndentPt = dimToPt(ps.LeftIndent as string | undefined, 0);
        const hangingPt = dimToPt(ps.HangingIndent as string | undefined, 0);
        const spaceBefore = dimToPt(ps.SpaceBefore as string | undefined, 0);
        const spaceAfter = dimToPt(ps.SpaceAfter as string | undefined, 0);
        const align = String(ps.TextAlign || 'Left');
        const runs = childrenOf(childOf(p, 'TextRuns'), 'TextRun');

        const segs = runs.map((r) => {
          const rs = parseStyle(childOf(r, 'Style'));
          const size = Math.max(4, dimToPt(rs.FontSize as string | undefined, 7.5));
          const bold = rs.FontWeight === 'Bold';
          const italic = rs.FontStyle === 'Italic';
          const underline = rs.TextDecoration === 'Underline';
          const ff = String(rs.FontFamily || 'Arial');
          const { font, isTtf } = pickFont(ff, bold, italic);
          const color = parseColorRgb((rs.Color as string | undefined) || '#2C2E35') ?? rgb(0.17, 0.18, 0.21);
          const text = this.evalExpr(ctx, textOf(r, 'Value'), pageNum, totalPages, rowFields);
          return { text, font, isTtf, size, color, underline };
        });

        const baseFontSize = segs[0]?.size ?? 7.5;
        const explicitLineH = dimToPt(ps.LineHeight as string | undefined, 0);
        const lineH = explicitLineH > 0 ? explicitLineH : baseFontSize * 1.24;

        let bullet: RenderedPara['bullet'];
        let bodySegs = segs;
        let contentStartX = innerX + Math.max(0, leftIndentPt);
        let wrapWidth = Math.max(8, innerW - Math.max(0, leftIndentPt));

        if (leftIndentPt > 0 && hangingPt < 0 && segs.length > 0 && segs[0].text.endsWith('\t')) {
          const bLabel = sanitizeTextForFont(segs[0].font, segs[0].text.slice(0, -1), segs[0].isTtf);
          bullet = {
            text: bLabel,
            font: segs[0].font,
            size: segs[0].size,
            color: segs[0].color,
            x: innerX + Math.max(0, leftIndentPt + hangingPt),
          };
          bodySegs = segs.slice(1);
        } else if (leftIndentPt > 0 && hangingPt !== 0) {
          contentStartX = innerX + Math.max(0, leftIndentPt);
          wrapWidth = Math.max(8, innerW - Math.max(0, leftIndentPt));
        }

        if (
          isSingleLineFixedBox &&
          boxH < baseFontSize * 1.9 &&
          !bodySegs.some((s) => s.text.includes('\n'))
        ) {
          wrapWidth = 10000;
        }

        const lines = wrapParagraphSegments(bodySegs, wrapWidth);
        renderedParas.push({
          spaceBefore,
          spaceAfter,
          lineH,
          fontSize: baseFontSize,
          align,
          contentStartX,
          bullet,
          lines,
        });
      }

      const totalContentH = renderedParas.reduce(
        (sum, p) => sum + p.spaceBefore + p.lines.length * p.lineH + p.spaceAfter,
        0
      );
      const innerH = Math.max(1, boxH - padT - padB);
      let cursorTopPt = boxTopPt + padT;
      if (vAlign === 'Middle') {
        cursorTopPt = boxTopPt + padT + Math.max(0, (innerH - totalContentH) / 2);
      } else if (vAlign === 'Bottom') {
        cursorTopPt = boxTopPt + padT + Math.max(0, innerH - totalContentH);
      }

      for (const para of renderedParas) {
        cursorTopPt += para.spaceBefore;
        para.lines.forEach((line, lIdx) => {
          const baselineFromTopPt = cursorTopPt + para.fontSize * 0.85;
          const pdfY = ctx.pageHPt - baselineFromTopPt;

          if (lIdx === 0 && para.bullet) {
            page.drawText(para.bullet.text, {
              x: para.bullet.x,
              y: pdfY,
              size: para.bullet.size,
              font: para.bullet.font,
              color: para.bullet.color,
            });
          }

          const lineW = line.reduce((s, t) => s + t.width, 0);
          const availW = Math.max(8, innerX + innerW - para.contentStartX);
          let drawX = para.contentStartX;
          if (/^Center$/i.test(para.align)) {
            drawX = para.contentStartX + Math.max(0, (availW - lineW) / 2);
          } else if (/^Right$/i.test(para.align)) {
            drawX = para.contentStartX + Math.max(0, availW - lineW);
          }

          for (const seg of line) {
            if (seg.text.length > 0) {
              page.drawText(seg.text, {
                x: drawX,
                y: pdfY,
                size: seg.size,
                font: seg.font,
                color: seg.color,
              });
              if (seg.underline && seg.width > 0 && seg.text.trim().length > 0) {
                page.drawLine({
                  start: { x: drawX, y: pdfY - Math.max(0.8, seg.size * 0.12) },
                  end: { x: drawX + seg.width, y: pdfY - Math.max(0.8, seg.size * 0.12) },
                  thickness: Math.max(0.45, seg.size * 0.06),
                  color: seg.color,
                });
              }
            }
            drawX += seg.width;
          }
          cursorTopPt += para.lineH;
        });
        cursorTopPt += para.spaceAfter;
      }
    };

    const drawEmbeddedImage = (
      page: PDFPage,
      imNode: OrderedNode,
      x: number,
      topPt: number,
      w: number,
      h: number
    ) => {
      const imgKey = textOf(imNode, 'Value');
      const sizing = textOf(imNode, 'Sizing') || 'FitProportional';
      const pdfImg = pdfImages.get(imgKey);
      if (!pdfImg) {
        page.drawRectangle({
          x,
          y: ctx.pageHPt - topPt - h,
          width: w,
          height: h,
          borderColor: rgb(0.58, 0.64, 0.72),
          borderWidth: 0.5,
        });
        return;
      }
      if (sizing === 'Fit' || pdfImg.width === 0 || pdfImg.height === 0) {
        page.drawImage(pdfImg, { x, y: ctx.pageHPt - topPt - h, width: w, height: h });
        return;
      }
      const scale = Math.min(w / pdfImg.width, h / pdfImg.height);
      const dw = pdfImg.width * scale;
      const dh = pdfImg.height * scale;
      const dx = x + (w - dw) / 2;
      const dyTop = topPt + (h - dh) / 2;
      page.drawImage(pdfImg, { x: dx, y: ctx.pageHPt - dyTop - dh, width: dw, height: dh });
    };

    const drawTablix = (
      page: PDFPage,
      tblNode: OrderedNode,
      x: number,
      topPt: number,
      pageNum: number
    ) => {
      const tBody = childOf(tblNode, 'TablixBody');
      const colWidthsPt = childrenOf(childOf(tBody, 'TablixColumns'), 'TablixColumn').map((c) =>
        Math.max(2, dimToPt(textOf(c, 'Width'), 36))
      );
      const expandedRows = this.expandTablixRows(tblNode, ctx);
      const rowHeightsPt = expandedRows.map(({ rowNode }) =>
        Math.max(4, dimToPt(textOf(rowNode, 'Height'), 14))
      );
      const covered = Array.from({ length: expandedRows.length }, () =>
        Array(colWidthsPt.length).fill(false)
      );

      let curY = topPt;
      expandedRows.forEach(({ rowNode: r, rowFields }, rIdx) => {
        const rowH = rowHeightsPt[rIdx] ?? 14;
        const cells = childrenOf(childOf(r, 'TablixCells'), 'TablixCell');

        let curX = x;
        cells.forEach((cell, cIdx) => {
          const colW = colWidthsPt[cIdx] ?? 36;
          if (covered[rIdx]?.[cIdx]) {
            curX += colW;
            return;
          }
          const cc = childOf(cell, 'CellContents');
          const cs = Math.max(1, Number(textOf(cc, 'ColSpan') || 1));
          const rs = Math.max(1, Number(textOf(cc, 'RowSpan') || 1));
          for (let rr = rIdx; rr < Math.min(expandedRows.length, rIdx + rs); rr++) {
            for (let ccIdx = cIdx; ccIdx < Math.min(colWidthsPt.length, cIdx + cs); ccIdx++) {
              if (rr !== rIdx || ccIdx !== cIdx) covered[rr][ccIdx] = true;
            }
          }

          const spanW = colWidthsPt
            .slice(cIdx, Math.min(colWidthsPt.length, cIdx + cs))
            .reduce((a, b) => a + b, 0);
          const spanH = rowHeightsPt
            .slice(rIdx, Math.min(expandedRows.length, rIdx + rs))
            .reduce((a, b) => a + b, 0);

          if (cc) {
            const subTbl = childOf(cc, 'Tablix');
            const subRect = childOf(cc, 'Rectangle');
            const tb = childOf(cc, 'Textbox');
            const img = childOf(cc, 'Image');
            if (subTbl) {
              drawTablix(page, subTbl, curX, curY, pageNum);
            } else if (subRect) {
              const st = parseStyle(childOf(subRect, 'Style'));
              drawStyledBox(page, curX, curY, spanW, spanH, st, ctx.pageHPt);
              const nested = childrenOf(childOf(subRect, 'ReportItems')).map((n) => ({ node: n, topOffsetPt: 0 }));
              drawNodeList(page, nested, curX, curY, pageNum);
            } else if (tb) {
              const st = parseStyle(childOf(tb, 'Style'));
              drawStyledBox(page, curX, curY, spanW, spanH, st, ctx.pageHPt);
              drawTextboxText(page, tb, curX, curY, spanW, spanH, 2, 'Middle', pageNum, rowFields);
            } else if (img) {
              const sizing = textOf(img, 'Sizing') || 'FitProportional';
              if (sizing === 'Fit') {
                drawEmbeddedImage(page, img, curX, curY, spanW, spanH);
              } else {
                drawEmbeddedImage(page, img, curX + 1, curY + 1, Math.max(2, spanW - 2), Math.max(2, spanH - 2));
              }
            }
          }
          curX += colW;
        });
        curY += rowH;
      });
    };

    const drawNodeList = (
      page: PDFPage,
      nodes: Array<{ node: OrderedNode; topOffsetPt: number }>,
      originX: number,
      originTopPt: number,
      pageNum: number
    ) => {
      const ordered = [...nodes].sort((a, b) => this.zIndexOf(a.node) - this.zIndexOf(b.node));
      for (const { node, topOffsetPt } of ordered) {
        const k = tagName(node);
        const x = originX + dimToPt(textOf(node, 'Left'), 0);
        const topPt = originTopPt + Math.max(0, dimToPt(textOf(node, 'Top'), 0) - topOffsetPt);
        const w = Math.max(0, dimToPt(textOf(node, 'Width'), 0));
        const h = Math.max(0, dimToPt(textOf(node, 'Height'), 0));

        if (k === 'Rectangle') {
          const st = parseStyle(childOf(node, 'Style'));
          drawStyledBox(page, x, topPt, w, h, st, ctx.pageHPt);
          const nested = childrenOf(childOf(node, 'ReportItems')).map((n) => ({ node: n, topOffsetPt: 0 }));
          drawNodeList(page, nested, x, topPt, pageNum);
        } else if (k === 'Textbox') {
          const st = parseStyle(childOf(node, 'Style'));
          drawStyledBox(page, x, topPt, w, h, st, ctx.pageHPt);
          drawTextboxText(page, node, x, topPt, w, h, 0, 'Top', pageNum);
        } else if (k === 'Image') {
          drawEmbeddedImage(page, node, x, topPt, w, h);
        } else if (k === 'Tablix') {
          drawTablix(page, node, x, topPt, pageNum);
        }
      }
    };

    for (const slice of ctx.pages) {
      const pdfPage = pdfDoc.addPage([ctx.pageWPt, ctx.pageHPt]);
      pdfPage.drawRectangle({
        x: 0,
        y: 0,
        width: ctx.pageWPt,
        height: ctx.pageHPt,
        color: rgb(1, 1, 1),
      });

      const showHeader =
        Boolean(ctx.headerItemsNode) &&
        !(slice.pageNum === 1 && !ctx.headerPrintOnFirstPage) &&
        !(slice.pageNum === totalPages && !ctx.headerPrintOnLastPage);
      const showFooter =
        Boolean(ctx.footerItemsNode) &&
        !(slice.pageNum === 1 && !ctx.footerPrintOnFirstPage) &&
        !(slice.pageNum === totalPages && !ctx.footerPrintOnLastPage);

      if (showHeader && ctx.headerItemsNode) {
        const headerNodes = childrenOf(ctx.headerItemsNode).map((n) => ({ node: n, topOffsetPt: 0 }));
        drawNodeList(pdfPage, headerNodes, ctx.leftMPt, ctx.topMPt, slice.pageNum);
      }

      const bodyOriginTop = ctx.topMPt + (showHeader ? ctx.headerHPt : 0);
      drawNodeList(pdfPage, slice.items, ctx.leftMPt, bodyOriginTop, slice.pageNum);

      if (showFooter && ctx.footerItemsNode) {
        const footerNodes = childrenOf(ctx.footerItemsNode).map((n) => ({ node: n, topOffsetPt: 0 }));
        const footerOriginTop = ctx.pageHPt - ctx.bottomMPt - ctx.footerHPt;
        drawNodeList(pdfPage, footerNodes, ctx.leftMPt, footerOriginTop, slice.pageNum);
      }
    }

    const bytes = await pdfDoc.save();
    this.logger.info('RdlcPreviewRenderer', 'Rendered coordinate-locked RDLC binary PDF', {
      pageCount: totalPages,
      bytes: bytes.byteLength,
    });
    return bytes;
  }
}
