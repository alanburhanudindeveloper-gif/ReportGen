import crypto from 'crypto';
import {
  CalculationRuleDef,
  ExistingProjectPattern,
  IntermediateLayoutModel,
  LayoutPage,
  LayoutRegion,
  RegionStyle,
  ReportDefinition,
  ReportFieldDef,
  ReportParameterDef,
  ReconstructedBand,
  StructuredLogger,
  TablixCell,
  TablixRegion,
  TablixRow,
  VisualImageItem,
  VisualPageLayer,
  VisualRectItem,
  VisualTextboxItem,
  VisualTextRun,
} from '../core/types.ts';
import { createParameterDetectionContext, parameterizeTextRuns } from './parameterDetector.ts';
import { V3TablixCompiler } from './v3TablixCompiler.ts';

function sanitizeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `F_${cleaned}` : cleaned;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function roundIn(val: number): number {
  return Math.round(val * 1000) / 1000;
}

export class TablixBuilder {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public buildReportDefinition(
    layout: IntermediateLayoutModel,
    existingPattern?: ExistingProjectPattern
  ): ReportDefinition {
    const dataSourceName = existingPattern?.dataSourceName ?? 'dsReportSource';
    const dataSetName = existingPattern?.dataSetName ?? 'dsReportData';
    const reportName = sanitizeIdentifier(layout.document.name, 'GeneratedReport');

    const fieldMap = new Map<string, ReportFieldDef>();
    const existingParams: ReportParameterDef[] = [];

    for (const existingField of existingPattern?.fields ?? []) {
      fieldMap.set(existingField, {
        name: existingField,
        dataType: /amount|price|total|qty|discount|tax|rate/i.test(existingField)
          ? 'System.Decimal'
          : 'System.String',
        sampleValue: /amount|price|total|qty|discount|tax|rate/i.test(existingField) ? 0 : 'Sample',
        isCalculated: /total|net|tax|subtotal/i.test(existingField),
      });
    }

    for (const existingParam of existingPattern?.parameters ?? []) {
      existingParams.push({
        name: existingParam,
        dataType: 'String',
        prompt: existingParam,
        defaultValue: '',
      });
    }

    const paramCtx = createParameterDetectionContext(existingParams);

    // Single-RDLC v2 engine always uses 0in page margins so ReportSection.Width == PageWidth
    const hasAnyLayer0 = layout.pages.some((p) => Boolean(p.layer0BackgroundBase64));
    const marginsIn = { top: 0, right: 0, bottom: 0, left: 0 };

    const printableWidthIn = Math.max(
      1.5,
      layout.document.pageWidth - marginsIn.left - marginsIn.right
    );
    const printableHeightIn = Math.max(
      2.0,
      layout.document.pageHeight - marginsIn.top - marginsIn.bottom
    );

    const tablixRegions: TablixRegion[] = [];
    const visualPages: VisualPageLayer[] = [];
    const pageTablixesByPage = new Map<number, TablixRegion[]>();
    const tablixBoundsByPage = new Map<number, Array<{ x1: number; y1: number; x2: number; y2: number }>>();
    const sampleDetailRows: Array<Record<string, string | number>> = [];
    let nameCounter = 1;
    const nextUniqueName = (prefix: string): string => `${prefix}_${nameCounter++}`;

    const embeddedImages: Array<{ name: string; mimeType: string; base64Data: string }> = [];
    const seenImageNames = new Set<string>();
    const shaToImageName = new Map<string, string>();

    const registerEmbeddedImage = (base64Data: string, preferredName: string): string => {
      const sha = crypto.createHash('sha256').update(base64Data).digest('hex');
      const existing = shaToImageName.get(sha);
      if (existing) return existing;
      let imgName = sanitizeIdentifier(preferredName, `Graphic_${nameCounter}`);
      while (seenImageNames.has(imgName)) {
        imgName = `${sanitizeIdentifier(preferredName, 'Graphic')}_${nameCounter++}`;
      }
      seenImageNames.add(imgName);
      shaToImageName.set(sha, imgName);
      embeddedImages.push({
        name: imgName,
        mimeType: 'image/png',
        base64Data,
      });
      return imgName;
    };

    for (const page of layout.pages) {
      const hasLayer0 = Boolean(page.layer0BackgroundBase64);
      const regionById = new Map<string, LayoutRegion>();
      for (const r of page.regions) {
        regionById.set(r.id, { ...r });
      }

      const allRegions = Array.from(regionById.values());
      const vectorRects = allRegions.filter((r) => r.type === 'vector_rect');

      // Convert genuine repeating detail tables (or bordered tabular grids) to native <Tablix>
      const tableBands = page.bands.filter((band) =>
        hasLayer0 ? band.isRepeatingDetail : this.isGenuineTableBand(band, vectorRects, regionById)
      );

      const pageTablixes: TablixRegion[] = [];
      const tablixBounds: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

      for (const band of tableBands) {
        const built = this.buildTablixForBand(
          band,
          page,
          regionById,
          vectorRects,
          fieldMap,
          dataSetName,
          marginsIn,
          printableWidthIn,
          printableHeightIn,
          existingPattern,
          nextUniqueName,
          registerEmbeddedImage,
          hasLayer0
        );
        if (!built) continue;

        const { tablix, extractedDetailRows } = built;
        if (extractedDetailRows.length > 0 && sampleDetailRows.length === 0) {
          sampleDetailRows.push(...extractedDetailRows);
        }

        const pageRelTop = roundIn(
          clamp(tablix.topIn - (page.pageNumber - 1) * page.height, 0, printableHeightIn - 0.2)
        );
        const clampedTablix: TablixRegion = {
          ...tablix,
          topIn: pageRelTop,
          zIndex: 1,
        };
        pageTablixes.push(clampedTablix);
        tablixRegions.push(tablix);
        tablixBounds.push({
          x1: clampedTablix.leftIn,
          y1: clampedTablix.topIn,
          x2: clampedTablix.leftIn + clampedTablix.widthIn,
          y2: clampedTablix.topIn + clampedTablix.heightIn,
        });
      }

      pageTablixesByPage.set(page.pageNumber, pageTablixes);
      tablixBoundsByPage.set(page.pageNumber, tablixBounds);

      const isCoveredByTablix = (relX: number, relY: number, w: number, h: number): boolean => {
        const cx = relX + w / 2;
        const cy = relY + h / 2;
        return tablixBounds.some(
          (b) =>
            cx >= b.x1 - 0.02 &&
            cx <= b.x2 + 0.02 &&
            cy >= b.y1 - 0.02 &&
            cy <= b.y2 + 0.02
        );
      };

      // Layer 0 Background Image or Fallback Vector Rectangles
      const visualImages: VisualImageItem[] = [];
      const dedupedRects: VisualRectItem[] = [];

      if (hasLayer0 && page.layer0BackgroundBase64) {
        const bgName = registerEmbeddedImage(
          page.layer0BackgroundBase64,
          page.layer0ImageName ?? `Layer0_Page_${page.pageNumber}`
        );
        visualImages.push({
          kind: 'Image',
          name: `Img_Layer0_P${page.pageNumber}`,
          embeddedImageName: bgName,
          leftIn: 0,
          topIn: 0,
          widthIn: roundIn(printableWidthIn),
          heightIn: roundIn(printableHeightIn),
          sizing: 'Fit',
          zIndex: 0,
        });

        // Emit only broken ToUnicode glyph fallback crops at ZIndex=2 above Layer 0
        for (const r of allRegions) {
          if (
            r.type === 'image' &&
            r.imageAssetBase64 &&
            r.sourceObjectRefs.some((ref) => ref.includes('-glyph-'))
          ) {
            const x1 = clamp(r.x - marginsIn.left, 0, printableWidthIn - 0.05);
            const y1 = clamp(r.y - marginsIn.top, 0, printableHeightIn - 0.05);
            const w = roundIn(clamp(r.width, 0.06, printableWidthIn - x1));
            const h = roundIn(clamp(r.height, 0.06, printableHeightIn - y1));
            const embName = registerEmbeddedImage(
              r.imageAssetBase64,
              r.imageAssetName ?? `GlyphCrop_P${page.pageNumber}_${nameCounter}`
            );
            visualImages.push({
              kind: 'Image',
              name: nextUniqueName('ImgGlyph'),
              embeddedImageName: embName,
              leftIn: roundIn(x1),
              topIn: roundIn(y1),
              widthIn: w,
              heightIn: h,
              sizing: 'Fit',
              zIndex: 2,
            });
          }
        }
      } else {
        // Fallback vector rect + cropped graphic mode when Layer 0 background is absent
        const visualRectangles: VisualRectItem[] = [];
        for (const r of allRegions) {
          if (r.type !== 'vector_rect' && r.type !== 'vector_line') continue;
          const x1 = clamp(r.x - marginsIn.left, 0, printableWidthIn);
          const y1 = clamp(r.y - marginsIn.top, 0, printableHeightIn);
          const x2 = clamp(r.x + r.width - marginsIn.left, 0, printableWidthIn);
          const y2 = clamp(r.y + r.height - marginsIn.top, 0, printableHeightIn);
          let w = roundIn(x2 - x1);
          let h = roundIn(y2 - y1);

          if (r.type === 'vector_line') {
            const horizontal = r.width >= r.height;
            if (horizontal) {
              if (w < 0.05) continue;
              h = Math.max(0.015, h);
            } else {
              if (h < 0.05) continue;
              w = Math.max(0.015, w);
            }
            if (isCoveredByTablix(x1, y1, w, h)) continue;
            const lineColor = r.style.borderColor ?? r.style.backgroundColor ?? '#CBD5E1';
            visualRectangles.push({
              kind: 'Rectangle',
              name: nextUniqueName('LineRect'),
              leftIn: roundIn(x1),
              topIn: roundIn(y1),
              widthIn: roundIn(Math.min(w, printableWidthIn - x1)),
              heightIn: roundIn(Math.min(h, printableHeightIn - y1)),
              backgroundColor: lineColor,
              zIndex: 0,
            });
            continue;
          }

          if (w <= 0.01 || h <= 0.01) continue;
          const bg = r.style.backgroundColor;
          const bc = r.style.borderColor;
          if (!bg && !bc) continue;
          if (
            w >= printableWidthIn - 0.12 &&
            h >= printableHeightIn - 0.12 &&
            (!bg || bg.toUpperCase() === '#FFFFFF') &&
            !bc
          ) {
            continue;
          }
          if (isCoveredByTablix(x1, y1, w, h)) continue;

          visualRectangles.push({
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
          });
        }

        const shapeRects = visualRectangles.filter((v) => !v.name.startsWith('LineRect_'));
        const lineRects = visualRectangles.filter((v) => v.name.startsWith('LineRect_'));
        for (const rect of [...shapeRects, ...lineRects]) {
          const dupIdx = dedupedRects.findIndex(
            (prev) =>
              Math.abs(prev.leftIn - rect.leftIn) <= 0.015 &&
              Math.abs(prev.topIn - rect.topIn) <= 0.015 &&
              Math.abs(prev.widthIn - rect.widthIn) <= 0.02 &&
              Math.abs(prev.heightIn - rect.heightIn) <= 0.02
          );
          if (dupIdx >= 0) {
            dedupedRects[dupIdx] = {
              ...dedupedRects[dupIdx],
              backgroundColor: rect.backgroundColor ?? dedupedRects[dupIdx].backgroundColor,
              borderColor: rect.borderColor ?? dedupedRects[dupIdx].borderColor,
              borderWidthPt: rect.borderWidthPt ?? dedupedRects[dupIdx].borderWidthPt,
            };
          } else {
            dedupedRects.push(rect);
          }
        }

        for (const r of allRegions) {
          if ((r.type !== 'image' && r.type !== 'vector_complex') || !r.imageAssetBase64) continue;
          const x1 = clamp(r.x - marginsIn.left, 0, printableWidthIn - 0.05);
          const y1 = clamp(r.y - marginsIn.top, 0, printableHeightIn - 0.05);
          const w = roundIn(clamp(r.width, 0.08, printableWidthIn - x1));
          const h = roundIn(clamp(r.height, 0.08, printableHeightIn - y1));
          if (isCoveredByTablix(x1, y1, w, h)) continue;

          const embName = registerEmbeddedImage(
            r.imageAssetBase64,
            r.imageAssetName ?? `Graphic_P${page.pageNumber}_${nameCounter}`
          );
          visualImages.push({
            kind: 'Image',
            name: nextUniqueName('Img'),
            embeddedImageName: embName,
            leftIn: roundIn(x1),
            topIn: roundIn(y1),
            widthIn: w,
            heightIn: h,
            sizing: 'FitProportional',
            zIndex: 1,
          });
        }
      }

      // Layer 1: Native coordinate-locked Textboxes + Parameterization
      const rawTextRegions = allRegions
        .filter((r) => r.type === 'text' && r.text && r.text.trim().length > 0)
        .filter((r) => {
          const rx = clamp(r.x - marginsIn.left, 0, printableWidthIn);
          const ry = clamp(r.y - marginsIn.top, 0, printableHeightIn);
          return !isCoveredByTablix(rx, ry, r.width, r.height);
        })
        .sort((a, b) => (Math.abs(a.y - b.y) <= 0.06 ? a.x - b.x : a.y - b.y));

      const visualTextboxes: VisualTextboxItem[] = [];
      for (let i = 0; i < rawTextRegions.length; i++) {
        const r = rawTextRegions[i];
        let relX = clamp(r.x - marginsIn.left, 0, printableWidthIn - 0.1);
        const relY = clamp(r.y - marginsIn.top, 0, printableHeightIn - 0.1);

        let nextLeft = printableWidthIn;
        for (let j = i + 1; j < rawTextRegions.length; j++) {
          const sib = rawTextRegions[j];
          if (sib.y - r.y > 0.1) break;
          const sibRelX = sib.x - marginsIn.left;
          if (Math.abs(sib.y - r.y) <= 0.08 && sibRelX > relX + r.width * 0.4) {
            nextLeft = Math.min(nextLeft, sibRelX - 0.02);
            break;
          }
        }

        // Check if previous sibling on the same line is a "Label:"
        let precedingLabel: string | undefined;
        if (i > 0) {
          const prev = rawTextRegions[i - 1];
          if (
            Math.abs(prev.y - r.y) <= 0.06 &&
            prev.x < r.x &&
            prev.text &&
            prev.text.trim().endsWith(':') &&
            prev.text.trim().length <= 32
          ) {
            precedingLabel = prev.text.trim();
          }
        }

        const align = r.style.textAlign ?? 'Left';
        // Provide mild width headroom to absorb StandardFonts width variance without wrapping
        let boxW = r.width + 0.18;
        if (align === 'Center') {
          const shift = Math.min(0.04, relX);
          relX = relX - shift;
        } else if (align === 'Right') {
          const shift = Math.min(0.08, relX);
          relX = relX - shift;
        }
        boxW = clamp(boxW, 0.08, Math.max(0.08, nextLeft - relX));

        const minFontHeightIn = Math.max(r.height, (r.style.fontSizePt / 72) * 1.28);
        const boxH = clamp(minFontHeightIn, 0.11, printableHeightIn - relY);

        const baseRuns: VisualTextRun[] =
          r.runs && r.runs.length > 0
            ? r.runs
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

        const boundRuns = parameterizeTextRuns(paramCtx, baseRuns, page.pageNumber, precedingLabel);

        const cleanStyle: RegionStyle = {
          ...r.style,
          backgroundColor: undefined,
          borderColor: undefined,
          borderWidthPt: undefined,
          verticalAlign: 'Top',
          paddingPt: { top: 0, right: 0, bottom: 0, left: 0 },
        };

        visualTextboxes.push({
          kind: 'Textbox',
          name: nextUniqueName('Txt'),
          leftIn: roundIn(relX),
          topIn: roundIn(relY),
          widthIn: roundIn(boxW),
          heightIn: roundIn(boxH),
          text: r.text ?? '',
          runs: boundRuns,
          style: cleanStyle,
          zIndex: 1,
        });
      }

      visualPages.push({
        pageNumber: page.pageNumber,
        widthIn: printableWidthIn,
        heightIn: printableHeightIn,
        rectangles: dedupedRects,
        images: visualImages,
        textboxes: visualTextboxes,
        tablixes: pageTablixes,
      });
    }

    // Compile Single-RDLC v3 Full-Tablix hierarchy (100% <Tablix> body + native <PageHeader>/<PageFooter>)
    const v3Compiler = new V3TablixCompiler(this.logger);
    const v3Result = v3Compiler.compile({
      pages: layout.pages,
      pageWidthIn: printableWidthIn,
      pageHeightIn: printableHeightIn,
      dataSetName,
      pageTablixesByPage,
      coveredByTablixFn: (pNum, x, y, w, h) => {
        const bounds = tablixBoundsByPage.get(pNum) ?? [];
        const cx = x + w / 2;
        const cy = y + h / 2;
        return bounds.some(
          (b) => cx >= b.x1 - 0.02 && cx <= b.x2 + 0.02 && cy >= b.y1 - 0.02 && cy <= b.y2 + 0.02
        );
      },
      paramCtx,
      registerEmbeddedImage,
      nextUniqueName,
      fieldMap,
    });

    if (paramCtx.parameters.size === 0) {
      paramCtx.parameters.set('ReportTitle', {
        name: 'ReportTitle',
        dataType: 'String',
        prompt: 'Report Title',
        defaultValue: layout.document.name,
        matchedPattern: 'title',
        pageNumber: 1,
      });
    }

    if (fieldMap.size === 0) {
      fieldMap.set('Description', {
        name: 'Description',
        dataType: 'System.String',
        sampleValue: 'Item A',
        isCalculated: false,
      });
      fieldMap.set('Qty', {
        name: 'Qty',
        dataType: 'System.Decimal',
        sampleValue: 1,
        isCalculated: false,
      });
      fieldMap.set('Price', {
        name: 'Price',
        dataType: 'System.Decimal',
        sampleValue: 100,
        isCalculated: false,
      });
      fieldMap.set('Total', {
        name: 'Total',
        dataType: 'System.Decimal',
        sampleValue: 100,
        isCalculated: true,
      });
    }

    const calculations = this.deriveCalculationRules(Array.from(fieldMap.values()));

    this.logger.info('TablixBuilder', 'Single-RDLC v3 Full-Tablix model constructed', {
      bodyTablixCount: v3Result.bodyTablixes.length,
      repeatingTablixCount: tablixRegions.length,
      hasPageHeader: Boolean(v3Result.pageHeaderSpec),
      hasPageFooter: Boolean(v3Result.pageFooterSpec),
      embeddedImages: embeddedImages.length,
      parameters: paramCtx.parameters.size,
      fields: fieldMap.size,
      calculations: calculations.length,
    });

    return {
      reportName,
      dataSourceName,
      dataSetName,
      pageWidthIn: layout.document.pageWidth,
      pageHeightIn: layout.document.pageHeight,
      marginsIn,
      fields: Array.from(fieldMap.values()),
      parameters: Array.from(paramCtx.parameters.values()),
      calculations,
      tablixRegions: tablixRegions.length > 0 ? tablixRegions : v3Result.bodyTablixes,
      embeddedImages,
      existingPatternUsed: existingPattern?.sourceFiles.join(', ') || undefined,
      visualPages,
      pageHeaderSpec: v3Result.pageHeaderSpec,
      pageFooterSpec: v3Result.pageFooterSpec,
      bodyTablixes: v3Result.bodyTablixes,
      hierarchy: v3Result.hierarchy,
      sampleDetailRows: sampleDetailRows.length > 0 ? sampleDetailRows : undefined,
    };
  }

