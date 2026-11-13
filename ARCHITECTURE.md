# Architecture

## Conversion Pipeline
```
PDF
 -> PdfAnalyzer (pdfjs-dist + Ghostscript raster/crop)
 -> IntermediateLayoutModel (normalized inches, fonts, styles, vectors, images)
 -> GridReconstructor (X/Y clustering, column/row boundaries, cell assignment, spans, bands)
 -> AI Reasoning (ambiguous regions only + selective skills)
 -> TablixBuilder -> ReportDefinition
 -> VbGenerator (VB.NET class + embedded RDLC functions + expressions)
 -> RdlcGenerator (deterministic RDLC 2016 XML)
 -> RdlcValidator (10-point deterministic gate)
 -> LogicTestRunner (Excel / JSON calculation oracle)
 -> ReportViewerRenderer (when available) -> VisualDiffEngine (Ghostscript + pixelmatch)
 -> ProjectIntegrator (safe write with --force guard)
```

## Module Responsibilities
- `src/engine/core/`: Domain types, structured logger, error codes, YAML config loader, path traversal guard.
- `src/engine/pdf/`: `PdfAnalyzer` extracts geometry, spans, fonts, vector lines/rects, and images. `GridReconstructor` clusters coordinates within `coordinateTolerance`, computes column/row boundaries, detects overlapping/merged cells, and segments pages into logical bands (`Header`, `Information`, `Detail`, `Cards`, `Timeline`, `Notes`, `Footer`).
- `src/engine/project/`: `ProjectInspector` inspects existing `.rdlc` and `.vb` files for DataSets, Fields, Parameters, and conventions. `ProjectIntegrator` safely writes outputs.
- `src/engine/rdlc/`: `TablixBuilder`, `RdlcGenerator`, and `RdlcValidator`.
- `src/engine/vb/`: `VbGenerator` separates Data Access, Business Calculations, Formatting Helpers, and RDLC expressions.
- `src/engine/excel/`: `ExcelOracleReader` and `dummy.json` generator.
- `src/engine/testing/`: `LogicTestRunner`, `ReportViewerRenderer`, and `VisualDiffEngine`.
- `src/engine/mcp/`: `MCP_TOOL_CATALOG` and service container (`createReportGenServices`).
- `src/engine/agent/`: `ReportGenAgent` orchestrating bounded iterations (`maxAgentIterations`).
