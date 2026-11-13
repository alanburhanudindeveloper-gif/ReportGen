# Skill: dynamic-field

## Purpose
Classify ambiguous label/value pairs in PDF A and PDF B and bind representative extracted data safely into `DummyData` / `ReferencePdfExtract` fixtures.

## Applicable Situations
- Extracting populated values (Customer, PolicyNumber, Premium, BenefitAmount) from PDF B.
- Disambiguating static labels vs. dynamic placeholders in PDF A.

## Rules
1. Record exact provenance (`pdfFile`, `page`, `bbox`, `labelContext`, `confidence`) for every extracted value.
2. Mark uncertain extractions as `status: "UNCERTAIN"` instead of guessing silently.
3. Link dynamic fields to benchmark DataSet columns or explicitly declare new DataSet fields when absent in benchmark.

## Constraints
- Never fabricate numeric amounts without PDF B or explicit test fixture evidence.

## Forbidden Behavior
- Treating uncertain extractions as `HIGH` confidence automatically.