  private isGenuineTableBand(
    band: ReconstructedBand,
    vectorRects: LayoutRegion[],
    regionById: Map<string, LayoutRegion>
  ): boolean {
    if (band.isRepeatingDetail) return true;
    const numCols = band.columnWidths.length;
    const numRows = band.rowHeights.length;
    if (band.bandKind === 'Header' || band.bandKind === 'Footer' || band.bandKind === 'Cards') {
      return false;
    }
    if (numCols < 2 || numCols > 20 || numRows < 2) {
      return false;
    }

    // Do not collapse multi-column prose blocks into a flat Tablix; keep them as Dual-Column sections
    const hasLongProse = band.sourceRegionIds.some((id) => {
      const reg = regionById.get(id);
      return Boolean(reg?.text && reg.text.length > 160);
    });
    if (hasLongProse) return false;

    const bandRects = vectorRects.filter(
      (r) =>
        r.x >= band.x - 0.08 &&
        r.x + r.width <= band.x + band.width + 0.08 &&
        r.y >= band.y - 0.08 &&
        r.y + r.height <= band.y + band.height + 0.08 &&
        r.height >= 0.14 &&
        r.height <= 1.1 &&
        r.width >= 0.35 &&
        Boolean(r.style.backgroundColor || r.style.borderColor)
    );

    if (bandRects.length < 4) return false;

    const distinctYs: number[] = [];
    for (const r of bandRects) {
      if (!distinctYs.some((y) => Math.abs(y - r.y) <= 0.08)) {
        distinctYs.push(r.y);
      }
    }
    return distinctYs.length >= 2;
  }

