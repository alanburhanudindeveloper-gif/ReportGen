# AGENT_WORKFLOW.md — End-to-End ReportGen Architecture, Flow & Usage Instructions

This document explains the end-to-end execution flow, runtime infrastructure, security boundaries, and step-by-step operating instructions for **ReportGen** across VS Code Agent, CLI, and Web UI workflows.

---

## 1. End-to-End Flow

ReportGen follows a **deterministic-first, preview-before-mutation** lifecycle. External/host LLMs never directly edit `.NET` project files or invent coordinates/XML from scratch.

```text
User Prompt / Input (PDF A, PDF B, .vbproj/.vb/.rdlc, .xlsx)
   │
   ▼
1. READ & SCAN (Deterministic Discovery)
   ├── proposal-cli tech-profile / catalog / scan / inspect
   ├── reportgen analyze / inspect
   └── Outputs compact structured JSON wrapped in UNTRUSTED_DOCUMENT_DATA
   │
   ▼
2. DIFFERENTIAL ANALYSIS & DETERMINISTIC BANDING
   ├── Deterministic rules resolve layout grids, bands, bindings & symbol diffs
   └── Regex ParameterDetector & TablixBuilder bind fields without external LLMs
   │
   ▼
3. PROPOSAL STAGING / DRY-RUN (Non-Mutating)
   ├── proposal-cli generate ...  --> writes isolated staging under output/<CODE>/
   ├── reportgen generate --dry-run --> validates in memory with zero target writes
   └── Outputs: <CODE>ProposalBuilder.vb, <CODE>ProposalElement.vb, <CODE>ProposalLayout.rdlc,
       modification-plan.json, dummy-data.json
   │
   ▼
4. DETERMINISTIC VALIDATION, TESTING & PREVIEW
   ├── RdlcValidator (10-point Tablix & schema validation; strict RDLC 2008 / 2016)
   ├── LogicTestRunner & ReportTestHarness (6 stress scenarios + Excel oracle)
   ├── VisualDiffEngine (Ghostscript rasterization + pixelmatch when comparison PDF exists)
   └── proposal-cli preview / reportgen preview / proposal-cli insert --dry-run
   │
   ▼
5. EXPLICIT APPROVAL GATE (Fail-Closed)
   ├── Human / User reviews diff summary, preserved ratio, affected files, and validation status
   └── Requires explicit `approve` or `insert --confirm` / `write_to_project` authorization
   │
   ▼
6. CONTROLLED MUTATION & POST-MUTATION VERIFICATION
   ├── Verifies `approval.json` status === "APPROVED" and SHA-256 artifact hashes
   ├── Aborts on target collisions unless `--allow-overwrite` is explicitly passed
   ├── Creates `.reportgen-backup/<timestamp>-<CODE>/` snapshot with automatic rollback
   ├── Copies `.vb` + `1..N .rdlc` files and updates `.vbproj` / `.csproj`
   └── Re-runs validation and tests; stops and reports immediately on failure
```

---

## 2. Infrastructure & Entry Points

### A. Entry Points
| Entry Point | Location | Responsibility |
| --- | --- | --- |
| **VS Code / Copilot Agent** | `.github/copilot-instructions.md`, `AGENTS.md`, `.vscode/tasks.json` | Host-selected LLM acts as reasoning/operator layer over ReportGen's deterministic CLI and categorized tools. |
| **Proposal CLI (`proposal-cli`)** | `src/cli/proposalCli.ts` (`npm run proposal-cli -- ...`) | Product scanning, VB.NET AST dependency graphs, benchmark inspection, Two-PDF proposal staging, approval, and `.vbproj` insertion. |
| **Core Report CLI (`reportgen`)** | `src/cli/reportgen.ts` (`npm run reportgen -- ...`) | Standalone PDF-to-RDLC Tablix + VB generation, RDLC/VB/Excel inspection, 10-point validation, logic testing, Render check, and visual diff. |
| **Web Workbench & API** | `server.ts` + `src/App.tsx` + `src/ui/ProposalWorkspace.tsx` | Local Express + Vite server (port `3000`) exposing `/api/health`, `/api/config`, `/api/mcp/tools`, `/api/pipeline/*`, and `/api/proposal/*`. |

