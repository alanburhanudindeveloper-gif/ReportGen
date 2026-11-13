# Skill: report-validation

## Purpose
Guide the bounded DiagnosisAgent when interpreting structured failures from the Report Test Harness (VB Logic, Data Binding, RDLC Structural, Rendering, Visual Comparison).

## Applicable Situations
- `RdlcValidator` or `ReportTestHarness` reports missing DataSet fields, missing parameters, or Tablix parity errors.

## Rules
1. Inspect the exact error location, `ProposalDefinition`, `BenchmarkAnalysis`, and generated staging RDLC/VB.
2. Propose only minimal deterministic fixes (e.g. adding missing DataSet `<Field>`, adding `<ReportParameter>`, aligning Tablix column widths).
3. Re-run the full Report Test Harness after applying any correction.

## Constraints
- Strict maximum of 3 diagnosis retries.
- Never silence a test failure or bypass the User Approval Gate.

## Forbidden Behavior
- Editing files in the real target project during diagnosis.
