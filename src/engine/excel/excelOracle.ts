import * as XLSX from 'xlsx';
import {
  LogicTestCase,
  ReportDefinition,
  StructuredLogger,
} from '../core/types.ts';

export interface ExcelOracleResult {
  sheetName: string;
  testCases: LogicTestCase[];
  ambiguousWarnings: string[];
}

export class ExcelOracleReader {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public readBuffer(excelBytes: Buffer): ExcelOracleResult {
    const workbook = XLSX.read(excelBytes, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return {
        sheetName: '',
        testCases: [],
        ambiguousWarnings: ['Excel workbook contains no worksheets.'],
      };
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (rows.length === 0) {
      return {
        sheetName,
        testCases: [],
        ambiguousWarnings: [`Worksheet "${sheetName}" contains no data rows.`],
      };
    }

    const headers = Object.keys(rows[0]);
    const ambiguousWarnings: string[] = [];

    const scenarioCol = headers.find((h) => /scenario|case|test|name/i.test(h));
    const expectedCols = headers.filter((h) => /expected|target|result|output|nettotal|linetotal/i.test(h));
    const toleranceCol = headers.find((h) => /tolerance|eps/i.test(h));

    if (expectedCols.length === 0) {
      ambiguousWarnings.push(
        `Ambiguous Excel structure in "${sheetName}": no column matched Expected/Result/Output. Flagged for review instead of guessing.`
      );
      this.logger.warn('ExcelOracle', ambiguousWarnings[0]);
      return { sheetName, testCases: [], ambiguousWarnings };
    }

    if (expectedCols.length > 1) {
      ambiguousWarnings.push(
        `Multiple candidate expected columns found (${expectedCols.join(', ')}); using "${expectedCols[0]}". Verify intended oracle target.`
      );
    }

    const expectedCol = expectedCols[0];
    const inputCols = headers.filter(
      (h) => h !== scenarioCol && h !== expectedCol && h !== toleranceCol
    );

    const testCases: LogicTestCase[] = [];
    rows.forEach((row, idx) => {
      const expectedNum = Number(String(row[expectedCol]).replace(/[^0-9.-]/g, ''));
      if (Number.isNaN(expectedNum)) {
        ambiguousWarnings.push(`Row ${idx + 2}: expected value "${String(row[expectedCol])}" is not numeric; skipped.`);
        return;
      }

      const inputs: Record<string, number | string> = {};
      for (const col of inputCols) {
        const raw = row[col];
        const asNum = Number(String(raw).replace(/[^0-9.-]/g, ''));
        inputs[col] = raw !== '' && !Number.isNaN(asNum) && /[0-9]/.test(String(raw)) ? asNum : String(raw);
      }

      const tol = toleranceCol ? Number(row[toleranceCol]) || 0.01 : 0.01;
      testCases.push({
        scenario: scenarioCol && row[scenarioCol] ? String(row[scenarioCol]) : `ExcelRow_${idx + 2}`,
        inputs,
        expectedField: expectedCol,
        expectedValue: expectedNum,
        tolerance: tol,
        source: 'excel',
      });
    });

    this.logger.info('ExcelOracle', `Parsed ${testCases.length} Excel test case(s) from "${sheetName}"`, {
      warnings: ambiguousWarnings.length,
    });

    return { sheetName, testCases, ambiguousWarnings };
  }

  public generateDummyJson(definition: ReportDefinition): Record<string, unknown> {
    const sampleItem: Record<string, unknown> = {};
    for (const f of definition.fields) {
      sampleItem[f.name] = f.sampleValue;
    }

    const dummy: Record<string, unknown> = {
      _comment: 'Test data only. Never use dummy JSON as the production runtime data source.',
      ReportName: definition.reportName,
      DataSetName: definition.dataSetName,
      Parameters: Object.fromEntries(
        definition.parameters.map((p) => [p.name, p.defaultValue ?? 'Sample'])
      ),
      [definition.dataSetName]: [sampleItem],
      LogicTestScenarios: [
        {
          scenario: 'Standard line item with 10% discount',
          inputs: { Qty: 10, Price: 100000, DiscountPercent: 10 },
          expectedField: 'LineTotal',
          expectedValue: 900000,
          tolerance: 0.01,
        },
        {
          scenario: 'Zero discount baseline',
          inputs: { Qty: 4, Price: 250.5, DiscountPercent: 0 },
          expectedField: 'LineTotal',
          expectedValue: 1002.0,
          tolerance: 0.01,
        },
        {
          scenario: 'Net total with 11% VAT',
          inputs: { Subtotal: 1000, TaxRatePercent: 11 },
          expectedField: 'NetTotal',
          expectedValue: 1110,
          tolerance: 0.01,
        },
      ],
    };

    if (definition.sampleDetailRows && definition.sampleDetailRows.length > 0) {
      dummy.detailRows = definition.sampleDetailRows;
    }

    return dummy;
  }
}
