# CLI Reference

Run via npm script (`npm run reportgen -- ...`, `npm run proposal-cli -- ...`) or `npx tsx`:

## 1. ReportGen Core CLI (`src/cli/reportgen.ts`)

### `reportgen tools [--category <READ_ONLY|VALIDATION|PROPOSAL|MUTATION>]`
Lists all Agent-accessible ReportGen tools with category, risk level, handler, and explicit approval requirements.

### `reportgen analyze <input.pdf> [--out <layout.json>] [--stdout]`
(`READ_ONLY` when `--stdout`) Extracts PDF geometry, text, vectors, and images, runs deterministic `GridReconstructor`, and outputs Intermediate Layout JSON wrapped in an `UNTRUSTED_DOCUMENT_DATA` boundary.

### `reportgen inspect [--rdlc <file.rdlc>] [--vb <file.vb>] [--excel <file.xlsx>]`
(`READ_ONLY`) Extracts DataSets, Fields, Parameters, VB functions, and Excel oracle scenarios wrapped as `UNTRUSTED_DOCUMENT_DATA`.

### `reportgen preview <outputDir>`
(`READ_ONLY`) Summarizes existing generated artifacts and RDLC validation status without mutating project files.

### `reportgen generate <input.pdf> [options]`
Runs the full pipeline (`PdfAnalyzer` -> `GridReconstructor` -> `ProjectInspector` -> deterministic/optional AI -> `TablixBuilder` -> `VbGenerator` -> `RdlcGenerator` -> `RdlcValidator` -> `LogicTestRunner`).
Options:
- `--project <dir>`: Target project root directory.
- `--output <relDir>`: Target relative output path inside `--project`.
- `--existing-rdlc <file>`: Existing RDLC pattern to inspect.
- `--existing-vb <file>`: Existing VB.NET report class to inspect.
- `--excel <file>`: Finance Excel oracle workbook (`.xlsx`).
- `--no-ai`: Disable runtime LLM calls and use deterministic semantic logic.
- `--dry-run`: (`PROPOSAL`) Validate and print output summary without writing any files.
- `--force`: Allow overwriting existing output files (requires explicit confirmation).

### `reportgen validate <outputDirOrRdlcFile>`
(`VALIDATION`) Runs the 10-point deterministic RDLC validator and exits non-zero on failure.

### `reportgen test <outputDir> [--excel <file>] [--json <file>]`
(`VALIDATION`) Runs generated VB logic tests independently from RDLC rendering against Excel or JSON scenarios.

### `reportgen render <report.rdlc>`
(`VALIDATION`) Invokes ReportViewer rendering when `dotnet` and `REPORTVIEWER_CLI_PATH` are available; otherwise reports `Rendering not verified in this environment.`

### `reportgen compare <original.pdf> <generated.pdf> [--out <visual-diff>]`
(`VALIDATION`) Rasterizes both PDFs with Ghostscript and computes per-page pixel similarity with `pixelmatch`.

---

## 2. Proposal Adaptation CLI (`src/cli/proposalCli.ts`)

### Read-Only Commands
- `proposal-cli tools [--category <READ_ONLY|VALIDATION|PROPOSAL|MUTATION>]`
- `proposal-cli tech-profile --project <dir>`
- `proposal-cli catalog --project <dir>`
- `proposal-cli scan --project <dir>`
- `proposal-cli inspect --project <dir> --product <CODE>`
- `proposal-cli preview --generated <stagingDir>`

### Proposal & Validation Commands (Target Project Untouched)
- `proposal-cli generate --project <dir> --product <CODE> [--plan <PLAN>] [--benchmark <CODE>] [--pdf-a <a.pdf>] [--pdf-b <b.pdf>] [--no-ai] [--fixture]`
- `proposal-cli test --generated <stagingDir>`
- `proposal-cli insert --project <dir> --generated <stagingDir> --dry-run`

### Mutation Commands (Explicit User Approval Required)
- `proposal-cli approve --generated <stagingDir> --by <reviewer> [--reject] [--notes <text>] [--override-warnings]`
- `proposal-cli insert --project <dir> --generated <stagingDir> --confirm [--allow-overwrite]`
