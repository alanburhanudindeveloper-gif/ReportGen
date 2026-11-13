# Skill: table-detection

## Purpose
Separate true repeating-row Tablix tables from static key-value grids, card rows, and multi-column narrative blocks.

## Applicable Situations
- PDF A or PDF B contains bordered grids, benefit schedules, or premium schedules.

## Rules
1. Require consistent column alignment across >= 2 data rows below a header row before marking `isRepeatingDetail: true`.
2. Preserve merged column/row spans (`ColSpan`, `RowSpan`) deterministically from clustered X/Y boundaries.

## Constraints
- Never merge unrelated adjacent page bands into a single monolithic table.

## Forbidden Behavior
- Using AI to compute column widths or row heights.
