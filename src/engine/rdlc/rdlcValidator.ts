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

function parseInches(val: unknown): number {
  if (typeof val !== 'string') return NaN;
  const m = val.trim().match(/^(-?\d+(?:\.\d+)?)\s*in$/i);
  return m ? Number(m[1]) : NaN;
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

    // 3. Validate Tablix structure & 4. DataSet references
    const tablixes = asArray(body?.ReportItems?.Tablix);
    if (tablixes.length === 0) {
      warnings.push({
        ruleId: 'RDLC-03',
        severity: 'WARN',
        message: 'Report body contains zero Tablix elements.',
      });
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

    for (const tbl of tablixes) {
      const tblName = String(tbl?.['@_Name'] ?? '');
      checkUniqueName(tblName, `Tablix(${tblName})`);

      const dsRef = String(tbl?.DataSetName ?? '');
      if (dsRef && !dataSets.has(dsRef)) {
        errors.push({
          ruleId: 'RDLC-04',
          severity: 'ERROR',
          message: `Tablix "${tblName}" references unknown DataSet "${dsRef}".`,
          location: tblName,
        });
      }

      const cols = asArray(tbl?.TablixBody?.TablixColumns?.TablixColumn);
      const rows = asArray(tbl?.TablixBody?.TablixRows?.TablixRow);
      const colMembers = asArray(tbl?.TablixColumnHierarchy?.TablixMembers?.TablixMember);
      const rowMembers = asArray(tbl?.TablixRowHierarchy?.TablixMembers?.TablixMember);

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

      rows.forEach((row, rIdx) => {
        const cells = asArray(row?.TablixCells?.TablixCell);
        if (cells.length !== cols.length) {
          errors.push({
            ruleId: 'RDLC-03',
            severity: 'ERROR',
            message: `Tablix "${tblName}" row ${rIdx} has ${cells.length} TablixCell elements, expected ${cols.length}.`,
            location: `${tblName}.Row[${rIdx}]`,
          });
        }
        cells.forEach((cell) => {
          const tb = cell?.CellContents?.Textbox;
          if (tb) checkUniqueName(tb?.['@_Name'], `${tblName}.Textbox`);
          const img = cell?.CellContents?.Image;
          if (img) checkUniqueName(img?.['@_Name'], `${tblName}.Image`);
        });
      });

      // 7. Validate Tablix dimensions
      const wIn = parseInches(tbl?.Width);
      const hIn = parseInches(tbl?.Height);
      if (!(wIn > 0) || !(hIn > 0)) {
        errors.push({
          ruleId: 'RDLC-07',
          severity: 'ERROR',
          message: `Tablix "${tblName}" has non-positive Width/Height.`,
          location: tblName,
        });
      }
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

    // 8. Validate Page dimensions
    const pageW = parseInches(page?.PageWidth);
    const pageH = parseInches(page?.PageHeight);
    if (!(pageW > 1) || !(pageH > 1)) {
      errors.push({
        ruleId: 'RDLC-08',
        severity: 'ERROR',
        message: 'PageWidth and PageHeight must be valid dimensions > 1in.',
      });
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
