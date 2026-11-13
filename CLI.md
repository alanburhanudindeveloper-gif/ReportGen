# CLI Reference

Run via npm script (`npm run reportgen -- ...`) or `npx tsx src/cli/reportgen.ts ...`:

## Commands

### `reportgen analyze <input.pdf> [--out <layout.json>]`
Extracts PDF geometry, text, vectors, and images, runs deterministic `GridReconstructor`, and outputs Intermediate Layout JSON.

### `reportgen generate <input.pdf> [options]`
Runs the full pipeline (`PdfAnalyzer` -> `GridReconstructor` -> `ProjectInspector` -> `AI` -> `TablixBuilder` -> `VbGenerator` -> `RdlcGenerator` -> `RdlcValidator` -> `LogicTestRunner`) and writes `<Name>.rdlc`, `<Name>.vb`, `dummy.json`, and `report-definition.json`.
Options:
- `--project <dir>`: Target project root directory.
- `--output <relDir>`: Target relative output path inside `--project`.
- `--existing-rdlc <file>`: Existing RDLC pattern to inspect.
- `--existing-vb <file>`: Existing VB.NET report class to inspect.
- `--excel <file>`: Finance Excel oracle workbook (`.xlsx`).
- `--no-ai`: Disable LLM calls and use deterministic semantic fallback.
- `--force`: Allow overwriting existing output files (disabled by default).

### `reportgen validate <outputDirOrRdlcFile>`
Runs the 10-point deterministic RDLC validator and exits non-zero on failure.

### `reportgen test <outputDir> [--excel <file>] [--json <file>]`
Runs generated VB logic tests independently from RDLC rendering against Excel or JSON scenarios.

### `reportgen render <report.rdlc>`
Invokes ReportViewer rendering when `dotnet` and `REPORTVIEWER_CLI_PATH` are available; otherwise reports `Rendering not verified in this environment.`

### `reportgen compare <original.pdf> <generated.pdf> [--out <visual-diff>]`
Rasterizes both PDFs with Ghostscript and computes per-page pixel similarity with `pixelmatch`, outputting `page-XX-diff.png` and `report.json`.
