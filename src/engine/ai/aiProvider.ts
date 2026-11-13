import { GoogleGenAI, Type } from '@google/genai';
import {
  AiAmbiguousRegionSlice,
  AiDecisionItem,
  AiDecisionResponse,
  BandKind,
  ExistingProjectPattern,
  IntermediateLayoutModel,
  ReportGenError,
  ReportGenErrorCode,
  SemanticRole,
  StructuredLogger,
} from '../core/types.ts';
import { SkillDocument, SkillManager } from '../skills/skillManager.ts';

export interface AiReasoningContext {
  documentName: string;
  ambiguousRegions: AiAmbiguousRegionSlice[];
  totalRegionCount: number;
  skills: SkillDocument[];
  existingPatternSummary?: {
    dataSetName: string;
    fields: string[];
    vbFunctionNames: string[];
  };
}

export interface IAiProvider {
  readonly name: string;
  readonly model: string;
  decideSemantics(context: AiReasoningContext): Promise<AiDecisionResponse>;
}

const VALID_ROLES: SemanticRole[] = [
  'reportTitle',
  'sectionHeading',
  'fieldLabel',
  'fieldValue',
  'tableHeader',
  'tableCell',
  'cardContainer',
  'timelineStep',
  'numberedListItem',
  'paragraph',
  'headerText',
  'footerText',
  'logoOrGraphic',
  'calculationField',
  'unknown',
];

const VALID_BANDS: BandKind[] = [
  'Header',
  'Information',
  'Detail',
  'Cards',
  'Timeline',
  'Notes',
  'Footer',
];

export function buildAiContextSlices(
  layout: IntermediateLayoutModel,
  skillManager: SkillManager,
  existingPattern?: ExistingProjectPattern
): AiReasoningContext {
  const allRegions = layout.pages.flatMap((p) => p.regions);
  const ambiguous = allRegions.filter((r) => r.isAmbiguous);

  const slices: AiAmbiguousRegionSlice[] = ambiguous.slice(0, 40).map((r) => {
    const page = layout.pages.find((p) => p.pageNumber === r.pageNumber);
    const nearbyLabels = (page?.regions ?? [])
      .filter(
        (other) =>
          other.id !== r.id &&
          other.type === 'text' &&
          other.text &&
          Math.abs(other.y - r.y) < 0.35 &&
          Math.abs(other.x - r.x) < 3.0
      )
      .slice(0, 4)
      .map((other) => other.text ?? '');

    return {
      regionId: r.id,
      pageNumber: r.pageNumber,
      text: r.text ?? `[${r.type}]`,
      bandHint: r.bandKind,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      fontSizePt: r.style.fontSizePt,
      bold: r.style.bold,
      hasBoxBorder: Boolean(r.style.borderColor),
      ambiguityReason: r.ambiguityReason ?? 'Ambiguous semantic role',
      nearbyLabels,
    };
  });

  const hasFinancialTerms = allRegions.some((r) =>
    /total|subtotal|tax|discount|price|qty|amount|invoice|net|gross/i.test(r.text ?? '')
  );
  const hasComplexGraphics = allRegions.some((r) => r.type === 'vector_complex' || r.type === 'image');

  const skills = skillManager.retrieveRelevantSkills({
    taskType: 'layout-disambiguation',
    hasFinancialTerms,
    hasExistingProject: Boolean(existingPattern && existingPattern.sourceFiles.length > 0),
    hasComplexGraphics,
    keywords: slices.map((s) => s.text).slice(0, 10),
  });

  return {
    documentName: layout.document.name,
    ambiguousRegions: slices,
    totalRegionCount: allRegions.length,
    skills,
    existingPatternSummary: existingPattern
      ? {
          dataSetName: existingPattern.dataSetName,
          fields: existingPattern.fields,
          vbFunctionNames: existingPattern.vbFunctions.map((f) => f.name),
        }
      : undefined,
  };
}

