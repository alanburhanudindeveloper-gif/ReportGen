# Skill: finance-calculation

## Purpose
Interpret ambiguous financial calculations, rounding rules, tax/discount precedence, and Excel oracle column mappings.

## Applicable Situations
- An Excel reference workbook is supplied as a test oracle with multiple candidate input/expected columns.
- Financial totals, subtotals, discounts, or tax rates appear in the PDF without explicit operator documentation.

## Rules
1. Only infer calculation relationships supported by observable PDF labels/values or Excel test rows.
2. Identify exact rounding mode and numeric tolerance (default `0.01`) when comparing Decimal/Currency calculations.
3. If Excel column headers or formula intent remain ambiguous, return `needsHumanReview: true` rather than guessing.

## Constraints
- Excel is strictly a test oracle / verification reference, never a runtime data dependency.

## Forbidden Behavior
- Hardcoding expected test values to pass logic tests.
- Inventing tax rates or discount rules without evidence.

## Validation Requirements
- Logic test runner must achieve 100% pass rate across all verified Excel/JSON scenarios before finalization.
