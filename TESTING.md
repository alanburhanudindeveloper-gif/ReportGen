# Testing & Validation

## 1. 10-Point RDLC Validation (`RdlcValidator`)
1. XML syntax well-formedness
2. Required `Report` / `ReportSections` / `Body` / `Page` structure
3. Tablix `TablixColumns` / `TablixRows` / hierarchy member count parity
4. `DataSetName` references exist in `<DataSets>`
5. `Fields!<Name>.Value` expressions reference valid DataSet fields
6. `=Code.<Fn>(...)` expressions match functions in `<Code>`
7. Positive Tablix dimensions
8. Valid Page dimensions (> 1in)
9. Unique element `Name` attributes across the report
10. Absence of unsupported HTML/script constructs

## 2. Independent VB Logic Testing (`LogicTestRunner`)
Executes calculation scenarios from `ExcelOracleReader` or `dummy.json` against generated VB calculation functions with explicit tolerances (`0.01` default). Report finalization is blocked if any test fails or if an Excel workbook is flagged as ambiguous.

## 3. Visual Regression (`VisualDiffEngine`)
Uses Ghostscript (`gs`) and `pixelmatch` to produce pixel-by-pixel diff images and real similarity scores (`overallSimilarity` and per-page `similarity`). Target threshold (`0.95`) is configurable in `reportgen.config.yaml` and is never hardcoded or fabricated.

## 4. Automated Test Suite
Run:
```bash
npx tsx tests/run-e2e-tests.ts
```