export class GeminiAiProvider implements IAiProvider {
  public readonly name = 'gemini';
  public readonly model: string;
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger, model = 'gemini-3.8-flash') {
    this.logger = logger;
    this.model = model;
  }

  public async decideSemantics(context: AiReasoningContext): Promise<AiDecisionResponse> {
    if (context.ambiguousRegions.length === 0) {
      return {
        provider: this.name,
        model: this.model,
        usedSkills: context.skills.map((s) => s.name),
        tokenEstimate: {
          sentRegions: 0,
          totalRegions: context.totalRegionCount,
          reductionPercent: 100,
        },
        decisions: [],
      };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.warn('AI', 'GEMINI_API_KEY not configured; falling back to deterministic semantic resolver');
      return new DeterministicFallbackAiProvider(this.logger).decideSemantics(context);
    }

    this.logger.info('AI', 'AI reasoning requested', {
      ambiguousCount: context.ambiguousRegions.length,
      totalRegions: context.totalRegionCount,
      skills: context.skills.map((s) => s.name),
    });

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const skillDigest = context.skills
      .map((s) => `Skill[${s.name}]: Rules: ${s.rules.slice(0, 4).join(' | ')}`)
      .join('\n');

    const promptPayload = {
      documentName: context.documentName,
      existingPattern: context.existingPatternSummary ?? null,
      ambiguousRegions: context.ambiguousRegions,
    };

    try {
      const response = await ai.models.generateContent({
        model: this.model,
        contents: `Classify each ambiguous PDF layout region into a structured semantic decision.\n\n${skillDigest}\n\nInput:\n${JSON.stringify(
          promptPayload
        )}`,
        config: {
          systemInstruction:
            'You are a structured PDF-to-RDLC semantic classifier. Return ONLY valid JSON decisions. Do not invent coordinates, dimensions, or RDLC XML. Use only the regionIds provided.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              decisions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    regionId: { type: Type.STRING },
                    semanticRole: { type: Type.STRING },
                    linkedField: { type: Type.STRING },
                    bandOverride: { type: Type.STRING },
                    preferImageFallback: { type: Type.BOOLEAN },
                    calculationHint: { type: Type.STRING },
                    confidence: { type: Type.NUMBER },
                    rationale: { type: Type.STRING },
                  },
                  required: ['regionId', 'semanticRole', 'confidence', 'rationale'],
                },
              },
            },
            required: ['decisions'],
          },
        },
      });

      const rawText = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawText) as { decisions?: AiDecisionItem[] };
      const validIds = new Set(context.ambiguousRegions.map((r) => r.regionId));
      const decisions = (parsed.decisions ?? [])
        .filter((d) => validIds.has(d.regionId))
        .map((d) => ({
          ...d,
          semanticRole: VALID_ROLES.includes(d.semanticRole) ? d.semanticRole : 'unknown',
          bandOverride: d.bandOverride && VALID_BANDS.includes(d.bandOverride) ? d.bandOverride : undefined,
          confidence: Math.max(0, Math.min(1, Number(d.confidence) || 0.5)),
        }));

      const reductionPercent =
        context.totalRegionCount > 0
          ? Math.round((1 - context.ambiguousRegions.length / context.totalRegionCount) * 100)
          : 100;

      this.logger.info('AI', 'AI decision accepted', {
        decisionCount: decisions.length,
        tokenReductionPercent: reductionPercent,
      });

      return {
        provider: this.name,
        model: this.model,
        usedSkills: context.skills.map((s) => s.name),
        tokenEstimate: {
          sentRegions: context.ambiguousRegions.length,
          totalRegions: context.totalRegionCount,
          reductionPercent,
        },
        decisions,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn('AI', `Gemini call failed (${msg}); using deterministic fallback`);
      return new DeterministicFallbackAiProvider(this.logger).decideSemantics(context);
    }
  }
}

