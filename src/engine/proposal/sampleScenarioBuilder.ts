import {
  FieldBindingSpec,
  SampleScenarioDataset,
} from './types.ts';

export class SampleScenarioBuilder {
  public buildScenarios(bindings: FieldBindingSpec[]): SampleScenarioDataset[] {
    const buildBaseRow = (): Record<string, string | number | null> => {
      const row: Record<string, string | number | null> = {};
      for (const b of bindings) {
        row[b.field] = b.dummyValue;
      }
      return row;
    };

    // 1. Normal scenario (representative PDF B + project defaults)
    const normalRow = buildBaseRow();

    // 2. Empty / null data scenario
    const emptyNullRow: Record<string, string | number | null> = {};
    for (const b of bindings) {
      emptyNullRow[b.field] = b.field === 'ProductCode' || b.field === 'PlanCode' ? b.dummyValue : null;
    }

    // 3. Multiple rows scenario (tests repeating Tablix rows & page breaks)
    const rowA = buildBaseRow();
    const rowB = buildBaseRow();
    const rowC = buildBaseRow();
    for (const b of bindings) {
      if (b.dataType === 'System.Decimal') {
        rowB[b.field] = Number(b.dummyValue) * 1.25 || 2500;
        rowC[b.field] = Number(b.dummyValue) * 1.5 || 5000;
      } else if (b.field !== 'ProductCode' && b.field !== 'PlanCode') {
        rowB[b.field] = `${String(b.dummyValue)} (Tier 2)`;
        rowC[b.field] = `${String(b.dummyValue)} (Tier 3)`;
      }
    }

    // 4. Long text overflow / CanGrow wrapping scenario
    const longTextRow = buildBaseRow();
    for (const b of bindings) {
      if (b.dataType === 'System.String' && !b.isStatusField && b.field !== 'ProductCode' && b.field !== 'PlanCode') {
        longTextRow[b.field] =
          `${String(b.dummyValue)} — Extended executive beneficiary designation with supplemental multi-jurisdiction underwriting rider notes.`;
      }
    }

    // 5. Different status state variations
    const statusRow = buildBaseRow();
    for (const b of bindings) {
      if (b.isStatusField) {
        const states = b.candidateStates ?? ['Not Covered', 'Waived', 'Optional'];
        const alternate = states.find((s) => s !== String(b.dummyValue)) ?? 'Not Covered';
        statusRow[b.field] = alternate;
      }
    }

    // 6. Large numeric values (precision & formatting test)
    const largeNumericRow = buildBaseRow();
    for (const b of bindings) {
      if (b.dataType === 'System.Decimal') {
        largeNumericRow[b.field] = 98765432.15;
      } else if (b.dataType === 'System.Int32') {
        largeNumericRow[b.field] = 999999;
      }
    }

    return [
      {
        scenario: 'Normal',
        description: 'Baseline realistic sample payload prioritizing reference PDF B values.',
        rows: [normalRow],
      },
      {
        scenario: 'EmptyNull',
        description: 'Nullable fields set to null to verify RDLC IsNothing/Nothing expression safety.',
        rows: [emptyNullRow],
      },
      {
        scenario: 'MultipleRows',
        description: 'Multi-row DataTable verifying repeating Tablix rows and page break pagination.',
        rows: [rowA, rowB, rowC],
      },
      {
        scenario: 'LongText',
        description: 'Extended string values testing Textbox CanGrow wrapping and column widths.',
        rows: [longTextRow],
      },
      {
        scenario: 'DifferentStatus',
        description: 'Alternate status enum states testing conditional IIf visibility and formatting.',
        rows: [statusRow],
      },
      {
        scenario: 'LargeNumeric',
        description: 'High-magnitude currency/numeric inputs verifying overflow & decimal formatting.',
        rows: [largeNumericRow],
      },
    ];
  }
}
