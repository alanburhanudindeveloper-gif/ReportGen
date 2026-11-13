# Skill: proposal-layout

## Purpose
Guide benchmark-preserving Tablix-first adaptation of `*ProposalLayout.rdlc` to match PDF A layout differences.

## Applicable Situations
- Adapting benchmark RDLC DataSets, Parameters, Tablix regions, visibility expressions, and page breaks.
- Using embedded `<Image>` cells inside Tablix for complex non-tabular PDF A vector graphics.

## Rules
1. Preserve benchmark DataSource names, DataSet names, ReportParameters, and page geometry unless PDF A requires explicit adjustment.
2. Keep Tablix column/row/hierarchy counts strictly balanced (`TablixColumns == TablixColumnHierarchy` members).
3. Maintain valid `Fields!<Name>.Value` and `Parameters!<Name>.Value` references.

## Constraints
- HTML is never part of the generated RDLC artifact.

## Forbidden Behavior
- Emitting raw HTML tags inside RDLC XML.
