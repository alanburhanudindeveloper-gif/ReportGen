import {
  BandKind,
  GridCellAssignment,
  IntermediateLayoutModel,
  LayoutPage,
  LayoutRegion,
  ReconstructedBand,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
} from '../core/types.ts';

function clusterCoordinates(coords: number[], tolerance: number): number[] {
  if (coords.length === 0) return [];
  const sorted = [...coords].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const lastCluster = clusters[clusters.length - 1];
    const clusterAvg = lastCluster.reduce((s, v) => s + v, 0) / lastCluster.length;
    if (Math.abs(cur - clusterAvg) <= tolerance) {
      lastCluster.push(cur);
    } else {
      clusters.push([cur]);
    }
  }
  return clusters.map((c) => Math.round((c.reduce((s, v) => s + v, 0) / c.length) * 1000) / 1000);
}

function findBoundaryIndex(boundaries: number[], value: number, tolerance: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < boundaries.length; i++) {
    const d = Math.abs(boundaries[i] - value);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestDist <= tolerance) return bestIdx;
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (value >= boundaries[i] - tolerance && value < boundaries[i + 1]) {
      return i;
    }
  }
  return Math.max(0, boundaries.length - 2);
}

export class GridReconstructor {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public reconstruct(
    layout: IntermediateLayoutModel,
    coordinateTolerance = 0.04
  ): IntermediateLayoutModel {
    try {
      const updatedPages: LayoutPage[] = layout.pages.map((page) =>
        this.reconstructPage(page, coordinateTolerance)
      );
      this.logger.info('LayoutReconstruction', 'Layout reconstruction completed', {
        pages: updatedPages.length,
        totalBands: updatedPages.reduce((s, p) => s + p.bands.length, 0),
        ambiguousRegions: updatedPages.reduce(
          (s, p) => s + p.regions.filter((r) => r.isAmbiguous).length,
          0
        ),
      });
      return {
        ...layout,
        pages: updatedPages,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ReportGenError(ReportGenErrorCode.LAYOUT_RECONSTRUCTION_FAILED, msg, err);
    }
  }

  private reconstructPage(page: LayoutPage, tolerance: number): LayoutPage {
    const regions = page.regions.map((r) => ({ ...r }));

    // 1. Deterministic semantic classification where unambiguous
    this.applyDeterministicClassification(regions, page);

    // 2. Group regions into vertical page bands by Y-gap analysis
    const visualRegions = regions.filter((r) => r.type !== 'vector_line' || r.width > 0.5);
    const bandGroups = this.segmentPageIntoBands(visualRegions, page);

    const bands: ReconstructedBand[] = bandGroups.map((group, idx) =>
      this.buildBandGrid(group.regions, group.bandKind, page.pageNumber, idx + 1, page.width, tolerance)
    );

    return {
      ...page,
      regions,
      bands,
    };
  }

  private applyDeterministicClassification(regions: LayoutRegion[], page: LayoutPage): void {
    const textRegions = regions.filter((r) => r.type === 'text' && r.text);
    const maxFontPt = textRegions.reduce((m, r) => Math.max(m, r.style.fontSizePt), 10);

    for (const r of regions) {
      if (r.type === 'image' || r.type === 'vector_complex') {
        r.semanticRole = 'logoOrGraphic';
        r.preferImageFallback = true;
        continue;
      }
      if (r.type !== 'text' || !r.text) continue;

      const txt = r.text.trim();

      // Top title or page footer
      if (r.y < 1.2 && r.style.fontSizePt >= maxFontPt - 1 && r.style.bold) {
        r.semanticRole = 'reportTitle';
        r.bandKind = 'Header';
        r.confidence = 0.96;
        r.isAmbiguous = false;
        continue;
      }

      if (r.y > page.height - 1.0 && /page\s+\d+|confidential|copyright|generated/i.test(txt)) {
        r.semanticRole = 'footerText';
        r.bandKind = 'Footer';
        r.confidence = 0.95;
        r.isAmbiguous = false;
        continue;
      }

      // Numbered list item
      if (/^\d+[\.\)]\s+\S+/.test(txt) && r.width > 2.0) {
        r.semanticRole = 'numberedListItem';
        r.bandKind = 'Notes';
        r.confidence = 0.92;
        r.isAmbiguous = false;
        continue;
      }

      // Paragraph (multi-word long prose)
      if (txt.length > 65 && txt.includes(' ')) {
        r.semanticRole = 'paragraph';
        r.confidence = 0.91;
        r.isAmbiguous = false;
        continue;
      }

      // Explicit label ending in colon
      if (txt.endsWith(':') && txt.length <= 36) {
        r.semanticRole = 'fieldLabel';
        r.bandKind = 'Information';
        r.confidence = 0.94;
        r.isAmbiguous = false;
        continue;
      }

      // Calculation / currency value pattern
      if (/^[\$\€\£]?\s*-?\d{1,3}(,\d{3})*(\.\d{2})?%?$/.test(txt)) {
        r.semanticRole = 'fieldValue';
        r.confidence = 0.85;
        // Flag numeric values near summary keywords as ambiguous calculation candidates
        const hasTotalNeighbor = textRegions.some(
          (other) =>
            other.id !== r.id &&
            Math.abs(other.y - r.y) < 0.2 &&
            /total|subtotal|tax|discount|vat|net|amount/i.test(other.text ?? '')
        );
        if (hasTotalNeighbor) {
          r.isAmbiguous = true;
          r.ambiguityReason = 'Numeric value adjacent to financial summary label; verify calculation vs static field.';
        }
        continue;
      }

      // Otherwise mark ambiguous if inside a bordered box or short phrase without clear role
      const insideCard = regions.some(
        (v) =>
          v.type === 'vector_rect' &&
          v.width > 1.0 &&
          v.height > 0.5 &&
          r.x >= v.x - 0.05 &&
          r.x + r.width <= v.x + v.width + 0.05 &&
          r.y >= v.y - 0.05 &&
          r.y + r.height <= v.y + v.height + 0.05
      );

      if (insideCard) {
        r.isAmbiguous = true;
        r.ambiguityReason = 'Text inside bordered box/card; determine whether cardContainer, fieldLabel, fieldValue, or timelineStep.';
        r.confidence = 0.62;
      } else if (txt.length <= 35) {
        r.isAmbiguous = true;
        r.ambiguityReason = 'Short standalone text; determine label vs value vs tableHeader vs sectionHeading.';
        r.confidence = 0.68;
      }
    }
  }

