# Skill: rdlc-tablix

## Purpose
Guide semantic mapping from reconstructed page bands and grid cells into RDLC 2016 Tablix structures.

## Applicable Situations
- Determining whether a region band maps to a static header Tablix, a key-value metadata Tablix, a repeating row-group Detail Tablix, or a footer Tablix.
- Resolving merged cell intent (`ColSpan`, `RowSpan`) when grid spans cover multiple adjacent cells.
- Mapping existing RDLC dataset fields to detected dynamic value cells.

## Rules
1. Every page must decompose into one or more logical Tablix regions; never assume an entire multi-layout page is a single flat table.
2. Preserve repeating row structures by binding Detail Tablix row groups (`<Group Name="Details">`) to the primary DataSet.
3. Preserve visual fidelity for illustrations, logos, and complex timelines using `<Image>` inside `<TablixCell>` when flagged for image fallback.
4. Match `DataSetName` and `Fields!<Name>.Value` strictly against inspected or generated DataSet schemas.

## Constraints
- Tablix cell count per row accounting for `ColSpan` must equal `TablixColumns` count.
- All element names (`Tablix`, `Textbox`, `Image`, `Group`) must be unique PascalCase identifiers.

## Forbidden Behavior
- Outputting HTML or CSS instead of RDLC Tablix semantics.
- Generating raw RDLC XML strings inside AI responses.

## Validation Requirements
- Must pass deterministic 10-point RDLC XML & Tablix structural validation before file finalization.
