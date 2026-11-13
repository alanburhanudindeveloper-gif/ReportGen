# Skill: vb-report

## Purpose
Map semantic report fields and detected calculation hints to clean, separated VB.NET report classes and RDLC VB expressions.

## Applicable Situations
- Existing `ExistingReport.vb` patterns or conventions are provided.
- Dynamic fields require RDLC expressions (`=Fields!...`, `=IIF(...)`, `=Format(...)`, `=Code....`).
- Business calculations need deterministic VB functions inside `GeneratedReport.vb` or embedded RDLC `<Code>`.

## Rules
1. Strictly separate: (a) Data access (`GetReportData() As DataTable`), (b) Business calculations (`CalculateLineTotal`, `CalculateDiscount`, etc.), (c) Formatting helpers, and (d) RDLC inline expressions.
2. Reuse existing VB function signatures and naming conventions when found by ProjectInspector.
3. Never mix SQL/data-fetching logic inside presentation formatting expressions.

## Constraints
- Every `=Code.<Fn>(...)` expression referenced in RDLC must correspond to a generated Public Function in `<Code>` and `GeneratedReport.vb`.

## Forbidden Behavior
- Generating untested calculation formulas when an Excel oracle specifies an explicit formula or expected output.
- Executing arbitrary shell or filesystem operations from VB templates.

## Validation Requirements
- All generated VB functions must pass deterministic logic tests before report finalization.
