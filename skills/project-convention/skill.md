# Skill: project-convention

## Purpose
Align generated RDLC, VB.NET, dataset names, parameters, and output paths with an existing target .NET project.

## Applicable Situations
- `--project` path or existing `.rdlc` / `.vb` files are supplied.
- Naming prefixes, namespace conventions, DataSet names, or parameter conventions must match existing codebase standards.

## Rules
1. Preserve existing DataSet names (e.g., `dsReportData`), parameter names, and font/color tokens discovered by `ProjectInspector`.
2. Never overwrite existing target files unless `--force` is explicitly specified.
3. Restrict all writes to configured allowed output directories inside the target project.

## Constraints
- Deterministic file writer handles all path normalization and overwrite checks.

## Forbidden Behavior
- Modifying `.csproj`, `.sln`, or unrelated source files automatically.
- Writing outside configured project output boundaries.

## Validation Requirements
- All generated artifacts (`*.rdlc`, `*.vb`, `dummy.json`, `report-definition.json`) must pass validation prior to project copy.