  private segmentPageIntoBands(
    regions: LayoutRegion[],
    page: LayoutPage
  ): Array<{ bandKind: BandKind; regions: LayoutRegion[] }> {
    if (regions.length === 0) return [];
    const sorted = [...regions].sort((a, b) => a.y - b.y || a.x - b.x);
    const groups: LayoutRegion[][] = [[sorted[0]]];
    let currentBottom = sorted[0].y + sorted[0].height;

    for (let i = 1; i < sorted.length; i++) {
      const r = sorted[i];
      if (r.y - currentBottom > 0.35) {
        groups.push([r]);
        currentBottom = r.y + r.height;
      } else {
        groups[groups.length - 1].push(r);
        currentBottom = Math.max(currentBottom, r.y + r.height);
      }
    }

    return groups.map((grp, idx) => {
      const avgY = grp.reduce((s, r) => s + r.y, 0) / grp.length;
      const boxCount = grp.filter((r) => r.type === 'vector_rect' && r.width > 1.0 && r.height > 0.5).length;
      const hasFooterRole = grp.some((r) => r.semanticRole === 'footerText');
      const hasHeaderRole = grp.some((r) => r.semanticRole === 'reportTitle' || r.semanticRole === 'headerText');
      const hasNotesRole = grp.some((r) => r.semanticRole === 'numberedListItem' || r.semanticRole === 'paragraph');

      let bandKind: BandKind = 'Detail';
      if (hasFooterRole || avgY > page.height - 1.0) {
        bandKind = 'Footer';
      } else if (hasHeaderRole || (idx === 0 && avgY < 1.5)) {
        bandKind = 'Header';
      } else if (boxCount >= 2) {
        bandKind = 'Cards';
      } else if (hasNotesRole && grp.filter((r) => r.type === 'text').length <= 8) {
        bandKind = 'Notes';
      } else if (grp.some((r) => r.semanticRole === 'fieldLabel')) {
        bandKind = 'Information';
      }

      for (const r of grp) {
        r.bandKind = bandKind;
      }

      return { bandKind, regions: grp };
    });
  }

