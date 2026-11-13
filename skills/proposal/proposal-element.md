# Skill: proposal-element

## Purpose
Guide adaptation of benchmark `*ProposalElement.vb` methods (`Build*Element`) based on differential analysis between PDF A, Benchmark, and PDF B.

## Applicable Situations
- Mapping new, renamed, modified, or removed sections/benefits between the benchmark and PDF A.
- Resolving visibility conditions and status label formatting in element builders.

## Rules
1. Reuse matching benchmark elements (`REUSE`) or adapt symbols cleanly (`RENAME`, `MODIFY`) with `CHG-xxxx` traceability.
2. Keep element method signatures and return types consistent with the benchmark `ProposalElement` convention.
3. Explicitly flag medium/low confidence element mappings (`requiresReview: true`) for user confirmation.

## Constraints
- Every generated `Build*Element` symbol must trace back to a `ModificationChange` in `modification-plan.json`.

## Forbidden Behavior
- Inventing arbitrary method signatures incompatible with `ProposalBuilder.vb`.
