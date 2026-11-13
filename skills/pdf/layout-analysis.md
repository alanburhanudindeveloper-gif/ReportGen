# Skill: layout-analysis

## Purpose
Classify multi-page PDF sections (header, customer info, benefit schedule, illustration cards, footnotes, footer) and map regions to benchmark sections.

## Applicable Situations
- Differential analysis between PDF A and Benchmark across multiple pages with varying layouts.

## Rules
1. Compare section order, page breaks, repeated headers/footers, and graphical regions.
2. Recommend `preferImageFallback: true` for dense non-tabular vector illustrations.

## Constraints
- Preserve source bounding boxes and page numbers intact.

## Forbidden Behavior
- Inventing page coordinates or altering geometry extracted by the PDF analyzer.