export class DeterministicFallbackAiProvider implements IAiProvider {
  public readonly name = 'deterministic-fallback';
  public readonly model = 'rule-engine-v1';
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public async decideSemantics(context: AiReasoningContext): Promise<AiDecisionResponse> {
    const decisions: AiDecisionItem[] = context.ambiguousRegions.map((slice) => {
      const t = slice.text.trim();
      let semanticRole: SemanticRole = 'fieldValue';
      let linkedField: string | undefined;
      let bandOverride: BandKind | undefined;
      let calculationHint: string | undefined;
      let confidence = 0.88;
      let rationale = 'Classified by deterministic fallback rules.';

      if (slice.text.startsWith('[vector_complex]')) {
        semanticRole = 'logoOrGraphic';
        confidence = 0.91;
        rationale = 'Complex vector cluster flagged for image fallback inside Tablix cell.';
      } else if (/^[\$\€\£]?\s*-?\d/.test(t) && slice.nearbyLabels.some((l) => /total|subtotal|tax|net|amount/i.test(l))) {
        semanticRole = 'calculationField';
        linkedField = t.replace(/[^A-Za-z0-9]/g, '') || 'CalculatedAmount';
        calculationHint = 'summary_total';
        confidence = 0.9;
        rationale = 'Numeric value aligned beside financial summary label.';
      } else if (slice.hasBoxBorder && slice.bold) {
        semanticRole = 'cardContainer';
        bandOverride = 'Cards';
        confidence = 0.89;
        rationale = 'Bold text enclosed inside bordered card box.';
      } else if (slice.bold && slice.y < 3.6 && slice.bandHint === 'Detail') {
        semanticRole = 'tableHeader';
        confidence = 0.9;
        rationale = 'Bold short phrase aligned at top of detail region.';
      } else if (slice.bold && slice.fontSizePt >= 11) {
        semanticRole = 'sectionHeading';
        confidence = 0.89;
        rationale = 'Bold larger font indicates section heading.';
      } else if (/^(step|phase|stage|q[1-4]|20\d{2})\b/i.test(t)) {
        semanticRole = 'timelineStep';
        bandOverride = 'Timeline';
        confidence = 0.87;
        rationale = 'Sequential milestone marker detected.';
      } else if (context.existingPatternSummary) {
        const matched = context.existingPatternSummary.fields.find((f) =>
          t.toLowerCase().includes(f.toLowerCase())
        );
        if (matched) {
          linkedField = matched;
          semanticRole = 'fieldValue';
          confidence = 0.92;
          rationale = `Matched existing RDLC field "${matched}".`;
        }
      }

      const resolvedRole = semanticRole as string;
      if (!linkedField && (resolvedRole === 'fieldValue' || resolvedRole === 'tableCell')) {
        const sanitized = t.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').slice(0, 2).join('');
        if (sanitized && !/^\d+$/.test(sanitized)) {
          linkedField = sanitized;
        }
      }

      return {
        regionId: slice.regionId,
        semanticRole,
        linkedField,
        bandOverride,
        preferImageFallback: slice.text.startsWith('[vector_complex]'),
        calculationHint,
        confidence,
        rationale,
      };
    });

    const reductionPercent =
      context.totalRegionCount > 0
        ? Math.round((1 - context.ambiguousRegions.length / context.totalRegionCount) * 100)
        : 100;

    this.logger.info('AI', 'Deterministic semantic fallback completed', {
      decisionCount: decisions.length,
    });

    return {
      provider: this.name,
      model: this.model,
      usedSkills: context.skills.map((s) => s.name),
      tokenEstimate: {
        sentRegions: context.ambiguousRegions.length,
        totalRegions: context.totalRegionCount,
        reductionPercent,
      },
      decisions,
    };
  }
}

export function validateAiDecisions(
  layout: IntermediateLayoutModel,
  response: AiDecisionResponse
): void {
  const validRegionIds = new Set(layout.pages.flatMap((p) => p.regions.map((r) => r.id)));
  for (const d of response.decisions) {
    if (!validRegionIds.has(d.regionId)) {
      throw new ReportGenError(
        ReportGenErrorCode.AI_DECISION_INVALID,
        `AI returned unknown regionId "${d.regionId}"`
      );
    }
    if (!VALID_ROLES.includes(d.semanticRole)) {
      throw new ReportGenError(
        ReportGenErrorCode.AI_DECISION_INVALID,
        `AI returned invalid semanticRole "${d.semanticRole}"`
      );
    }
  }
}