  private buildTablixForBand(
    band: ReconstructedBand,
    page: LayoutPage,
    regionById: Map<string, LayoutRegion>,
    vectorRects: LayoutRegion[],
    fieldMap: Map<string, ReportFieldDef>,
    dataSetName: string,
    marginsIn: { top: number; right: number; bottom: number; left: number },
    printableWidthIn: number,
    printableHeightIn: number,
    existingPattern: ExistingProjectPattern | undefined,
    nextUniqueName: (prefix: string) => string,
    registerEmbeddedImage: (b64: string, name: string) => string,
    hasLayer0: boolean
  ): { tablix: TablixRegion; extractedDetailRows: Array<Record<string, string | number>> } | undefined {
    if (band.isRepeatingDetail) {
      return this.buildRepeatingLogicalTablix(
        band,
        page,
        regionById,
        vectorRects,
        fieldMap,
        dataSetName,
        marginsIn,
        printableWidthIn,
        printableHeightIn,
        nextUniqueName,
        hasLayer0
      );
    }

    const numCols = band.columnWidths.length;
    const numRows = band.rowHeights.length;
    if (numCols === 0 || numRows === 0) return undefined;

    const cellLookup = new Map(band.cells.map((c) => [`${c.row}:${c.col}`, c]));
    const skippedCoords = new Set<string>();
    const rows: TablixRow[] = [];

    const findEnclosingRectForCell = (rIdx: number, cIdx: number, colSpan: number, rowSpan: number): LayoutRegion | undefined => {
      const x1 = band.columnBoundaries[cIdx] ?? band.x;
      const x2 = band.columnBoundaries[Math.min(band.columnBoundaries.length - 1, cIdx + colSpan)] ?? band.x + band.width;
      const y1 = band.rowBoundaries[rIdx] ?? band.y;
      const y2 = band.rowBoundaries[Math.min(band.rowBoundaries.length - 1, rIdx + rowSpan)] ?? band.y + band.height;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      return vectorRects
        .filter(
          (vr) =>
            cx >= vr.x - 0.04 &&
            cx <= vr.x + vr.width + 0.04 &&
            cy >= vr.y - 0.04 &&
            cy <= vr.y + vr.height + 0.04 &&
            vr.height <= (y2 - y1) * 2.6 + 0.25 &&
            (vr.style.backgroundColor || vr.style.borderColor)
        )
        .sort((a, b) => a.width * a.height - b.width * b.height)[0];
    };

    for (let rIdx = 0; rIdx < numRows; rIdx++) {
      const rowCells: TablixCell[] = [];
      for (let cIdx = 0; cIdx < numCols; cIdx++) {
        const key = `${rIdx}:${cIdx}`;
        if (skippedCoords.has(key)) {
          rowCells.push({
            colIndex: cIdx,
            rowIndex: rIdx,
            colSpan: 1,
            rowSpan: 1,
            skipBecauseMerged: true,
            content: { kind: 'Empty', name: nextUniqueName('Empty') },
          });
          continue;
        }

        const assigned = cellLookup.get(key);
        const colSpan = Math.min(numCols - cIdx, Math.max(1, assigned?.colSpan ?? 1));
        const rowSpan = Math.min(numRows - rIdx, Math.max(1, assigned?.rowSpan ?? 1));

        for (let rr = rIdx; rr < rIdx + rowSpan; rr++) {
          for (let cc = cIdx; cc < cIdx + colSpan; cc++) {
            if (rr !== rIdx || cc !== cIdx) {
              skippedCoords.add(`${rr}:${cc}`);
            }
          }
        }

        const region = assigned?.primaryRegionId
          ? regionById.get(assigned.primaryRegionId)
          : undefined;
        const cellRect = findEnclosingRectForCell(rIdx, cIdx, colSpan, rowSpan);

        if (region && (region.type === 'image' || region.preferImageFallback) && region.imageAssetBase64) {
          registerEmbeddedImage(
            region.imageAssetBase64,
            region.imageAssetName ?? `Graphic_P${page.pageNumber}_R${rIdx}C${cIdx}`
          );
          rowCells.push({
            colIndex: cIdx,
            rowIndex: rIdx,
            colSpan,
            rowSpan,
            skipBecauseMerged: false,
            content: {
              kind: 'Image',
              name: nextUniqueName('Img'),
              mimeType: 'image/png',
              base64Data: region.imageAssetBase64,
              sizing: 'FitProportional',
            },
          });
          continue;
        }

        if (region && region.type === 'text' && region.text) {
          let value = region.text;
          let isExpression = false;
          if (
            Boolean(existingPattern) &&
            (region.semanticRole === 'fieldValue' || region.semanticRole === 'calculationField')
          ) {
            const fieldName = sanitizeIdentifier(
              region.linkedField ?? `Field_${page.pageNumber}_${rIdx}_${cIdx}`,
              `Field_${page.pageNumber}_${rIdx}_${cIdx}`
            );
            const isNumeric = /^[\$\€\£]?\s*-?\d/.test(region.text.trim());
            if (!fieldMap.has(fieldName)) {
              fieldMap.set(fieldName, {
                name: fieldName,
                dataType: isNumeric ? 'System.Decimal' : 'System.String',
                sampleValue: isNumeric
                  ? Number(region.text.replace(/[^0-9.-]/g, '')) || 0
                  : region.text,
                isCalculated: region.semanticRole === 'calculationField',
              });
            }
            value =
              region.semanticRole === 'calculationField' && fieldMap.has('Qty') && fieldMap.has('Price')
                ? '=Code.CalculateNetTotal(Fields!Qty.Value, Fields!Price.Value, 0)'
                : `=Fields!${fieldName}.Value`;
            isExpression = true;
          }

          const cellStyle: RegionStyle = {
            ...region.style,
            backgroundColor: hasLayer0 ? undefined : region.style.backgroundColor ?? cellRect?.style.backgroundColor,
            borderColor: hasLayer0 ? undefined : region.style.borderColor ?? cellRect?.style.borderColor ?? '#CBD5E1',
            borderWidthPt: hasLayer0 ? undefined : region.style.borderWidthPt ?? cellRect?.style.borderWidthPt ?? 0.5,
          };

          rowCells.push({
            colIndex: cIdx,
            rowIndex: rIdx,
            colSpan,
            rowSpan,
            skipBecauseMerged: false,
            content: {
              kind: 'Textbox',
              name: nextUniqueName('Txt'),
              value,
              runs: isExpression ? undefined : region.runs,
              isExpression,
              style: cellStyle,
              canGrow: true,
            },
          });
          continue;
        }

        rowCells.push({
          colIndex: cIdx,
          rowIndex: rIdx,
          colSpan,
          rowSpan,
          skipBecauseMerged: false,
          content: {
            kind: 'Textbox',
            name: nextUniqueName('Cell'),
            value: '',
            isExpression: false,
            style: {
              fontFamily: 'Arial',
              fontSizePt: 9,
              bold: false,
              italic: false,
              color: '#0F172A',
              backgroundColor: hasLayer0 ? undefined : region?.style.backgroundColor ?? cellRect?.style.backgroundColor,
              borderColor: hasLayer0 ? undefined : region?.style.borderColor ?? cellRect?.style.borderColor ?? '#CBD5E1',
              borderWidthPt: hasLayer0 ? undefined : region?.style.borderWidthPt ?? cellRect?.style.borderWidthPt ?? 0.5,
              textAlign: 'Left',
              verticalAlign: 'Middle',
              paddingPt: { top: 1, right: 2, bottom: 1, left: 2 },
            },
            canGrow: true,
          },
        });
      }

      const rowHeightIn = Math.max(0.18, roundIn(band.rowHeights[rIdx] ?? 0.25));
      rows.push({
        heightIn: rowHeightIn,
        isDetailRow: false,
        cells: rowCells,
      });
    }

    const leftIn = clamp(roundIn(band.x - marginsIn.left), 0, Math.max(0, printableWidthIn - 0.5));
    const availableWidthIn = Math.max(0.5, printableWidthIn - leftIn - 0.01);

    let columnWidthsIn = band.columnWidths.map((w) => Math.max(0.08, roundIn(w)));
    const rawColSum = columnWidthsIn.reduce((s, w) => s + w, 0);
    if (rawColSum > availableWidthIn && rawColSum > 0) {
      const scale = availableWidthIn / rawColSum;
      columnWidthsIn = columnWidthsIn.map((w) => Math.max(0.06, roundIn(w * scale)));
      const scaledSum = columnWidthsIn.reduce((s, w) => s + w, 0);
      if (scaledSum > availableWidthIn && columnWidthsIn.length > 0) {
        let maxIdx = 0;
        for (let i = 1; i < columnWidthsIn.length; i++) {
          if (columnWidthsIn[i] > columnWidthsIn[maxIdx]) maxIdx = i;
        }
        const excess = scaledSum - availableWidthIn;
        columnWidthsIn[maxIdx] = Math.max(0.06, roundIn(columnWidthsIn[maxIdx] - excess));
      }
    }

    const pageRelTop = clamp(roundIn(band.y - marginsIn.top), 0, Math.max(0, printableHeightIn - 0.25));
    const availableHeightIn = Math.max(0.25, printableHeightIn - pageRelTop - 0.05);
    const rawRowSum = rows.reduce((s, r) => s + r.heightIn, 0);
    if (rawRowSum > availableHeightIn && rawRowSum > 0) {
      const scale = availableHeightIn / rawRowSum;
      for (const r of rows) {
        r.heightIn = Math.max(0.14, roundIn(r.heightIn * scale));
      }
    }

    const totalTablixWidth = roundIn(columnWidthsIn.reduce((s, w) => s + w, 0));
    const totalTablixHeight = roundIn(rows.reduce((s, r) => s + r.heightIn, 0));
    const docTopIn = roundIn((page.pageNumber - 1) * page.height + pageRelTop);

    return {
      tablix: {
        id: band.id,
        name: sanitizeIdentifier(band.name, nextUniqueName('Tablix')),
        pageNumber: page.pageNumber,
        bandKind: band.bandKind,
        topIn: docTopIn,
        leftIn,
        widthIn: totalTablixWidth,
        heightIn: totalTablixHeight,
        dataSetName,
        isRepeatingDetail: band.isRepeatingDetail,
        columnWidthsIn,
        rows,
      },
      extractedDetailRows: [],
    };
  }

