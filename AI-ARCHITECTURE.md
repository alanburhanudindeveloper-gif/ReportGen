# AI Architecture & Context Engineering

## Responsibility Boundary
AI is strictly limited to ambiguous semantic decisions:
- Determining whether short text is a `fieldLabel`, `fieldValue`, `tableHeader`, or `sectionHeading`.
- Identifying `cardContainer`, `timelineStep`, or `calculationField` roles.
- Confirming `preferImageFallback` on dense vector clusters.
- Matching ambiguous fields against inspected existing RDLC field names.

AI **never**:
- Calculates or modifies coordinates (`x`, `y`, `width`, `height`).
- Emits raw RDLC XML or arbitrary VB.NET source files.
- Modifies project files directly or executes shell commands.

## Context Engineering & Token Efficiency
`buildAiContextSlices` filters out all deterministically resolved regions and transmits **only** regions marked `isAmbiguous: true`, along with at most 4 nearby text labels and selectively loaded skill rules.

## Provider Abstraction (`IAiProvider`)
- `GeminiAiProvider`: Uses `@google/genai` (`gemini-3.8-flash`) with strict `responseSchema` (`Type.OBJECT`) JSON output.
- `DeterministicFallbackAiProvider`: Deterministic rule-based fallback used when `ai.enabled: false` or `GEMINI_API_KEY` is absent.

## Retrieval Extensibility (`IContextRetriever`)
`SkillManager` implements `IContextRetriever` using deterministic task/keyword selection today, allowing a vector or hybrid RAG retriever to be plugged in later without modifying `ReportGenAgent` or generators.