### B. Deterministic Engine Core (`src/engine/`)
- **PDF & Layout Reconstruction (`src/engine/pdf/`)**: `PdfAnalyzer` extracts text spans, vector shapes, bounding boxes, and embedded/fallback images; `GridReconstructor` clusters coordinates into bands and columns.
- **RDLC & Tablix Engine (`src/engine/rdlc/`)**: `TablixBuilder`, `RdlcGenerator`, and `RdlcValidator` build and validate deterministic Tablix-based RDLC XML without HTML in the conversion pipeline.
- **VB.NET Code & Test Engine (`src/engine/vb/`, `src/engine/testing/`)**: `VbGenerator` produces VB.NET classes and embedded functions; `LogicTestRunner` and `VisualDiffEngine` verify calculations and page pixel similarity.
- **Proposal Adaptation Engine (`src/engine/proposal/`)**: `ReportGenProjectScanner`, `ProjectStructureParser`, `VbAstAnalyzer`, `TechnologyDetector`, `BenchmarkInspector`, `DummyDataExtractor`, `DifferentialAnalyzer`, `MinimalMutationPatcher`, `Rdlc2008Patcher`, `ReportTestHarness`, `StagingManager`, and `ProjectInserter`.
- **Tool Governance Registry (`src/engine/mcp/mcpTools.ts`)**: Categorizes every tool into `READ_ONLY`, `VALIDATION`, `PROPOSAL`, or `MUTATION` and enforces `assertAgentToolApproval()`.

### C. Zero-AI Deterministic Policy (`reportgen.config.yaml`)
- **Strict Offline Determinism**: ReportGen contains **zero AI/LLM SDKs or model calls** (`@google/genai` completely removed) and requires **no API keys**. Every layout extraction, Dual-Layer Hybrid RDLC build, and visual diff step is 100% reproducible.

---

## 3. Security Boundaries

### 1. Untrusted Document Content (`UNTRUSTED_DOCUMENT_DATA`)
- Implemented in `src/engine/core/untrustedContent.ts` and enforced in `src/cli/reportgen.ts` and `src/cli/proposalCli.ts`.
- All content parsed from `.pdf`, `.rdlc`, `.vb`, `.vbproj`/`.csproj`, and `.xlsx` files is treated strictly as **untrusted DATA**, never executable instructions.
- CLI JSON outputs wrap extracted data using `wrapUntrustedData()`:
  ```json
  {
    "_trustBoundary": "UNTRUSTED_DOCUMENT_DATA",
    "treatAsInstructions": false,
    "sourceKind": "mixed_project",
    "sourceName": "...",
    "suspiciousInstructionPatternsDetected": [],
    "data": { ... }
  }
  ```
- `detectPromptInjectionIndicators()` deterministically scans extracted document payloads for instruction-override or exfiltration text before returning structured JSON.

### 2. Credential, File & Network Isolation
- **Host-Owned Auth**: ReportGen never accesses VS Code tokens, GitHub credentials, Copilot tokens, browser cookies, or OS credential stores.
- **Path-Traversal Guard**: `resolveSafeSubpath()` and `security.allowedExtensions` block writes outside approved roots or extensions.
- **Fail-Closed Mutation Guard**: `assertAgentToolApproval()` rejects unregistered tools and blocks `MUTATION` tools (`approve_staging`, `insert_confirm`, `write_to_project`) with `SECURITY_VIOLATION` unless explicit approval is supplied.
- **Zero-Secret Health/Config APIs**: `/api/health` and `/api/config` return only deterministic engine metadata, never secrets or API keys.

---

## 4. Usage Instructions

