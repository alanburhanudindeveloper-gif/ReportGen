import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  RdlcValidationDiagnostic,
  RdlcValidationResult,
  StructuredLogger,
} from '../core/types.ts';

function asArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function parseDimensionInches(val: unknown): number {
  if (typeof val !== 'string') return NaN;
  const m = val.trim().match(/^(-?\d+(?:\.\d+)?)\s*(in|cm|mm|pt)$/i);
  if (!m) return NaN;
  const num = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'in') return num;
  if (unit === 'cm') return num / 2.54;
  if (unit === 'mm') return num / 25.4;
  if (unit === 'pt') return num / 72;
  return NaN;
}

export class RdlcValidator {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public validate(rdlcXml: string, options?: { requireRdlc2008?: boolean }): RdlcValidationResult {
    const errors: RdlcValidationDiagnostic[] = [];
    const warnings: RdlcValidationDiagnostic[] = [];

    // 1. Validate XML well-formedness
    const xmlCheck = XMLValidator.validate(rdlcXml);
    if (xmlCheck !== true) {
      errors.push({
        ruleId: 'RDLC-01',
        severity: 'ERROR',
        message: `Invalid XML syntax: ${xmlCheck.err.msg} (line ${xmlCheck.err.line})`,
      });
      return { valid: false, checkedRules: 10, errors, warnings };
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
    });
    const parsed = parser.parse(rdlcXml);
    const report = parsed?.Report;

    if (options?.requireRdlc2008) {
      const has2008Ns = /http:\/\/schemas\.microsoft\.com\/sqlserver\/reporting\/2008\/01\/reportdefinition/i.test(
        rdlcXml
      );
      if (!has2008Ns || report?.ReportSections) {
        errors.push({
          ruleId: 'RDLC-2008',
          severity: 'ERROR',
          message:
            'RDLC 2008 schema is required (xmlns=".../2008/01/reportdefinition" with top-level <Body> and <Page>, no <ReportSections>).',
        });
      }
    }

    // 2. Validate required RDLC structure (supports 2008 top-level Body/Page and 2016 ReportSections)
    const section = asArray(report?.ReportSections?.ReportSection)[0];
    const body = section?.Body ?? report?.Body;
    const page = section?.Page ?? report?.Page;
    if (!report || !body || !page) {
      errors.push({
        ruleId: 'RDLC-02',
        severity: 'ERROR',
        message: 'Report must contain <Body> and <Page> (RDLC 2008) or <ReportSections>/<ReportSection> (RDLC 2016).',
      });
      return { valid: false, checkedRules: 10, errors, warnings };
    }

    // Collect DataSets & Fields
    const dataSets = new Map<string, Set<string>>();
    for (const ds of asArray(report.DataSets?.DataSet)) {
      const dsName = String(ds?.['@_Name'] ?? '');
      const fieldSet = new Set<string>();
      for (const f of asArray(ds?.Fields?.Field)) {
        if (f?.['@_Name']) fieldSet.add(String(f['@_Name']));
      }
      if (dsName) dataSets.set(dsName, fieldSet);
    }

    // Collect EmbeddedImages
    const embeddedImages = new Set<string>();
    for (const emb of asArray(report.EmbeddedImages?.EmbeddedImage)) {
      const imgName = String(emb?.['@_Name'] ?? '').trim();
      const b64 = String(emb?.ImageData ?? '').replace(/\s+/g, '');
      if (!imgName || !b64) {
        errors.push({
          ruleId: 'RDLC-09',
          severity: 'ERROR',
          message: `EmbeddedImage "${imgName || '(unnamed)'}" is missing Name or ImageData.`,
          location: 'EmbeddedImages',
        });
      } else {
        embeddedImages.add(imgName);
      }
    }

    const allNames = new Set<string>();
    const checkUniqueName = (name: unknown, location: string) => {
      const n = String(name ?? '').trim();
      if (!n) {
        errors.push({
          ruleId: 'RDLC-09',
          severity: 'ERROR',
          message: `Missing Name attribute at ${location}.`,
          location,
        });
        return;
      }
      if (allNames.has(n)) {
        errors.push({
          ruleId: 'RDLC-09',
          severity: 'ERROR',
          message: `Duplicate report item Name "${n}".`,
          location,
        });
      }
      allNames.add(n);
    };

