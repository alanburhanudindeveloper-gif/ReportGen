# ReportGen & Proposal Report Adaptation Engine

An AI-assisted, deterministic-first automation platform for:

1. **Proposal Report Adaptation (`proposal-cli` & Proposal UI)** — Automates creating new insurance/proposal reports from proven production **VB.NET** + **RDLC 2008** benchmark implementations via **minimal mutation** (`COPY → RENAME → PATCH ONLY REQUIRED PARTS`).
2. **PDF → RDLC Tablix + VB.NET Conversion Pipeline (`reportgen` CLI & ReportGen Workbench)** — Decomposes uploaded PDF templates into coordinate-clustered RDLC Tablix models, VB.NET logic, test scenarios, and visual diffs without HTML in the conversion pipeline.

---

## Core Architectural Principles

- **AI decides WHAT; Deterministic code decides HOW; Existing production code defines WHAT IS ALREADY PROVEN.**
- **VB.NET & RDLC 2008 Contract**: Existing target `.vb` (`ProposalBuilder.vb`, `ProposalElement.vb`) and `.rdlc` (`http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition`) implementations are preserved (~87–95% reused verbatim) rather than rewritten from scratch or translated into C#.
- **No HTML Simulation in Production Reports**: Reports target genuine RDLC Tablix XML executed by Microsoft ReportViewer (`LocalReport.Render("PDF")`).
- **Safe Staging & Human Approval Gate**: Generated artifacts are isolated under `output/<ProductCode>/` and never written into the target repository without passing tests, SHA-256 verification, explicit human approval (`approval.json`), dry-run inspection, and collision protection.

---

## Implemented Capabilities (Phases 1 & 2 + Core Engine)

### Phase 1 — Project Scanner, Product Discovery & Dependency Reconciliation
- **VB.NET AST Parsing (`src/engine/proposal/vbAstAnalyzer.ts`)**: Starts from each `*ProposalBuilder.vb` entry point to extract classes, modules, namespaces, methods, constructors (`New <Element>`), `ProductEngine` calls, `DataTable` columns, and `1..N` `.rdlc` references.
- **Reconciled Dependency Graph (`src/engine/proposal/projectScanner.ts`)**:
  - Maps `ProposalBuilder` → `1..N Element classes` → `1..N RDLC files` → `DataSets` / `Parameters` / `ProductEngine`.
  - Classifies RDLCs as `direct`, `indirect`, or `shared`.
  - Surfaces `sharedRdlcs`, `unusedRdlcCandidates`, and `unresolvedReferences` (for example flagging missing `*ProposalElement` classes referenced by a Builder).

### Phase 2 — Deterministic `TechnologyProfile` Detection
- **Target Stack Inspection (`src/engine/proposal/technologyDetector.ts`)**:
  - Parses `.vbproj` / `.csproj` (`Sdk`, `TargetFramework`, `OutputType`, `RootNamespace`, `OptionStrict`, `<Compile>`, `<EmbeddedResource>`, `<PackageReference>`) and inspects `.rdlc` XML namespaces (`2008` vs `2016`).
  - Probes host binary availability (`dotnet`, `msbuild`, `vbc`) honestly without fabricating runtime results.
  - Persists `analysis/technology-profile.json` and `analysis/project-analysis.json` in staging and enforces `VB.NET` + `RDLC 2008` as hard generation/validation constraints.
  - Emits explicit `TECHNOLOGY_DETECTION_FAILED` diagnostics when pointed at an invalid or non-.NET directory.

### Adaptation, Testing, Staging & Safe Project Insertion
- **Two-PDF Workflow**:
  - **PDF A (New Product Template)**: Drives section diffs, geometry, and layout adjustments.
  - **PDF B (Reference System PDF)**: Extracts realistic sample values with coordinates and 4-tier provenance (`extracted | inferred | unavailable | manually_supplied`), plus manual field confirmation.
- **Minimal-Mutation Patching & Diff Accounting**:
  - `MinimalMutationPatcher` preserves unrelated VB.NET helper methods verbatim and generates `UNCHANGED | RENAMED | MODIFIED | ADDED | REMOVED | REQUIRES_REVIEW` symbol reports.
  - `Rdlc2008Patcher` clones all benchmark `.rdlc` files, rebinds `DataSources`/`DataSets`, adds only missing `<Field>`/`<ReportParameter>`/`<Tablix>` elements, and outputs strict **RDLC 2008**.
