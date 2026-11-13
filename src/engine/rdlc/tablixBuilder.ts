import {
  AiDecisionResponse,
  CalculationRuleDef,
  ExistingProjectPattern,
  IntermediateLayoutModel,
  LayoutRegion,
  ReportDefinition,
  ReportFieldDef,
  ReportParameterDef,
  StructuredLogger,
  TablixCell,
  TablixRegion,
  TablixRow,
} from '../core/types.ts';

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

export class TablixBuilder {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public buildReportDefinition(
    layout: IntermediateLayoutModel,
    aiDecisions?: AiDecisionResponse,
    existingPattern?: ExistingProjectPattern
  ): ReportDefinition {
    const decisionMap = new Map(
      (aiDecisions?.decisions ?? []).map((d) => [d.regionId, d])
    );

    const dataSourceName = existingPattern?.dataSourceName ?? 'dsReportSource';
    const dataSetName = existingPattern?.dataSetName ?? 'dsReportData';
    const reportName = sanitizeIdentifier(layout.document.name, 'GeneratedReport');

    const fieldMap = new Map<string, ReportFieldDef>();
    const parameterMap = new Map<string, ReportParameterDef>();
    const embeddedImages: Array<{ name: string; mimeType: string; base64Data: string }> = [];
    const seenImageNames = new Set<string>();

    // Seed fields from existing RDLC if inspected
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
      parameterMap.set(existingParam, {
        name: existingParam,
        dataType: 'String',
        prompt: existingParam,
        defaultValue: '',
      });
    }

    const tablixRegions: TablixRegion[] = [];
    let nameCounter = 1;
    const nextUniqueName = (prefix: string): string => `${prefix}_${nameCounter++}`;