    for (const dsName of dataSets.keys()) {
      checkUniqueName(dsName, 'DataSet');
    }

    // 3. Recursively validate ReportItems across Body, PageHeader, PageFooter, and nested Rectangles
    let totalTablixes = 0;
    const validateReportItems = (reportItems: Record<string, unknown> | undefined, ctx: string) => {
      if (!reportItems) return;

      for (const rect of asArray(reportItems.Rectangle as Record<string, unknown> | Record<string, unknown>[])) {
        const rectName = String(rect?.['@_Name'] ?? '');
        checkUniqueName(rectName, `${ctx}.Rectangle(${rectName})`);
        validateReportItems(rect?.ReportItems as Record<string, unknown> | undefined, `${ctx}.${rectName}`);
      }

      for (const tb of asArray(reportItems.Textbox as Record<string, unknown> | Record<string, unknown>[])) {
        const tbName = String(tb?.['@_Name'] ?? '');
        checkUniqueName(tbName, `${ctx}.Textbox(${tbName})`);
      }

      for (const img of asArray(reportItems.Image as Record<string, unknown> | Record<string, unknown>[])) {
        const imgName = String(img?.['@_Name'] ?? '');
        checkUniqueName(imgName, `${ctx}.Image(${imgName})`);
        if (String(img?.Source ?? '') === 'Embedded') {
          const refName = String(img?.Value ?? '').trim();
          if (!embeddedImages.has(refName)) {
            errors.push({
              ruleId: 'RDLC-09',
              severity: 'ERROR',
              message: `Image "${imgName}" references missing EmbeddedImage "${refName}".`,
              location: `${ctx}.${imgName}`,
            });
          }
        }
      }

      for (const tbl of asArray(reportItems.Tablix as Record<string, unknown> | Record<string, unknown>[])) {
        totalTablixes++;
        const tblName = String(tbl?.['@_Name'] ?? '');
        checkUniqueName(tblName, `${ctx}.Tablix(${tblName})`);

        const dsRef = String(tbl?.DataSetName ?? '');
        if (dsRef && !dataSets.has(dsRef)) {
          errors.push({
            ruleId: 'RDLC-04',
            severity: 'ERROR',
            message: `Tablix "${tblName}" references unknown DataSet "${dsRef}".`,
            location: tblName,
          });
        }

        const tBody = tbl?.TablixBody as Record<string, unknown> | undefined;
        const tCols = (tBody?.TablixColumns as Record<string, unknown> | undefined)?.TablixColumn;
        const tRows = (tBody?.TablixRows as Record<string, unknown> | undefined)?.TablixRow;
        const tColMembers = ((tbl?.TablixColumnHierarchy as Record<string, unknown> | undefined)?.TablixMembers as Record<string, unknown> | undefined)?.TablixMember;
        const tRowMembers = ((tbl?.TablixRowHierarchy as Record<string, unknown> | undefined)?.TablixMembers as Record<string, unknown> | undefined)?.TablixMember;

        const cols = asArray(tCols as Record<string, unknown> | Record<string, unknown>[]);
        const rows = asArray(tRows as Record<string, unknown> | Record<string, unknown>[]);
        const colMembers = asArray(tColMembers as Record<string, unknown> | Record<string, unknown>[]);
        const rowMembers = asArray(tRowMembers as Record<string, unknown> | Record<string, unknown>[]);

        if (cols.length !== colMembers.length) {
          errors.push({
            ruleId: 'RDLC-03',
            severity: 'ERROR',
            message: `Tablix "${tblName}" TablixColumns (${cols.length}) != TablixColumnHierarchy members (${colMembers.length}).`,
            location: tblName,
          });
        }
        if (rows.length !== rowMembers.length) {
          errors.push({
            ruleId: 'RDLC-03',
            severity: 'ERROR',
            message: `Tablix "${tblName}" TablixRows (${rows.length}) != TablixRowHierarchy members (${rowMembers.length}).`,
            location: tblName,
          });
        }

        const covered = Array.from({ length: rows.length }, () => Array(cols.length).fill(false));
        rows.forEach((row, rIdx) => {
          const cells = asArray((row?.TablixCells as Record<string, unknown> | undefined)?.TablixCell as Record<string, unknown> | Record<string, unknown>[]);
          if (cells.length !== cols.length) {
            errors.push({
              ruleId: 'RDLC-03',
              severity: 'ERROR',
              message: `Tablix "${tblName}" row ${rIdx} has ${cells.length} TablixCell elements, expected ${cols.length}.`,
              location: `${tblName}.Row[${rIdx}]`,
            });
          }
          cells.forEach((cell, cIdx) => {
            const cc = cell?.CellContents as Record<string, unknown> | undefined;
            if (covered[rIdx]?.[cIdx]) {
              if (cc) {
                errors.push({
                  ruleId: 'RDLC-03',
                  severity: 'ERROR',
                  message: `Tablix "${tblName}" cell [${rIdx},${cIdx}] is covered by RowSpan/ColSpan but contains CellContents.`,
                  location: `${tblName}.Row[${rIdx}].Col[${cIdx}]`,
                });
              }
              return;
            }
            if (cc) {
              const colSpan = Number(cc.ColSpan ?? 1);
              const rowSpan = Number(cc.RowSpan ?? 1);
              if (cIdx + colSpan > cols.length || rIdx + rowSpan > rows.length) {
                errors.push({
                  ruleId: 'RDLC-03',
                  severity: 'ERROR',
                  message: `Tablix "${tblName}" cell [${rIdx},${cIdx}] span (${rowSpan}x${colSpan}) exceeds table bounds.`,
                  location: `${tblName}.Row[${rIdx}].Col[${cIdx}]`,
                });
              }
              for (let rr = rIdx; rr < Math.min(rows.length, rIdx + rowSpan); rr++) {
                for (let ccIdx = cIdx; ccIdx < Math.min(cols.length, cIdx + colSpan); ccIdx++) {
                  if (rr !== rIdx || ccIdx !== cIdx) covered[rr][ccIdx] = true;
                }
              }
              const tb = cc.Textbox as Record<string, unknown> | undefined;
              if (tb) checkUniqueName(tb?.['@_Name'], `${tblName}.Textbox`);
              const img = cc.Image as Record<string, unknown> | undefined;
              if (img) {
                checkUniqueName(img?.['@_Name'], `${tblName}.Image`);
                if (String(img?.Source ?? '') === 'Embedded') {
                  const refName = String(img?.Value ?? '').trim();
                  if (!embeddedImages.has(refName)) {
                    errors.push({
                      ruleId: 'RDLC-09',
                      severity: 'ERROR',
                      message: `Tablix Image "${img?.['@_Name']}" references missing EmbeddedImage "${refName}".`,
                      location: tblName,
                    });
                  }
                }
              }
            }
          });
        });

        // 7. Validate Tablix dimensions (supports in, cm, mm, pt)
        const wIn = parseDimensionInches(tbl?.Width);
        const hIn = parseDimensionInches(tbl?.Height);
        if (!(wIn > 0) || !(hIn > 0)) {
          errors.push({
            ruleId: 'RDLC-07',
            severity: 'ERROR',
            message: `Tablix "${tblName}" has non-positive Width/Height.`,
            location: tblName,
          });
        } else {
          const colSumIn = cols.reduce((sum, c) => sum + parseDimensionInches(c?.Width), 0);
          const rowSumIn = rows.reduce((sum, r) => sum + parseDimensionInches(r?.Height), 0);
          if (Number.isFinite(colSumIn) && Math.abs(colSumIn - wIn) > 0.03) {
            warnings.push({
              ruleId: 'RDLC-07',
              severity: 'WARN',
              message: `Tablix "${tblName}" column sum (${colSumIn.toFixed(3)}in) differs from Width (${wIn.toFixed(3)}in).`,
              location: tblName,
            });
          }
          if (Number.isFinite(rowSumIn) && Math.abs(rowSumIn - hIn) > 0.03) {
            warnings.push({
              ruleId: 'RDLC-07',
              severity: 'WARN',
              message: `Tablix "${tblName}" row sum (${rowSumIn.toFixed(3)}in) differs from Height (${hIn.toFixed(3)}in).`,
              location: tblName,
            });
          }
        }
      }
    };