  private buildRepeatingLogicalTablix(
    band: ReconstructedBand,
    page: LayoutPage,
    regionById: Map<string, LayoutRegion>,
    vectorRects: LayoutRegion[],
    fieldMap: Map<string, ReportFieldDef>,
    dataSetName: string,
    marginsIn: { top: number; right: number; bottom: number; left: number },
    printableWidthIn: number,
    printableHeightIn: number,
    nextUniqueName: (prefix: string) => string,
    hasLayer0: boolean
  ): { tablix: TablixRegion; extractedDetailRows: Array<Record<string, string | number>> } | undefined {
    const textRegions = band.sourceRegionIds
      .map((id) => regionById.get(id))
      .filter((r): r is LayoutRegion => Boolean(r && r.type === 'text' && r.text && r.text.trim().length > 0))
      .sort((a, b) => (Math.abs(a.y - b.y) <= 0.08 ? a.x - b.x : a.y - b.y));

    if (textRegions.length < 4) return undefined;

    const logicalRows: LayoutRegion[][] = [];
    for (const r of textRegions) {
      const last = logicalRows[logicalRows.length - 1];
      if (!last || Math.abs(last[0].y - r.y) > 0.08) {
        logicalRows.push([r]);
      } else {
        last.push(r);
      }
    }
    if (logicalRows.length < 2) return undefined;
    for (const r of logicalRows) r.sort((a, b) => a.x - b.x);

    const headerRegions = logicalRows[0];
    const dataRegions = logicalRows[1];
    const numCols = headerRegions.length;
    if (numCols === 0) return undefined;

    const leftIn = clamp(roundIn(band.x - marginsIn.left), 0, Math.max(0, printableWidthIn - 0.5));
    const rightBound = Math.min(band.x + band.width, marginsIn.left + printableWidthIn - 0.01);
    const totalBandW = Math.max(0.5, rightBound - band.x);

    const colStarts: number[] = [band.x];
    for (let c = 1; c < numCols; c++) {
      const prevEnd = headerRegions[c - 1].x + headerRegions[c - 1].width;
      const curStart = headerRegions[c].x;
      const splitX = curStart > prevEnd ? (prevEnd + curStart) / 2 : (headerRegions[c - 1].x + curStart) / 2;
      colStarts.push(clamp(splitX, colStarts[c - 1] + 0.1, rightBound - (numCols - c) * 0.1));
    }
    colStarts.push(band.x + totalBandW);

    const columnWidthsIn = Array.from({ length: numCols }, (_, c) =>
      Math.max(0.1, roundIn(colStarts[c + 1] - colStarts[c]))
    );

    const findRowRect = (rowY: number): LayoutRegion | undefined =>
      vectorRects
        .filter((vr) => rowY >= vr.y - 0.08 && rowY <= vr.y + vr.height + 0.08 && vr.width >= totalBandW * 0.5)
        .sort((a, b) => a.width * a.height - b.width * b.height)[0];

    const headerRect = findRowRect(headerRegions[0].y);
    const dataRect = findRowRect(dataRegions[0]?.y ?? headerRegions[0].y + 0.3);

    const columnHeaderNames: string[] = [];
    const headerCells: TablixCell[] = headerRegions.map((hReg, cIdx) => {
      const colName = sanitizeIdentifier(hReg.text ?? `Column${cIdx + 1}`, `Column${cIdx + 1}`);
      columnHeaderNames.push(colName);
      const padLeftPt = Math.max(0, Math.round((hReg.x - colStarts[cIdx]) * 72));
      return {
        colIndex: cIdx,
        rowIndex: 0,
        colSpan: 1,
        rowSpan: 1,
        skipBecauseMerged: false,
        content: {
          kind: 'Textbox',
          name: nextUniqueName('Txt'),
          value: hReg.text ?? colName,
          isExpression: false,
          style: {
            ...hReg.style,
            backgroundColor: hasLayer0 ? undefined : hReg.style.backgroundColor ?? headerRect?.style.backgroundColor ?? '#EEF2F6',
            borderColor: hasLayer0 ? undefined : hReg.style.borderColor ?? headerRect?.style.borderColor ?? '#CBD5E1',
            borderWidthPt: hasLayer0 ? undefined : hReg.style.borderWidthPt ?? headerRect?.style.borderWidthPt ?? 0.75,
            verticalAlign: 'Middle',
            paddingPt: { top: 0, right: 2, bottom: 0, left: padLeftPt },
          },
          canGrow: true,
        },
      };
    });

    const detailCells: TablixCell[] = [];
    for (let cIdx = 0; cIdx < numCols; cIdx++) {
      const colLeft = colStarts[cIdx];
      const colRight = colStarts[cIdx + 1];
      const matchedReg = dataRegions.find((dr) => {
        const cx = dr.x + dr.width / 2;
        return cx >= colLeft - 0.08 && cx <= colRight + 0.08;
      }) ?? dataRegions[cIdx];

      const fieldName = columnHeaderNames[cIdx] ?? `Col${cIdx + 1}`;
      const sampleRaw = matchedReg?.text?.trim() ?? '';
      const isNumeric = /^[\$\€\£]?\s*-?\d/.test(sampleRaw);
      const isCalc = /total|amount|net|subtotal/i.test(fieldName);

      if (!fieldMap.has(fieldName)) {
        fieldMap.set(fieldName, {
          name: fieldName,
          dataType: isNumeric ? 'System.Decimal' : 'System.String',
          sampleValue: isNumeric ? Number(sampleRaw.replace(/[^0-9.-]/g, '')) || 0 : sampleRaw || 'Sample',
          isCalculated: isCalc,
        });
      }

      const discountArg = fieldMap.has('Discount') ? 'Fields!Discount.Value' : '0';
      const value =
        isCalc && fieldMap.has('Qty') && fieldMap.has('Price')
          ? `=Code.CalculateLineTotal(Fields!Qty.Value, Fields!Price.Value, ${discountArg})`
          : `=Fields!${fieldName}.Value`;

      const padLeftPt = matchedReg
        ? Math.max(0, Math.round((matchedReg.x - colLeft) * 72))
        : 2;

      detailCells.push({
        colIndex: cIdx,
        rowIndex: 1,
        colSpan: 1,
        rowSpan: 1,
        skipBecauseMerged: false,
        content: {
          kind: 'Textbox',
          name: nextUniqueName('Txt'),
          value,
          isExpression: true,
          style: {
            ...(matchedReg?.style ?? headerRegions[cIdx].style),
            bold: false,
            backgroundColor: hasLayer0 ? undefined : matchedReg?.style.backgroundColor ?? dataRect?.style.backgroundColor,
            borderColor: hasLayer0 ? undefined : matchedReg?.style.borderColor ?? dataRect?.style.borderColor ?? '#CBD5E1',
            borderWidthPt: hasLayer0 ? undefined : matchedReg?.style.borderWidthPt ?? dataRect?.style.borderWidthPt ?? 0.5,
            verticalAlign: 'Middle',
            paddingPt: { top: 0, right: 2, bottom: 0, left: padLeftPt },
          },
          canGrow: true,
        },
      });
    }

    // Collect ALL repeating detail rows for exact 1:1 preview & PDF fidelity
    const extractedDetailRows: Array<Record<string, string | number>> = [];
    for (let rIdx = 1; rIdx < logicalRows.length; rIdx++) {
      const rowRegs = logicalRows[rIdx];
      const rowObj: Record<string, string | number> = {};
      for (let cIdx = 0; cIdx < numCols; cIdx++) {
        const colLeft = colStarts[cIdx];
        const colRight = colStarts[cIdx + 1];
        const matched = rowRegs.find((dr) => {
          const cx = dr.x + dr.width / 2;
          return cx >= colLeft - 0.08 && cx <= colRight + 0.08;
        });
        const colName = columnHeaderNames[cIdx] ?? `Col${cIdx + 1}`;
        rowObj[colName] = matched?.text?.trim() ?? '';
      }
      extractedDetailRows.push(rowObj);
    }

    const rowPitch =
      logicalRows.length >= 3
        ? Math.max(0.18, roundIn(logicalRows[2][0].y - logicalRows[1][0].y))
        : undefined;
    const headerTopY = headerRect?.y ?? Math.max(0, headerRegions[0].y - 0.08);
    const firstDataTopY = dataRect?.y ?? Math.max(headerTopY + 0.22, dataRegions[0]?.y - 0.08);
    const headerH = Math.max(0.22, roundIn(firstDataTopY - headerTopY));
    const detailH = Math.max(0.2, roundIn(rowPitch ?? dataRect?.height ?? (dataRegions[0]?.height ?? 0.16) + 0.12));

    const rows: TablixRow[] = [
      { heightIn: headerH, isDetailRow: false, cells: headerCells },
      { heightIn: detailH, isDetailRow: true, cells: detailCells },
    ];

    const pageRelTop = clamp(roundIn(headerTopY - marginsIn.top), 0, Math.max(0, printableHeightIn - headerH - detailH));
    const totalTablixWidth = roundIn(columnWidthsIn.reduce((s, w) => s + w, 0));
    const totalTablixHeight = roundIn(headerH + detailH);
    const docTopIn = roundIn((page.pageNumber - 1) * page.height + pageRelTop);

    return {
      tablix: {
        id: band.id,
        name: sanitizeIdentifier(band.name, nextUniqueName('Tablix')),
        pageNumber: page.pageNumber,
        bandKind: band.bandKind,
        topIn: docTopIn,
        leftIn,
        widthIn: totalTablixWidth,
        heightIn: totalTablixHeight,
        dataSetName,
        isRepeatingDetail: true,
        columnWidthsIn,
        rows,
      },
      extractedDetailRows,
    };
  }