- **6 Stress-Test Sample Scenarios (`SampleScenarioBuilder`)**: Generates `Normal`, `EmptyNull`, `MultipleRows`, `LongText`, `DifferentStatus`, and `LargeNumeric` datasets alongside isolated `BuildReferenceDataTable()` adapters (`[REPORTGEN_MOCK]`).
- **Report Test Harness & Bounded `DiagnosisAgent`**: Validates VB.NET symbols, data bindings, strict `RDLC-2008` + 10-point Tablix rules across all RDLC files, visual regression (Ghostscript + `pixelmatch`), and runs up to 3 bounded repair attempts.
- **Controlled Insertion (`ProjectInserter`)**: Verifies `APPROVED` status and SHA-256 hashes, supports `--dry-run`, aborts on collisions unless `--allow-overwrite` is specified, creates `.reportgen-backup/` snapshots with automatic rollback, and registers `.vb` + `1..N .rdlc` items in `.vbproj`.

---

## Repository Structure

```text
├── server.ts                          # Express API + Vite dev middleware (port 3000)
├── reportgen.config.yaml              # Pipeline thresholds, AI model, and path policies
├── src/
│   ├── cli/
│   │   ├── proposalCli.ts             # proposal-cli (tech-profile, scan, generate, test, approve, insert)
│   │   └── reportgen.ts               # Generic PDF -> RDLC/VB CLI
│   ├── engine/
│   │   ├── proposal/                  # Proposal Adaptation Engine
│   │   │   ├── projectStructureParser.ts  # Deterministic MSBuild .vbproj/.csproj/.sln parser
│   │   │   ├── reportGenProjectScanner.ts # ReportGen.Project.Scanner service & catalog builder
│   │   │   ├── technologyDetector.ts  # Phase 2 TechnologyProfile detector
│   │   │   ├── vbAstAnalyzer.ts       # Structural VB.NET AST & dependency graph builder
│   │   │   ├── projectScanner.ts      # Scanner facade & benchmark ranking
│   │   │   ├── benchmarkInspector.ts  # SHA-256 cached benchmark inspection
│   │   │   ├── dummyDataExtractor.ts  # PDF B extraction + provenance
│   │   │   ├── differentialAnalyzer.ts# PDF A vs benchmark diff + selective Gemini reasoning
│   │   │   ├── proposalDefinitionBuilder.ts
│   │   │   ├── minimalMutationPatcher.ts
│   │   │   ├── rdlc2008Patcher.ts
│   │   │   ├── sampleScenarioBuilder.ts
│   │   │   ├── reportTestHarness.ts
│   │   │   ├── stagingManager.ts
│   │   │   ├── projectInserter.ts
│   │   │   └── proposalOrchestrator.ts
│   │   ├── pdf/                       # PdfAnalyzer + GridReconstructor
│   │   ├── rdlc/                      # TablixBuilder, RdlcGenerator (2008/2016), RdlcValidator
│   │   ├── vb/                        # Deterministic VB helper code generator
│   │   ├── testing/                   # LogicTestRunner & Ghostscript/pixelmatch VisualDiffEngine
│   │   └── agent/                     # ReportGenAgent orchestrator
│   ├── ui/                            # React Workbench & ProposalWorkspace UI
│   └── samples/                       # Programmatic PDF fixtures for verification
├── samples/SampleProposalProject/     # Sample VB.NET + RDLC 2008 production-style project (MFA, ABC)
├── dotnet/
│   │   ├── src/
│   │   │   ├── ReportGen.Core/            # Shared .NET report models
│   │   │   ├── ReportGen.Project.Scanner/ # C# ReportGen.Project.Scanner library
│   │   │   ├── ReportGen.Rdlc/            # RDLC Tablix serializer
│   │   │   └── ReportGen.Vb/              # VB.NET code generator
│   │   └── vb-runner/                     # Standalone Windows VB.NET LocalReport.Render("PDF") runner
├── python/                            # Companion Python PDF/Excel helpers
└── tests/
    ├── run-e2e-tests.ts               # Core PDF -> RDLC/VB E2E tests
    └── run-proposal-e2e.ts            # Proposal Adaptation Engine E2E tests
```

---

## Quick Start