  private buildBandGrid(
    bandRegions: LayoutRegion[],
    bandKind: BandKind,
    pageNumber: number,
    bandIndex: number,
    pageWidthIn: number,
    tolerance: number
  ): ReconstructedBand {
    const minX = Math.max(0.25, Math.min(...bandRegions.map((r) => r.x)));
    const maxX = Math.min(pageWidthIn - 0.25, Math.max(...bandRegions.map((r) => r.x + r.width)));
    const minY = Math.min(...bandRegions.map((r) => r.y));
    const maxY = Math.max(...bandRegions.map((r) => r.y + r.height));

    // Step 1-4: Collect & cluster X and Y coordinates
    const rawXs = [minX, maxX];
    const rawYs = [minY, maxY];

    for (const r of bandRegions) {
      // Skip large enclosing container boxes when computing inner text column splits unless only boxes exist
      const isOuterBox =
        r.type === 'vector_rect' &&
        bandRegions.some(
          (t) =>
            t.type === 'text' &&
            t.x >= r.x - 0.02 &&
            t.x + t.width <= r.x + r.width + 0.02
        );
      if (!isOuterBox || bandRegions.every((x) => x.type === 'vector_rect')) {
        rawXs.push(r.x, r.x + r.width);
        rawYs.push(r.y, r.y + r.height);
      }
    }

    let columnBoundaries = clusterCoordinates(rawXs, tolerance);
    let rowBoundaries = clusterCoordinates(rawYs, tolerance);

    if (columnBoundaries.length < 2) columnBoundaries = [minX, Math.max(minX + 0.5, maxX)];
    if (rowBoundaries.length < 2) rowBoundaries = [minY, Math.max(minY + 0.25, maxY)];

    // Step 5: Compute widths & heights (filter zero-width slivers)
    const cleanCols: number[] = [columnBoundaries[0]];
    for (let i = 1; i < columnBoundaries.length; i++) {
      if (columnBoundaries[i] - cleanCols[cleanCols.length - 1] >= 0.08) {
        cleanCols.push(columnBoundaries[i]);
      }
    }
    if (cleanCols.length < 2) cleanCols.push(cleanCols[0] + 0.5);

    const cleanRows: number[] = [rowBoundaries[0]];
    for (let i = 1; i < rowBoundaries.length; i++) {
      if (rowBoundaries[i] - cleanRows[cleanRows.length - 1] >= 0.08) {
        cleanRows.push(rowBoundaries[i]);
      }
    }
    if (cleanRows.length < 2) cleanRows.push(cleanRows[0] + 0.25);

    const numCols = cleanCols.length - 1;
    const numRows = cleanRows.length - 1;
    const columnWidths = Array.from({ length: numCols }, (_, c) =>
      Math.round((cleanCols[c + 1] - cleanCols[c]) * 1000) / 1000
    );
    const rowHeights = Array.from({ length: numRows }, (_, r) =>
      Math.round((cleanRows[r + 1] - cleanRows[r]) * 1000) / 1000
    );

    // Step 6-9: Assign objects to cells, detect overlaps & merge candidates
    const cellMap = new Map<string, GridCellAssignment>();
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        cellMap.set(`${r}:${c}`, {
          row: r,
          col: c,
          rowSpan: 1,
          colSpan: 1,
          regionIds: [],
          isMerged: false,
          isOverlapping: false,
        });
      }
    }

    const orderedRegions = [...bandRegions].sort((a, b) => {
      // Text & images take precedence over background rectangles inside cells
      const prio = (t: LayoutRegion['type']) => (t === 'text' || t === 'image' || t === 'vector_complex' ? 0 : 1);
      return prio(a.type) - prio(b.type) || a.y - b.y || a.x - b.x;
    });

    const occupied = new Set<string>();
    for (const reg of orderedRegions) {
      if (reg.type === 'vector_line') continue;
      const startCol = Math.min(numCols - 1, findBoundaryIndex(cleanCols, reg.x, tolerance));
      const endCol = Math.max(
        startCol,
        Math.min(numCols - 1, findBoundaryIndex(cleanCols, reg.x + reg.width - 0.02, tolerance))
      );
      const startRow = Math.min(numRows - 1, findBoundaryIndex(cleanRows, reg.y, tolerance));
      const endRow = Math.max(
        startRow,
        Math.min(numRows - 1, findBoundaryIndex(cleanRows, reg.y + reg.height - 0.02, tolerance))
      );

      const anchorKey = `${startRow}:${startCol}`;
      const anchor = cellMap.get(anchorKey);
      if (!anchor) continue;

      if (reg.type === 'vector_rect' && anchor.primaryRegionId) {
        // Background box already represented by inner cell styling
        anchor.regionIds.push(reg.id);
        continue;
      }

      if (!anchor.primaryRegionId) {
        anchor.primaryRegionId = reg.id;
        anchor.regionIds.push(reg.id);

        const desiredColSpan = endCol - startCol + 1;
        const desiredRowSpan = endRow - startRow + 1;

        // Only merge if target span cells are unoccupied
        let canMerge = desiredColSpan > 1 || desiredRowSpan > 1;
        if (canMerge) {
          for (let rr = startRow; rr <= endRow; rr++) {
            for (let cc = startCol; cc <= endCol; cc++) {
              if ((rr !== startRow || cc !== startCol) && occupied.has(`${rr}:${cc}`)) {
                canMerge = false;
              }
            }
          }
        }
        if (canMerge) {
          anchor.colSpan = desiredColSpan;
          anchor.rowSpan = desiredRowSpan;
          anchor.isMerged = true;
          for (let rr = startRow; rr <= endRow; rr++) {
            for (let cc = startCol; cc <= endCol; cc++) {
              occupied.add(`${rr}:${cc}`);
            }
          }
        } else {
          occupied.add(anchorKey);
        }
      } else {
        anchor.regionIds.push(reg.id);
        anchor.isOverlapping = true;
      }
    }

    const distinctYRows = numRows;
    const isRepeatingDetail =
      bandKind === 'Detail' &&
      distinctYRows >= 3 &&
      numCols >= 2 &&
      bandRegions.filter((r) => r.type === 'text').length >= 6;

    return {
      id: `band-p${pageNumber}-${bandIndex}`,
      pageNumber,
      name: `Tablix_${bandKind}_P${pageNumber}_${bandIndex}`,
      bandKind,
      x: Math.round(cleanCols[0] * 1000) / 1000,
      y: Math.round(cleanRows[0] * 1000) / 1000,
      width: Math.round((cleanCols[cleanCols.length - 1] - cleanCols[0]) * 1000) / 1000,
      height: Math.round((cleanRows[cleanRows.length - 1] - cleanRows[0]) * 1000) / 1000,
      columnBoundaries: cleanCols,
      rowBoundaries: cleanRows,
      columnWidths,
      rowHeights,
      cells: Array.from(cellMap.values()),
      isRepeatingDetail,
      sourceRegionIds: bandRegions.map((r) => r.id),
    };
  }
}
