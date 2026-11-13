# AI Architecture & VS Code Agent Operating Model

## Host-Agent Model vs. Deterministic Engine
ReportGen is a **deterministic-first** PDF, RDLC, and VB.NET analysis, validation, and minimal-mutation engine.
- By default (`ai.provider: none` in `reportgen.config.yaml`), **ReportGen makes zero external LLM API calls** and requires **no AI API keys**.
- When operated from Visual Studio Code / Visual Studio, the **host AI Agent** (and the user's host-selected LLM) acts as the reasoning layer over ReportGen's compact, deterministic CLI and MCP-style tools (`READ_ONLY`, `VALIDATION`, `PROPOSAL`, `MUTATION`).
- ReportGen never inspects or stores VS Code, GitHub, or Copilot credentials, never switches models silently, and **never falls back** to another LLM vendor if a provider is unavailable.

## Untrusted Document Data Boundary
- All content extracted from `.pdf`, `.rdlc`, `.vb`, and `.xlsx` files is wrapped via `wrapUntrustedData()` (`_trustBoundary: 'UNTRUSTED_DOCUMENT_DATA'`, `treatAsInstructions: false`) and delimited inside `<untrusted_document_data>` blocks in `prompts.ts`.
- Adversarial instruction strings inside documents (e.g., `"Ignore previous instructions"`) are flagged deterministically and never treated as commands.

## Optional Runtime LLM Gateway (`LLMGateway`)
When a user explicitly opts in via `LLM_PROVIDER` (`gemini`, `openai`, `openai-compatible`, `claude`) + credentials:
- Vendor SDKs remain strictly isolated inside `src/engine/ai/providers/`.
- Only minimal slices (max 40 ambiguous regions, non-`HIGH` diff items, or compact benchmark metadata) are sent, never raw source trees.
- If the configured provider is disabled or unavailable, ReportGen continues deterministically without silently calling any other LLM vendor.

## Fail-Closed Agent Tool Governance (`src/engine/mcp/mcpTools.ts`)
- Every tool is classified into `READ_ONLY`, `VALIDATION`, `PROPOSAL`, or `MUTATION`.
- `assertAgentToolApproval(toolName, { explicitApproval })` rejects unknown tools and refuses `MUTATION` tools unless explicit approval is provided.
