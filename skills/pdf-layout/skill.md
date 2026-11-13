# Skill: pdf-layout

## Purpose
Resolve ambiguous semantic roles and grouping for extracted PDF layout regions after deterministic geometry extraction and grid clustering have completed.

## Applicable Situations
- A text region cannot be deterministically classified as a static label vs. a dynamic data value.
- Adjacent bordered boxes or shadowed regions may represent KPI summary cards or an illustration/timeline sequence.
- Multi-column text blocks need logical reading order or section grouping (header, info, detail, notes, footer).
- A dense vector cluster is a candidate for image fallback vs. native Tablix cells.

## Rules
1. Never alter or invent `x`, `y`, `width`, `height`, `pageNumber`, or `sourceRefs`.
2. Classify each ambiguous `regionId` into a concrete `semanticRole` (e.g., `reportTitle`, `sectionHeading`, `fieldLabel`, `fieldValue`, `tableHeader`, `tableCell`, `cardContainer`, `timelineStep`, `footerText`, `logoOrGraphic`, `calculationField`).
3. Provide a numeric `confidence` score between `0.0` and `1.0` and a brief factual `rationale` grounded in the region's text and neighbor context.
4. When `isComplexGraphic` evidence exists (many vector paths, overlapping curves, non-grid illustration), recommend `preferImageFallback: true`.

## Constraints
- Only return valid JSON matching the requested decision schema.
- Do not fabricate missing text or database column names without evidence from the region or existing report inspection.

## Forbidden Behavior
- Computing or overriding coordinates or column/row widths.
- Emitting RDLC XML or VB.NET source code directly.
- Guessing unverified business formulas.

## Validation Requirements
- Every returned `regionId` must exist in the input ambiguous regions subset.
- `confidence` below `ai.confidenceThreshold` must be flagged for human review.