  private deriveCalculationRules(fields: ReportFieldDef[]): CalculationRuleDef[] {
    const names = fields.map((f) => f.name.toLowerCase());
    const rules: CalculationRuleDef[] = [];

    const hasQty = names.some((n) => n.includes('qty') || n.includes('quantity'));
    const hasPrice = names.some((n) => n.includes('price') || n.includes('rate') || n.includes('unit'));
    const hasDiscount = names.some((n) => n.includes('discount'));

    rules.push({
      functionName: 'CalculateLineTotal',
      targetField: 'LineTotal',
      inputs: hasQty && hasPrice ? ['Qty', 'Price', 'DiscountPercent'] : ['Qty', 'Price', 'DiscountPercent'],
      operation: hasDiscount ? 'subtract_percent' : 'multiply',
      expressionSummary: 'Qty * Price * (1 - DiscountPercent / 100)',
      vbImplementation: `Public Function CalculateLineTotal(ByVal qty As Decimal, ByVal price As Decimal, ByVal discountPercent As Decimal) As Decimal
    Dim gross As Decimal = qty * price
    Dim discountAmount As Decimal = gross * (discountPercent / 100D)
    Return Math.Round(gross - discountAmount, 2, MidpointRounding.AwayFromZero)
End Function`,
    });

    rules.push({
      functionName: 'CalculateNetTotal',
      targetField: 'NetTotal',
      inputs: ['Subtotal', 'TaxRatePercent'],
      operation: 'tax',
      expressionSummary: 'Subtotal + Round(Subtotal * TaxRatePercent / 100, 2)',
      vbImplementation: `Public Function CalculateNetTotal(ByVal subtotal As Decimal, ByVal taxRatePercent As Decimal) As Decimal
    Dim taxAmount As Decimal = Math.Round(subtotal * (taxRatePercent / 100D), 2, MidpointRounding.AwayFromZero)
    Return Math.Round(subtotal + taxAmount, 2, MidpointRounding.AwayFromZero)
End Function`,
    });

    return rules;
  }
}