    for (const page of layout.pages) {
      const regionById = new Map<string, LayoutRegion>();
      for (const r of page.regions) {
        const dec = decisionMap.get(r.id);
        const updated: LayoutRegion = dec
          ? {
              ...r,
              semanticRole: dec.semanticRole,
              bandKind: dec.bandOverride ?? r.bandKind,
              preferImageFallback: dec.preferImageFallback ?? r.preferImageFallback,
              linkedField: dec.linkedField ?? r.linkedField,
              confidence: dec.confidence,
            }
          : { ...r };
        regionById.set(updated.id, updated);
      }

      let currentPageTopOffset = 0;

      for (const band of page.bands) {
        const numCols = band.columnWidths.length;
        const numRows = band.rowHeights.length;
        if (numCols === 0 || numRows === 0) continue;

        const cellLookup = new Map(band.cells.map((c) => [`${c.row}:${c.col}`, c]));
        const skippedCoords = new Set<string>();
        const rows: TablixRow[] = [];

        // Detect column headers on row 0 if repeating detail
        const columnHeaderNames: string[] = [];
        if (band.isRepeatingDetail) {
          for (let c = 0; c < numCols; c++) {
            const headerCell = cellLookup.get(`0:${c}`);
            const reg = headerCell?.primaryRegionId ? regionById.get(headerCell.primaryRegionId) : undefined;
            const colField = sanitizeIdentifier(reg?.text ?? `Column${c + 1}`, `Column${c + 1}`);
            columnHeaderNames.push(colField);
          }
        }

        for (let rIdx = 0; rIdx < numRows; rIdx++) {
          const isDetailRow = band.isRepeatingDetail && rIdx === 1;
          // For repeating detail tables, emit header row (0) + single template detail row (1)
          if (band.isRepeatingDetail && rIdx > 1) {
            continue;
          }

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
            const rowSpan = band.isRepeatingDetail
              ? 1
              : Math.min(numRows - rIdx, Math.max(1, assigned?.rowSpan ?? 1));

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

            if (region && (region.type === 'image' || region.preferImageFallback) && region.imageAssetBase64) {
              const imgName = sanitizeIdentifier(
                region.imageAssetName ?? `Graphic_P${page.pageNumber}_${nameCounter}`,
                `Graphic_${nameCounter}`
              );
              if (!seenImageNames.has(imgName)) {
                seenImageNames.add(imgName);
                embeddedImages.push({
                  name: imgName,
                  mimeType: 'image/png',
                  base64Data: region.imageAssetBase64,
                });
              }
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

              if (isDetailRow) {
                const fieldName = columnHeaderNames[cIdx] ?? sanitizeIdentifier(`Col${cIdx + 1}`, `Col${cIdx + 1}`);
                const isNumeric = /^[\$\€\£]?\s*-?\d/.test(region.text.trim());
                const isCalc = /total|amount|net|subtotal/i.test(fieldName);
                if (!fieldMap.has(fieldName)) {
                  fieldMap.set(fieldName, {
                    name: fieldName,
                    dataType: isNumeric ? 'System.Decimal' : 'System.String',
                    sampleValue: isNumeric
                      ? Number(region.text.replace(/[^0-9.-]/g, '')) || 0
                      : region.text,
                    isCalculated: isCalc,
                  });
                }
                if (isCalc && fieldMap.has('Qty') && fieldMap.has('Price')) {
                  value = '=Code.CalculateLineTotal(Fields!Qty.Value, Fields!Price.Value, 0)';
                } else {
                  value = `=Fields!${fieldName}.Value`;
                }
                isExpression = true;
              } else if (
                region.semanticRole === 'fieldValue' ||
                region.semanticRole === 'calculationField'
              ) {
                const fieldName = sanitizeIdentifier(
                  region.linkedField ?? `Field_${page.pageNumber}_${nameCounter}`,
                  `Field_${nameCounter}`
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
                  isExpression,
                  style: region.style,
                  canGrow: true,
                },
              });
              continue;
            }

            // Background rectangle or spacer cell
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
                style: region?.style ?? {
                  fontFamily: 'Segoe UI',
                  fontSizePt: 9,
                  bold: false,
                  italic: false,
                  color: '#0F172A',
                  textAlign: 'Left',
                  verticalAlign: 'Middle',
                  paddingPt: { top: 1, right: 2, bottom: 1, left: 2 },
                },
                canGrow: true,
              },
            });
          }

          rows.push({
            heightIn: Math.max(0.18, band.rowHeights[rIdx] ?? 0.25),
            isDetailRow,
            cells: rowCells,
          });
        }

        const totalTablixHeight = rows.reduce((s, r) => s + r.heightIn, 0);
        const topIn = Math.round(((page.pageNumber - 1) * page.height + band.y + currentPageTopOffset) * 1000) / 1000;
        currentPageTopOffset += 0;

        tablixRegions.push({
          id: band.id,
          name: sanitizeIdentifier(band.name, `Tablix_${nameCounter}`),
          pageNumber: page.pageNumber,
          bandKind: band.bandKind,
          topIn: Math.max(0.1, band.y + (page.pageNumber - 1) * page.height),
          leftIn: Math.max(0.1, band.x),
          widthIn: Math.max(0.5, band.columnWidths.reduce((s, w) => s + w, 0)),
          heightIn: Math.max(0.25, totalTablixHeight),
          dataSetName,
          isRepeatingDetail: band.isRepeatingDetail,
          columnWidthsIn: band.columnWidths.map((w) => Math.max(0.15, w)),
          rows,
        });
        void topIn;
      }
    }

    // Ensure at least standard parameters & fields exist if none were extracted
    if (parameterMap.size === 0) {
      parameterMap.set('ReportTitle', {
        name: 'ReportTitle',
        dataType: 'String',
        prompt: 'Report Title',
        defaultValue: layout.document.name,
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

    this.logger.info('TablixBuilder', 'RDLC Tablix model constructed', {
      tablixCount: tablixRegions.length,
      fields: fieldMap.size,
      calculations: calculations.length,
    });

    return {
      reportName,
      dataSourceName,
      dataSetName,
      pageWidthIn: layout.document.pageWidth,
      pageHeightIn: layout.document.pageHeight,
      marginsIn: { top: 0.35, right: 0.35, bottom: 0.35, left: 0.35 },
      fields: Array.from(fieldMap.values()),
      parameters: Array.from(parameterMap.values()),
      calculations,
      tablixRegions,
      embeddedImages,
      existingPatternUsed: existingPattern?.sourceFiles.join(', ') || undefined,
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
