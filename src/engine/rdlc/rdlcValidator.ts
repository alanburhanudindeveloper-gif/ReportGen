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

export interface RdlcValidationRuntimeContext {
  sourcePageCount?: number;
  renderedPageCount?: number;
  collisionsCount?: number;
  perPageParity?: Array<{ page: number; parityPercent: number }>;
  targetParityPercent?: number;
  deterministicShaMatch?: boolean;
}

export interface RdlcValidationOptions {
  requireRdlc2008?: boolean;
  strictCompiled2008?: boolean;
  context?: RdlcValidationRuntimeContext;
}

function extractTextRunsFromNode(tb: Record<string, unknown>): string[] {
  const out: string[] = [];
  const paragraphs = asArray(
    (tb?.Paragraphs as Record<string, unknown> | undefined)?.Paragraph as
      | Record<string, unknown>
      | Record<string, unknown>[]
  );
  for (const p of paragraphs) {
    const runs = asArray(
      (p?.TextRuns as Record<string, unknown> | undefined)?.TextRun as
        | Record<string, unknown>
        | Record<string, unknown>[]
    );
    const line = runs
      .map((r) => {
        const v = r?.Value;
        if (v === undefined || v === null || typeof v === 'object') return '';
        return String(v);
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (line && !line.startsWith('=')) {
      out.push(line);
    }
  }
  return out;
}

function collectNonExpressionLines(
  reportItems: Record<string, unknown> | undefined,
  sink: string[]
): void {
  if (!reportItems) return;
  for (const tb of asArray(
    reportItems.Textbox as Record<string, unknown> | Record<string, unknown>[]
  )) {
    sink.push(...extractTextRunsFromNode(tb));
  }
  for (const rect of asArray(
    reportItems.Rectangle as Record<string, unknown> | Record<string, unknown>[]
  )) {
    collectNonExpressionLines(rect?.ReportItems as Record<string, unknown> | undefined, sink);
  }
  for (const tbl of asArray(
    reportItems.Tablix as Record<string, unknown> | Record<string, unknown>[]
  )) {
    const tRows = ((tbl?.TablixBody as Record<string, unknown> | undefined)?.TablixRows as
      | Record<string, unknown>
      | undefined)?.TablixRow;
    for (const row of asArray(tRows as Record<string, unknown> | Record<string, unknown>[])) {
      const cells = asArray(
        (row?.TablixCells as Record<string, unknown> | undefined)?.TablixCell as
          | Record<string, unknown>
          | Record<string, unknown>[]
      );
      for (const cell of cells) {
        const cc = cell?.CellContents as Record<string, unknown> | undefined;
        if (!cc) continue;
        if (cc.Textbox) {
          sink.push(...extractTextRunsFromNode(cc.Textbox as Record<string, unknown>));
        }
        if (cc.Rectangle) {
          collectNonExpressionLines(
            (cc.Rectangle as Record<string, unknown>)?.ReportItems as
              | Record<string, unknown>
              | undefined,
            sink
          );
        }
        if (cc.Tablix) {
          collectNonExpressionLines({ Tablix: cc.Tablix }, sink);
        }
      }
    }
  }
}

export class RdlcValidator {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public validate(rdlcXml: string, options?: RdlcValidationOptions): RdlcValidationResult {
    const errors: RdlcValidationDiagnostic[] = [];
    const warnings: RdlcValidationDiagnostic[] = [];
    const has2008Ns = /http:\/\/schemas\.microsoft\.com\/sqlserver\/reporting\/2008\/01\/reportdefinition/i.test(
      rdlcXml
    );
    const is2008 = Boolean(options?.requireRdlc2008) || has2008Ns;

    // 1. Validate XML well-formedness
    const xmlCheck = XMLValidator.validate(rdlcXml);
    if (xmlCheck !== true) {
      errors.push({
        ruleId: 'RDLC-01',
        severity: 'ERROR',
        message: `Invalid XML syntax: ${xmlCheck.err.msg} (line ${xmlCheck.err.line})`,
      });
      return { valid: false, checkedRules: is2008 ? 10 : 15, errors, warnings };
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
    });
    const parsed = parser.parse(rdlcXml);
    const report = parsed?.Report;

    if (options?.requireRdlc2008) {
      if (!has2008Ns || report?.ReportSections) {
        errors.push({
          ruleId: 'RDLC-2008',
          severity: 'ERROR',
          message:
            'RDLC 2008 schema is required (xmlns=".../2008/01/reportdefinition" with top-level <Body> and <Page>, no <ReportSections>).',
        });
      }
    } else if (is2008 && report?.ReportSections) {
      errors.push({
        ruleId: 'RDLC-2008',
        severity: 'ERROR',
        message: 'RDLC 2008 report must not contain <ReportSections>.',
      });
    }

    if (is2008 && options?.strictCompiled2008) {
      if (report?.ReportParameters) {
        errors.push({
          ruleId: 'RDLC-2008',
          severity: 'ERROR',
          message: 'Strict RDLC 2008 mode forbids <ReportParameters>.',
          location: 'Report',
        });
      }
      if (/<Visibility\b/i.test(rdlcXml)) {
        errors.push({
          ruleId: 'RDLC-2008',
          severity: 'ERROR',
          message: 'Strict RDLC 2008 mode forbids <Visibility> elements.',
          location: 'Report',
        });
      }
      if (/<RowSpan\b/i.test(rdlcXml)) {
        errors.push({
          ruleId: 'RDLC-2008',
          severity: 'ERROR',
          message: 'Strict RDLC 2008 mode forbids <RowSpan> (simulate vertical merges with empty continuation cells).',
          location: 'Report',
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
      return { valid: false, checkedRules: is2008 ? 10 : 15, errors, warnings };
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

    // 3. Recursively validate ReportItems across Body, PageHeader, PageFooter, nested Rectangles, and nested Tablixes
    let totalTablixes = 0;
    const validateSingleTablix = (tbl: Record<string, unknown>, ctx: string) => {
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

      const pbLoc = (tbl?.PageBreak as Record<string, unknown> | undefined)?.BreakLocation;
      if (pbLoc !== undefined) {
        const loc = String(pbLoc).trim();
        if (!['Start', 'End', 'Between'].includes(loc)) {
          errors.push({
            ruleId: 'RDLC-15',
            severity: 'ERROR',
            message: `Tablix "${tblName}" has invalid PageBreak BreakLocation "${loc}".`,
            location: tblName,
          });
        }
      }

      const tBody = tbl?.TablixBody as Record<string, unknown> | undefined;
      const tCols = (tBody?.TablixColumns as Record<string, unknown> | undefined)?.TablixColumn;
      const tRows = (tBody?.TablixRows as Record<string, unknown> | undefined)?.TablixRow;
      const tColMembers = (
        (tbl?.TablixColumnHierarchy as Record<string, unknown> | undefined)?.TablixMembers as
          | Record<string, unknown>
          | undefined
      )?.TablixMember;
      const tRowMembers = (
        (tbl?.TablixRowHierarchy as Record<string, unknown> | undefined)?.TablixMembers as
          | Record<string, unknown>
          | undefined
      )?.TablixMember;

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

      for (const rm of rowMembers) {
        const rmPb = (rm?.PageBreak as Record<string, unknown> | undefined)?.BreakLocation;
        if (rmPb !== undefined && !['Start', 'End', 'Between'].includes(String(rmPb).trim())) {
          errors.push({
            ruleId: 'RDLC-15',
            severity: 'ERROR',
            message: `Tablix "${tblName}" row member has invalid PageBreak BreakLocation "${String(rmPb)}".`,
            location: tblName,
          });
        }
      }

      const covered = Array.from({ length: rows.length }, () => Array(cols.length).fill(false));
      rows.forEach((row, rIdx) => {
        const cells = asArray(
          (row?.TablixCells as Record<string, unknown> | undefined)?.TablixCell as
            | Record<string, unknown>
            | Record<string, unknown>[]
        );
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
            const nestedTbl = cc.Tablix as Record<string, unknown> | undefined;
            if (nestedTbl) {
              if (is2008 && options?.strictCompiled2008) {
                errors.push({
                  ruleId: 'RDLC-2008',
                  severity: 'ERROR',
                  message: `Tablix "${tblName}" contains forbidden nested <Tablix> inside CellContents [${rIdx},${cIdx}].`,
                  location: `${tblName}.Row[${rIdx}].Col[${cIdx}]`,
                });
              }
              validateSingleTablix(nestedTbl, `${tblName}.Cell[${rIdx},${cIdx}]`);
            }
            const nestedRect = cc.Rectangle as Record<string, unknown> | undefined;
            if (nestedRect) {
              const nrName = String(nestedRect?.['@_Name'] ?? '');
              checkUniqueName(nrName, `${tblName}.Cell[${rIdx},${cIdx}].Rectangle`);
              validateReportItems(
                nestedRect?.ReportItems as Record<string, unknown> | undefined,
                `${tblName}.${nrName}`
              );
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
        if (Number.isFinite(colSumIn) && Math.abs(colSumIn - wIn) > 0.035) {
          warnings.push({
            ruleId: 'RDLC-07',
            severity: 'WARN',
            message: `Tablix "${tblName}" column sum (${colSumIn.toFixed(3)}in) differs from Width (${wIn.toFixed(3)}in).`,
            location: tblName,
          });
        }
        if (Number.isFinite(rowSumIn) && Math.abs(rowSumIn - hIn) > 0.035) {
          warnings.push({
            ruleId: 'RDLC-07',
            severity: 'WARN',
            message: `Tablix "${tblName}" row sum (${rowSumIn.toFixed(3)}in) differs from Height (${hIn.toFixed(3)}in).`,
            location: tblName,
          });
        }
      }
    };

    const validateReportItems = (reportItems: Record<string, unknown> | undefined, ctx: string) => {
      if (!reportItems) return;

      for (const rect of asArray(
        reportItems.Rectangle as Record<string, unknown> | Record<string, unknown>[]
      )) {
        const rectName = String(rect?.['@_Name'] ?? '');
        checkUniqueName(rectName, `${ctx}.Rectangle(${rectName})`);
        validateReportItems(rect?.ReportItems as Record<string, unknown> | undefined, `${ctx}.${rectName}`);
      }

      for (const tb of asArray(
        reportItems.Textbox as Record<string, unknown> | Record<string, unknown>[]
      )) {
        const tbName = String(tb?.['@_Name'] ?? '');
        checkUniqueName(tbName, `${ctx}.Textbox(${tbName})`);
      }

      for (const img of asArray(
        reportItems.Image as Record<string, unknown> | Record<string, unknown>[]
      )) {
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

      for (const tbl of asArray(
        reportItems.Tablix as Record<string, unknown> | Record<string, unknown>[]
      )) {
        validateSingleTablix(tbl, ctx);
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
    const leftM = parseDimensionInches(page?.LeftMargin);
    const rightM = parseDimensionInches(page?.RightMargin);
    const printableW =
      Number.isFinite(pageW) && Number.isFinite(leftM) && Number.isFinite(rightM)
        ? pageW - leftM - rightM
        : pageW;

    if (!(pageW > 1) || !(pageH > 1)) {
      errors.push({
        ruleId: 'RDLC-08',
        severity: 'ERROR',
        message: 'PageWidth and PageHeight must be valid dimensions > 1in (in/cm/mm/pt).',
      });
    } else {
      const sectionW = parseDimensionInches(section?.Width ?? report?.Width);
      if (
        Number.isFinite(sectionW) &&
        Number.isFinite(printableW) &&
        sectionW > printableW + 0.02
      ) {
        errors.push({
          ruleId: 'RDLC-08',
          severity: 'ERROR',
          message: `Report Width (${sectionW.toFixed(2)}in) exceeds PageWidth - LeftMargin - RightMargin (${printableW.toFixed(2)}in).`,
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

    // Rules RDLC-11..15 (Full-Tablix / Chrome / Containment / Runtime Collision & Flow Gate)
    {
      const bodyItems = (body?.ReportItems ?? {}) as Record<string, unknown>;
      const topBodyRects = asArray(
        bodyItems.Rectangle as Record<string, unknown> | Record<string, unknown>[]
      );
      const topBodyTablixes = asArray(
        bodyItems.Tablix as Record<string, unknown> | Record<string, unknown>[]
      );
      const topBodyTextboxes = asArray(
        bodyItems.Textbox as Record<string, unknown> | Record<string, unknown>[]
      );
      const topBodyImages = asArray(
        bodyItems.Image as Record<string, unknown> | Record<string, unknown>[]
      );
      const topBodyLines = asArray(
        bodyItems.Line as Record<string, unknown> | Record<string, unknown>[]
      );

      const hasV2Sections = topBodyRects.some((r) => /^Section_/i.test(String(r?.['@_Name'] ?? '')));
      const isV3FullTablix =
        !hasV2Sections &&
        topBodyTablixes.some((t) => /^Tablix_/i.test(String(t?.['@_Name'] ?? '')));

      // RDLC-11: Canonical single PageHeader / PageFooter deduplication + zero chrome leakage in Body
      const pageHeaders = asArray(page?.PageHeader as Record<string, unknown> | Record<string, unknown>[]);
      const pageFooters = asArray(page?.PageFooter as Record<string, unknown> | Record<string, unknown>[]);
      if (pageHeaders.length > 1 || pageFooters.length > 1) {
        errors.push({
          ruleId: 'RDLC-11',
          severity: 'ERROR',
          message: 'Report Page must contain at most one <PageHeader> and one <PageFooter>.',
          location: 'Page',
        });
      }

      if (isV3FullTablix && (pageHeaders.length > 0 || pageFooters.length > 0)) {
        const chromeLines: string[] = [];
        if (pageHeaders[0]?.ReportItems) {
          collectNonExpressionLines(pageHeaders[0].ReportItems as Record<string, unknown>, chromeLines);
        }
        if (pageFooters[0]?.ReportItems) {
          collectNonExpressionLines(pageFooters[0].ReportItems as Record<string, unknown>, chromeLines);
        }
        const chromeSignatures = new Set(
          chromeLines
            .map((l) => l.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
            .filter((s) => s.length >= 20 && !/^page \d+/.test(s))
        );
        if (chromeSignatures.size > 0) {
          const bodyLines: string[] = [];
          collectNonExpressionLines(bodyItems, bodyLines);
          for (const bl of bodyLines) {
            const norm = bl.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (norm.length >= 20 && chromeSignatures.has(norm)) {
              errors.push({
                ruleId: 'RDLC-11',
                severity: 'ERROR',
                message: `Chrome line "${bl.slice(0, 60)}" from PageHeader/PageFooter was duplicated inside <Body>.`,
                location: 'Body',
              });
              break;
            }
          }
        }
      }

      // RDLC-12: PrintOnFirstPage & chrome band height consistency
      for (const [bandName, bandNode] of [
        ['PageHeader', pageHeaders[0]],
        ['PageFooter', pageFooters[0]],
      ] as const) {
        if (!bandNode) continue;
        const bh = parseDimensionInches(bandNode.Height);
        if (!(bh > 0)) {
          errors.push({
            ruleId: 'RDLC-12',
            severity: 'ERROR',
            message: `${bandName} must declare positive <Height>.`,
            location: bandName,
          });
        }
        if (bandNode.PrintOnFirstPage !== undefined) {
          const val = String(bandNode.PrintOnFirstPage).trim().toLowerCase();
          if (val !== 'true' && val !== 'false') {
            errors.push({
              ruleId: 'RDLC-12',
              severity: 'ERROR',
              message: `${bandName}.PrintOnFirstPage must be 'true' or 'false' (got "${val}").`,
              location: bandName,
            });
          }
        }
        if (bandNode.PrintOnLastPage !== undefined) {
          const val = String(bandNode.PrintOnLastPage).trim().toLowerCase();
          if (val !== 'true' && val !== 'false') {
            errors.push({
              ruleId: 'RDLC-12',
              severity: 'ERROR',
              message: `${bandName}.PrintOnLastPage must be 'true' or 'false' (got "${val}").`,
              location: bandName,
            });
          }
        }
      }

      // RDLC-13: Full-Tablix Body enforcement & printable width containment
      if (isV3FullTablix) {
        if (
          topBodyRects.length > 0 ||
          topBodyTextboxes.length > 0 ||
          topBodyImages.length > 0 ||
          topBodyLines.length > 0
        ) {
          errors.push({
            ruleId: 'RDLC-13',
            severity: 'ERROR',
            message: `Full-Tablix <Body><ReportItems> must contain ONLY <Tablix> elements (found Rectangles=${topBodyRects.length}, Textboxes=${topBodyTextboxes.length}, Images=${topBodyImages.length}, Lines=${topBodyLines.length}).`,
            location: 'Body.ReportItems',
          });
        }

        for (const tbl of topBodyTablixes) {
          const tblName = String(tbl?.['@_Name'] ?? '');
          const tx = parseDimensionInches(tbl?.Left);
          const tw = parseDimensionInches(tbl?.Width);
          if (
            Number.isFinite(tx) &&
            Number.isFinite(tw) &&
            Number.isFinite(printableW) &&
            (tx < -0.02 || tx + tw > printableW + 0.04)
          ) {
            errors.push({
              ruleId: 'RDLC-13',
              severity: 'ERROR',
              message: `Body Tablix "${tblName}" overflows printable page width (${(tx + tw).toFixed(3)}in > ${printableW.toFixed(3)}in).`,
              location: tblName,
            });
          }
        }
      } else if (hasV2Sections && !is2008) {
        for (const secRect of topBodyRects) {
          const secName = String(secRect?.['@_Name'] ?? '');
          const subRects = asArray(
            (secRect?.ReportItems as Record<string, unknown> | undefined)?.Rectangle as
              | Record<string, unknown>
              | Record<string, unknown>[]
          );
          const leftCol = subRects.find((r) => /_LeftColumn$/i.test(String(r?.['@_Name'] ?? '')));
          const rightCol = subRects.find((r) => /_RightColumn$/i.test(String(r?.['@_Name'] ?? '')));
          if (leftCol && rightCol) {
            const lX = parseDimensionInches(leftCol.Left);
            const lW = parseDimensionInches(leftCol.Width);
            const rX = parseDimensionInches(rightCol.Left);
            if (Number.isFinite(lX) && Number.isFinite(lW) && Number.isFinite(rX) && lX + lW > rX + 0.02) {
              errors.push({
                ruleId: 'RDLC-13',
                severity: 'ERROR',
                message: `Section "${secName}" LeftColumn overlaps RightColumn horizontally (${(lX + lW).toFixed(3)}in > ${rX.toFixed(3)}in).`,
                location: secName,
              });
            }
          }
          for (const sub of subRects) {
            const subName = String(sub?.['@_Name'] ?? '');
            if (!/_(?:LeftColumn|RightColumn|HeaderBand|FooterBand)$/i.test(subName)) continue;
            const colW = parseDimensionInches(sub.Width);
            const colItems = sub?.ReportItems as Record<string, unknown> | undefined;
            if (!colItems || !(colW > 0)) continue;
            const checkChildren = [
              ...asArray(colItems.Textbox as Record<string, unknown> | Record<string, unknown>[]),
              ...asArray(colItems.Image as Record<string, unknown> | Record<string, unknown>[]),
              ...asArray(colItems.Tablix as Record<string, unknown> | Record<string, unknown>[]),
            ];
            for (const ch of checkChildren) {
              const cName = String(ch?.['@_Name'] ?? '');
              const cx = parseDimensionInches(ch.Left);
              const cw = parseDimensionInches(ch.Width);
              if (Number.isFinite(cx) && Number.isFinite(cw) && (cx < -0.02 || cx + cw > colW + 0.03)) {
                errors.push({
                  ruleId: 'RDLC-13',
                  severity: 'ERROR',
                  message: `Item "${cName}" inside "${subName}" overflows column bounds (${(cx + cw).toFixed(3)}in > ${colW.toFixed(3)}in).`,
                  location: `${secName}.${subName}`,
                });
              }
            }
          }
        }
      }

      // RDLC-14: Zero full-page Layer0 raster blobs & valid positive Textbox geometry
      if (isV3FullTablix || hasV2Sections) {
        const inspectGeometryNodes = (ri: Record<string, unknown> | undefined, ctx: string) => {
          if (!ri) return;
          for (const im of asArray(ri.Image as Record<string, unknown> | Record<string, unknown>[])) {
            const imName = String(im?.['@_Name'] ?? '');
            const iw = parseDimensionInches(im?.Width);
            const ih = parseDimensionInches(im?.Height);
            if (
              imName.startsWith('Img_Layer0_') ||
              (Number.isFinite(iw) &&
                Number.isFinite(ih) &&
                Number.isFinite(pageW) &&
                Number.isFinite(pageH) &&
                iw > pageW * 0.85 &&
                ih > pageH * 0.85)
            ) {
              errors.push({
                ruleId: 'RDLC-14',
                severity: 'ERROR',
                message: `Oversized Layer 0 full-page image "${imName}" is disallowed in Single-RDLC mode.`,
                location: `${ctx}.${imName}`,
              });
            }
          }
          for (const tb of asArray(ri.Textbox as Record<string, unknown> | Record<string, unknown>[])) {
            const tbName = String(tb?.['@_Name'] ?? '');
            const tw = parseDimensionInches(tb?.Width);
            const th = parseDimensionInches(tb?.Height);
            if (!(tw > 0) || !(th > 0)) {
              errors.push({
                ruleId: 'RDLC-14',
                severity: 'ERROR',
                message: `Textbox "${tbName}" must have positive Width and Height.`,
                location: `${ctx}.${tbName}`,
              });
            }
          }
          for (const r of asArray(ri.Rectangle as Record<string, unknown> | Record<string, unknown>[])) {
            inspectGeometryNodes(
              r?.ReportItems as Record<string, unknown> | undefined,
              `${ctx}.${String(r?.['@_Name'] ?? 'Rect')}`
            );
          }
          for (const tbl of asArray(ri.Tablix as Record<string, unknown> | Record<string, unknown>[])) {
            const tName = String(tbl?.['@_Name'] ?? 'Tablix');
            const tRows = ((tbl?.TablixBody as Record<string, unknown> | undefined)?.TablixRows as
              | Record<string, unknown>
              | undefined)?.TablixRow;
            for (const row of asArray(tRows as Record<string, unknown> | Record<string, unknown>[])) {
              const cells = asArray(
                (row?.TablixCells as Record<string, unknown> | undefined)?.TablixCell as
                  | Record<string, unknown>
                  | Record<string, unknown>[]
              );
              for (const cell of cells) {
                const cc = cell?.CellContents as Record<string, unknown> | undefined;
                if (!cc) continue;
                if (cc.Image) {
                  const imName = String((cc.Image as Record<string, unknown>)?.['@_Name'] ?? '');
                  if (imName.startsWith('Img_Layer0_')) {
                    errors.push({
                      ruleId: 'RDLC-14',
                      severity: 'ERROR',
                      message: `Oversized Layer 0 image "${imName}" is disallowed inside Tablix "${tName}".`,
                      location: `${ctx}.${tName}`,
                    });
                  }
                }
                if (cc.Rectangle) {
                  const rc = cc.Rectangle as Record<string, unknown>;
                  inspectGeometryNodes(
                    rc?.ReportItems as Record<string, unknown> | undefined,
                    `${ctx}.${tName}.${String(rc?.['@_Name'] ?? 'CellRect')}`
                  );
                }
                if (cc.Tablix) {
                  inspectGeometryNodes({ Tablix: cc.Tablix }, `${ctx}.${tName}`);
                }
              }
            }
          }
        };
        inspectGeometryNodes(bodyItems, 'Body');
        inspectGeometryNodes(page?.PageHeader?.ReportItems as Record<string, unknown> | undefined, 'PageHeader');
        inspectGeometryNodes(page?.PageFooter?.ReportItems as Record<string, unknown> | undefined, 'PageFooter');
      }

      // RDLC-15: Canonical units + Runtime Collision, Page Parity & Visual Parity Gate
      const unitType = String(report?.ReportUnitType ?? '').trim();
      if (!unitType || !['Cm', 'Inch'].includes(unitType)) {
        errors.push({
          ruleId: 'RDLC-15',
          severity: 'ERROR',
          message: `Report must declare valid <rd:ReportUnitType> ("Cm" or "Inch", got "${unitType || 'none'}").`,
          location: 'Report',
        });
      }

      const ctx = options?.context;
      if (ctx) {
        if (ctx.deterministicShaMatch === false) {
          errors.push({
            ruleId: 'RDLC-15',
            severity: 'ERROR',
            message: 'Determinism check failed: repeated RDLC XML generation produced mismatched SHA-256.',
            location: 'Runtime',
          });
        }
        if (ctx.collisionsCount !== undefined && ctx.collisionsCount > 0) {
          errors.push({
            ruleId: 'RDLC-15',
            severity: 'ERROR',
            message: `Layout collision gate failed: ${ctx.collisionsCount} overlapping element pair(s) detected.`,
            location: 'PreviewRenderer',
          });
        }
        if (
          ctx.sourcePageCount !== undefined &&
          ctx.renderedPageCount !== undefined &&
          ctx.renderedPageCount !== ctx.sourcePageCount
        ) {
          const diag = {
            ruleId: 'RDLC-15',
            severity: is2008 ? ('WARN' as const) : ('ERROR' as const),
            message: `Page parity notice: rendered ${ctx.renderedPageCount} page(s) vs source PDF ${ctx.sourcePageCount} page(s).`,
            location: 'VisualDiff',
          };
          if (is2008) warnings.push(diag);
          else errors.push(diag);
        }
        if (ctx.perPageParity && ctx.perPageParity.length > 0) {
          const threshold = ctx.targetParityPercent ?? 95.0;
          const failingPages = ctx.perPageParity.filter((p) => p.parityPercent < threshold);
          if (failingPages.length > 0) {
            const summary = failingPages
              .map((p) => `P${p.page}=${p.parityPercent.toFixed(2)}%`)
              .join(', ');
            const diag = {
              ruleId: 'RDLC-15',
              severity: is2008 ? ('WARN' as const) : ('ERROR' as const),
              message: `Visual parity check (< ${threshold.toFixed(1)}%) on: ${summary}.`,
              location: 'VisualDiff',
            };
            if (is2008) warnings.push(diag);
            else errors.push(diag);
          }
        }
      }
    }

    const checkedRules = is2008 ? 10 : 15;
    const valid = errors.length === 0;
    this.logger.info('RdlcValidation', `RDLC ${checkedRules}-point validation: ${valid ? 'PASS' : 'FAIL'}`, {
      checkedRules,
      errors: errors.length,
      warnings: warnings.length,
    });

    return {
      valid,
      checkedRules,
      errors,
      warnings,
    };
  }
}