    validateReportItems(body?.ReportItems as Record<string, unknown> | undefined, 'Body');
    validateReportItems(page?.PageHeader?.ReportItems as Record<string, unknown> | undefined, 'PageHeader');
    validateReportItems(page?.PageFooter?.ReportItems as Record<string, unknown> | undefined, 'PageFooter');

    if (totalTablixes === 0) {
      warnings.push({
        ruleId: 'RDLC-03',
        severity: 'WARN',
        message: 'Report body contains zero Tablix elements.',
      });
    }

    // 5. Validate Field references & 6. Expression syntax
    const allFields = new Set(Array.from(dataSets.values()).flatMap((s) => Array.from(s)));
    const fieldExprMatches = rdlcXml.matchAll(/Fields!([A-Za-z0-9_]+)\.Value/g);
    for (const m of fieldExprMatches) {
      const fName = m[1];
      if (!allFields.has(fName)) {
        errors.push({
          ruleId: 'RDLC-05',
          severity: 'ERROR',
          message: `Expression references undefined DataSet field "${fName}".`,
        });
      }
    }

    const codeText = String(report.Code ?? '');
    const codeExprMatches = rdlcXml.matchAll(/=Code\.([A-Za-z0-9_]+)\s*\(/g);
    for (const m of codeExprMatches) {
      const fnName = m[1];
      if (!new RegExp(`Function\\s+${fnName}\\b`, 'i').test(codeText)) {
        errors.push({
          ruleId: 'RDLC-06',
          severity: 'ERROR',
          message: `Expression "=Code.${fnName}(...)" has no matching Public Function in <Code>.`,
        });
      }
    }

    // 8. Validate Page dimensions (supports in, cm, mm, pt) and section printable width
    const pageW = parseDimensionInches(page?.PageWidth);
    const pageH = parseDimensionInches(page?.PageHeight);
    if (!(pageW > 1) || !(pageH > 1)) {
      errors.push({
        ruleId: 'RDLC-08',
        severity: 'ERROR',
        message: 'PageWidth and PageHeight must be valid dimensions > 1in (in/cm/mm/pt).',
      });
    } else {
      const leftM = parseDimensionInches(page?.LeftMargin);
      const rightM = parseDimensionInches(page?.RightMargin);
      const sectionW = parseDimensionInches(section?.Width ?? report?.Width);
      if (
        Number.isFinite(sectionW) &&
        Number.isFinite(leftM) &&
        Number.isFinite(rightM) &&
        sectionW > pageW - leftM - rightM + 0.02
      ) {
        errors.push({
          ruleId: 'RDLC-08',
          severity: 'ERROR',
          message: `Report Width (${sectionW.toFixed(2)}in) exceeds PageWidth - LeftMargin - RightMargin (${(pageW - leftM - rightM).toFixed(2)}in).`,
        });
      }
    }

    // 10. Validate unsupported constructs
    const forbiddenTags = ['<html', '<div', '<table', '<script'];
    const lowerXml = rdlcXml.toLowerCase();
    for (const tag of forbiddenTags) {
      if (lowerXml.includes(tag)) {
        errors.push({
          ruleId: 'RDLC-10',
          severity: 'ERROR',
          message: `Unsupported HTML/script construct "${tag}" detected inside RDLC XML.`,
        });
      }
    }

    const valid = errors.length === 0;
    this.logger.info('RdlcValidation', `RDLC 10-point validation: ${valid ? 'PASS' : 'FAIL'}`, {
      errors: errors.length,
      warnings: warnings.length,
    });

    return {
      valid,
      checkedRules: 10,
      errors,
      warnings,
    };
  }
}