### Step 1 — Discover Available Tools & Inspect Targets (`READ_ONLY`)
```bash
# List categorized Agent tools and approval requirements
npm run proposal-cli -- tools
npm run reportgen -- tools --category READ_ONLY

# Detect target .NET stack (VB.NET / C# / RDLC 2008 vs 2016)
npm run proposal-cli -- tech-profile --project samples/SampleProposalProject

# Build deterministic SHA-256 product catalog and AST dependency graph
npm run proposal-cli -- catalog --project samples/SampleProposalProject
npm run proposal-cli -- scan --project samples/SampleProposalProject

# Inspect a specific benchmark product cleanly (compact symbols & datasets, no full repo dump)
npm run proposal-cli -- inspect --project samples/SampleProposalProject --product MFA

# Inspect standalone RDLC / VB / Excel artifacts or PDF layout
npm run reportgen -- inspect --rdlc samples/SampleProposalProject/Proposal/MFA/MFAProposalLayout.rdlc
npm run reportgen -- analyze input.pdf --stdout
```

### Step 2 — Generate & Preview Proposals Without Modifying Project Files (`PROPOSAL`)
```bash
# Dry-run core generation (validates in memory, computes SHA-256 & visual parity, writes nothing to disk)
npm run reportgen -- generate input.pdf --dry-run

# Generate staged Two-PDF proposal adaptation into isolated output/<CODE>/
npm run proposal-cli -- generate \
  --project samples/SampleProposalProject \
  --product EGA \
  --benchmark MFA \
  --fixture

# Preview staged diff summary, preserved ratio, validation & approval state (read-only)
npm run proposal-cli -- preview --generated output/EGA
npm run reportgen -- preview output/EGA

# Run deterministic validation and test suites
npm run proposal-cli -- test --generated output/EGA
npm run reportgen -- validate output/EGA/EGAProposalLayout.rdlc
```

### Step 3 — Dry-Run Target Insertion Before Approval (`PROPOSAL`)
```bash
# Simulate copying staged files & .vbproj registration (checks hashes and collisions, writes nothing)
npm run proposal-cli -- insert \
  --project samples/SampleProposalProject \
  --generated output/EGA \
  --dry-run
```

### Step 4 — Agent & Human Approval Process for Mutations (`MUTATION`)
Mutations are **never** executed automatically. Present the `preview` diff, validation results, affected files, and `insert --dry-run` plan to the user first, and proceed only after **explicit user approval**:

1. **`approve` (Record Human Approval + SHA-256 Hashes)**
   ```bash
   npm run proposal-cli -- approve \
     --generated output/EGA \
     --by <reviewer-name> \
     --notes "Reviewed minimal diff and validation report"
   ```
   *(Pass `--override-warnings` only if non-fatal warnings were explicitly acknowledged by the reviewer.)*

2. **`insert --confirm` (Apply Proposal Adaptation to Target `.NET` Project)**
   ```bash
   npm run proposal-cli -- insert \
     --project samples/SampleProposalProject \
     --generated output/EGA \
     --confirm
   ```
   - Verifies `approval.json` is `APPROVED` and staged file SHA-256 hashes still match.
   - Aborts on existing file collisions unless `--allow-overwrite` is explicitly authorized.
   - Backs up any modified/overwritten targets into `.reportgen-backup/` with automatic rollback on failure.

3. **`write_to_project` (Standalone Core Report Artifact Integration)**
   - Triggered only via explicit `POST /api/pipeline/integrate` or `npm run reportgen -- generate <pdf> --project <dir>` (without `--dry-run`) after explicit user approval (`force: true` required to overwrite existing files).
   - Programmatic callers must pass `assertAgentToolApproval('write_to_project', { explicitApproval: true })`.

4. **Post-Mutation Validation (Mandatory)**
   - Immediately re-run `npm run proposal-cli -- test --generated output/EGA`, `npm run reportgen -- validate ...`, and `npm run lint && npm run build`. If any check fails, stop and report the failure immediately.
