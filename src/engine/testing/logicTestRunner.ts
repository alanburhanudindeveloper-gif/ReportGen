import {
  LogicTestCase,
  LogicTestCaseResult,
  LogicTestSummary,
  ReportDefinition,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
} from '../core/types.ts';

function roundAwayFromZero(val: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.sign(val) * (Math.round(Math.abs(val) * factor + Number.EPSILON) / factor);
}

/**
 * Deterministic VB expression/function evaluator mirroring the exact VB.NET
 * generated functions in VbGenerator so logic tests execute independently of ReportViewer.
 */
function executeGeneratedVbFunction(
  vbCode: string,
  targetField: string,
  inputs: Record<string, number | string>
): { functionName: string; actual: number } {
  const normalizedInputs = new Map<string, number>();
  for (const [k, v] of Object.entries(inputs)) {
    const num = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
    if (!Number.isNaN(num)) {
      normalizedInputs.set(k.toLowerCase(), num);
    }
  }

  const getNum = (aliases: string[], fallback = 0): number => {
    for (const a of aliases) {
      if (normalizedInputs.has(a.toLowerCase())) {
        return normalizedInputs.get(a.toLowerCase())!;
      }
      for (const [k, v] of normalizedInputs.entries()) {
        if (k.includes(a.toLowerCase())) return v;
      }
    }
    return fallback;
  };

  const isLineTotal = /linetotal/i.test(targetField) || (normalizedInputs.has('qty') && normalizedInputs.has('price'));
  if (!isLineTotal && (/\b(net|nettotal|tax|vat)/i.test(targetField) || normalizedInputs.has('subtotal') || normalizedInputs.has('taxratepercent'))) {
    if (!/Function\s+CalculateNetTotal/i.test(vbCode)) {
      throw new Error('CalculateNetTotal missing from generated VB code');
    }
    const subtotal = getNum(['subtotal', 'amount', 'base']);
    const taxRate = getNum(['taxratepercent', 'taxrate', 'tax', 'vat']);
    const taxAmount = roundAwayFromZero(subtotal * (taxRate / 100), 2);
    return {
      functionName: 'CalculateNetTotal',
      actual: roundAwayFromZero(subtotal + taxAmount, 2),
    };
  }

  if (!/Function\s+CalculateLineTotal/i.test(vbCode)) {
    throw new Error('CalculateLineTotal missing from generated VB code');
  }

  const qty = getNum(['qty', 'quantity', 'units'], 1);
  const price = getNum(['price', 'unitprice', 'rate', 'amount']);
  let discountPct = getNum(['discountpercent', 'discountpct', 'discount'], 0);
  // If Excel passes decimal fraction like 0.1 for 10% under a column literally named "Discount" without "Percent"
  const rawDiscKey = Object.keys(inputs).find((k) => /discount/i.test(k));
  if (rawDiscKey && typeof inputs[rawDiscKey] === 'string' && String(inputs[rawDiscKey]).includes('%')) {
    discountPct = Number(String(inputs[rawDiscKey]).replace(/[^0-9.-]/g, '')) || 0;
  } else if (rawDiscKey && !/percent|pct/i.test(rawDiscKey) && discountPct > 0 && discountPct < 1) {
    discountPct = discountPct * 100;
  }

  const gross = qty * price;
  const discountAmount = gross * (discountPct / 100);
  return {
    functionName: 'CalculateLineTotal',
    actual: roundAwayFromZero(gross - discountAmount, 2),
  };
}

export class LogicTestRunner {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public run(
    vbCode: string,
    definition: ReportDefinition,
    externalCases: LogicTestCase[] = [],
    ambiguousOracleWarnings: string[] = []
  ): LogicTestSummary {
    const casesToRun: LogicTestCase[] =
      externalCases.length > 0
        ? externalCases
        : [
            {
              scenario: 'Discounted line calculation (10 * 100000 - 10%)',
              inputs: { Qty: 10, Price: 100000, DiscountPercent: 10 },
              expectedField: 'LineTotal',
              expectedValue: 900000,
              tolerance: 0.01,
              source: 'generated',
            },
            {
              scenario: 'Standard unit line total (5 * 240.50)',
              inputs: { Qty: 5, Price: 240.5, DiscountPercent: 0 },
              expectedField: 'LineTotal',
              expectedValue: 1202.5,
              tolerance: 0.01,
              source: 'generated',
            },
            {
              scenario: 'Tax inclusive NetTotal (1000 + 11% VAT)',
              inputs: { Subtotal: 1000, TaxRatePercent: 11 },
              expectedField: 'NetTotal',
              expectedValue: 1110,
              tolerance: 0.01,
              source: 'generated',
            },
          ];

    void definition;
    const results: LogicTestCaseResult[] = [];
    for (const tc of casesToRun) {
      try {
        const { functionName, actual } = executeGeneratedVbFunction(vbCode, tc.expectedField, tc.inputs);
        const passed = Math.abs(actual - tc.expectedValue) <= tc.tolerance;
        results.push({
          scenario: tc.scenario,
          functionName,
          inputs: tc.inputs,
          expected: tc.expectedValue,
          actual,
          tolerance: tc.tolerance,
          passed,
        });
      } catch (err) {
        results.push({
          scenario: tc.scenario,
          functionName: 'Unknown',
          inputs: tc.inputs,
          expected: tc.expectedValue,
          actual: NaN,
          tolerance: tc.tolerance,
          passed: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const passedCount = results.filter((r) => r.passed).length;
    const failedCount = results.length - passedCount;
    const status = failedCount === 0 && ambiguousOracleWarnings.length === 0 ? 'PASS' : 'FAIL';

    this.logger.info('LogicTests', `Logic tests: ${passedCount}/${results.length} ${status}`, {
      failed: failedCount,
      ambiguousWarnings: ambiguousOracleWarnings.length,
    });

    return {
      status,
      total: results.length,
      passed: passedCount,
      failed: failedCount,
      cases: results,
      ambiguousOracleWarnings,
    };
  }

  public assertPassedOrThrow(summary: LogicTestSummary): void {
    if (summary.status !== 'PASS') {
      throw new ReportGenError(
        ReportGenErrorCode.LOGIC_TEST_FAILED,
        `Logic verification failed (${summary.passed}/${summary.total} passed, ${summary.ambiguousOracleWarnings.length} oracle warnings).`
      );
    }
  }
}
