# Skill: proposal-builder

## Purpose
Guide symbol-safe adaptation of an existing benchmark `*ProposalBuilder.vb` file into a new `<ProductCode>ProposalBuilder.vb` class without redesigning the existing Proposal architecture.

## Applicable Situations
- Adapting a selected benchmark `ProposalBuilder.vb` for a new `ProductCode` and `PlanCode`.
- Handling `ProductEngine`-dependent fields when `ProductEngine` is incomplete or unavailable.

## Rules
1. Preserve the benchmark class structure, namespaces, imports, and unrelated business methods.
2. Safely rename known class identifiers, product/plan constants, element builder calls, and RDLC layout paths.
3. Represent unavailable `ProductEngine` bindings explicitly using `DataSourceMode` (`DummyData` or `ReferencePdfExtract`) with traceable `' [REPORTGEN_MOCK ...]` annotations.

## Constraints
- Never perform blind global text replacement across unrelated identifiers.
- Never omit required DataSet table/column setup expected by `ProposalLayout.rdlc`.

## Forbidden Behavior
- Directly editing the real target project outside `output/<ProductCode>/`.
- Silently hiding mocked `ProductEngine` values.
