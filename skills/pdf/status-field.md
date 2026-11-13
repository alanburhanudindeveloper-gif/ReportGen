# Skill: status-field

## Purpose
Identify and model status badge/indicator fields (e.g., ACTIVE, PENDING, APPROVED, WAIVED) across PDF A, PDF B, and benchmark visibility/expression rules.

## Applicable Situations
- Short uppercase/state tokens appearing inside bordered boxes, table status columns, or summary cards.

## Rules
1. Identify the label, candidate state values, and visual representation (color/border/text expression).
2. Map status fields to RDLC expressions (`=IIF(...)` or `=Switch(...)`) preserving benchmark styling conventions.

## Constraints
- Ensure fallback behavior when status field is null or empty in dummy data.

## Forbidden Behavior
- Hardcoding a single status literal when PDF B and benchmark evidence show dynamic state binding.