### 1. Install & Run the Web Workbench
```bash
npm install
npm run dev
```
Open `http://localhost:3000`:
- Switch to **Proposal Adaptation** to scan `samples/SampleProposalProject`, inspect `TechnologyProfile` and AST dependency graphs, run the Two-PDF fixture (or upload custom PDF A / PDF B files), review diff/provenance/scenarios, approve staging, run `--dry-run`, and test controlled project insertion.

### 2. Proposal CLI (`proposal-cli`)
```bash
# Phase 2: Inspect target project technology profile
npm run proposal-cli -- tech-profile --project samples/SampleProposalProject

# ReportGen.Project.Scanner: Parse .vbproj/.csproj & generate deterministic product catalog
npm run proposal-cli -- catalog --project samples/SampleProposalProject

# Phase 1: AST scan, product discovery & dependency graph reconciliation
npm run proposal-cli -- scan --project samples/SampleProposalProject

# Generate staged VB.NET + RDLC 2008 artifacts using the built-in Two-PDF fixture
npm run proposal-cli -- generate --project samples/SampleProposalProject --product EGA --benchmark MFA --fixture

# Inspect test results
npm run proposal-cli -- test --generated output/EGA

# Explicitly approve staged artifacts
npm run proposal-cli -- approve --generated output/EGA --by lead-reviewer --override-warnings

# Preview and apply insertion into target project
npm run proposal-cli -- insert --project samples/SampleProposalProject --generated output/EGA --dry-run
npm run proposal-cli -- insert --project samples/SampleProposalProject --generated output/EGA --confirm
```

### 3. Build, Lint & Tests
```bash
npm run build
npm run lint
npx tsx tests/run-e2e-tests.ts
npx tsx tests/run-proposal-e2e.ts
```

---

## Staging Workspace Layout (`output/<PRODUCT>/`)

```text
output/<PRODUCT>/
├── analysis/
│   ├── technology-profile.json
│   ├── project-analysis.json
│   ├── template-analysis.json
│   └── benchmark-analysis.json
├── decision/
│   ├── modification-plan.json
│   └── proposal-definition.json
├── generated/
│   ├── <PRODUCT>ProposalBuilder.vb
│   ├── <PRODUCT>ProposalElement.vb
│   ├── <PRODUCT>ProposalLayout.rdlc
│   └── <PRODUCT>Benefit.rdlc          # Additional RDLCs when benchmark uses multi-RDLC
├── test/
│   ├── dummy-data.json                # Includes 6 stress scenarios
│   ├── validation-report.json
│   ├── test-results.json
│   └── visual-comparison.json
└── insert/
    ├── approval.json
    └── insert-manifest.json
```
*(Root-level copies are also maintained inside `output/<PRODUCT>/` for backwards compatibility with existing CLI flags.)*

---

## API Endpoints (`server.ts`)

- `GET /api/health` — Service & Gemini configuration check
- `POST /api/proposal/tech-profile` — Phase 2 `TechnologyProfile` inspection
- `POST /api/proposal/catalog` — `ReportGen.Project.Scanner` deterministic `.vbproj`/`.csproj` & `ProposalBuilder.vb` catalog
- `POST /api/proposal/scan` — Phase 1 + 2 project scan, parsed projects & dependency graph
- `POST /api/proposal/run` — Execute full Two-PDF adaptation pipeline into staging
- `POST /api/proposal/confirm-field` — Re-stage with manually confirmed PDF B field values
- `POST /api/proposal/approve` — Record explicit `APPROVED` / `REJECTED` decision with SHA-256 verification
- `POST /api/proposal/insert-dry-run` — Simulate target project insertion & collision checks
- `POST /api/proposal/insert-confirm` — Execute controlled copy + backup + `.vbproj` update

---

## Environment Notes & Limitations

- Configure `GEMINI_API_KEY` in `.env` (see `.env.example`) for optional AI semantic refinement; without a key (or with `--no-ai`), the deterministic engine completes all structural steps offline.
- In Linux containers without `dotnet`, `msbuild`, `vbc`, or Windows Microsoft ReportViewer installed, `TechnologyProfile` sets `compilerAvailableInEnvironment: false` and ReportViewer rendering honestly reports `NOT_VERIFIED_IN_ENVIRONMENT` (`"Rendering not verified in this environment."`).
- To compile and execute `LocalReport.Render("PDF")` on Windows with .NET 8 SDK installed, run the companion project under `dotnet/vb-runner/ReportViewerRunner.vbproj`.
