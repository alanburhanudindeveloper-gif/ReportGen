import { LayoutRegion, StructuredLogger } from '../core/types.ts';
import {
  BenchmarkAnalysis,
  ExtractedFieldValue,
  IDummyDataExtractor,
  ReferenceDataExtract,
  TemplateAnalysis,
} from './types.ts';

function toPascalIdentifier(raw: string): string {
  const words = raw
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'ExtractedField';
  const joined = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^\d/.test(joined) ? `Field${joined}` : joined;
}

function inferValueMetadata(val: string, label: string): {
  inferredType: ExtractedFieldValue['inferredType'];
  isStatusField: boolean;
  candidateStates?: string[];
  parsedValue: string | number;
} {
  const cleaned = val.trim();
  const statusMatch = /^(Active|Pending|Waived|Included|Excluded|Not Covered|Approved|Declined|Yes|No|Optional|Standard)$/i.exec(
    cleaned
  );
  if (statusMatch || /\b(status|rider|waiver|eligibility|state|option)\b/i.test(label)) {
    const baseStates = statusMatch
      ? Array.from(new Set([cleaned, 'Included', 'Excluded', 'Waived']))
      : ['Included', 'Not Covered', 'Optional'];
    return {
      inferredType: 'Status',
      isStatusField: true,
      candidateStates: baseStates,
      parsedValue: cleaned,
    };
  }

  if (/^[\$\€\£]?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?$/.test(cleaned) || /^-?\d+(?:\.\d+)?$/.test(cleaned)) {
    const num = Number(cleaned.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(num)) {
      return {
        inferredType: 'Decimal',
        isStatusField: false,
        parsedValue: num,
      };
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cleaned)) {
    return {
      inferredType: 'Date',
      isStatusField: false,
      parsedValue: cleaned,
    };
  }

  return {
    inferredType: 'String',
    isStatusField: false,
    parsedValue: cleaned,
  };
}

export class DummyDataExtractor implements IDummyDataExtractor {
  private readonly logger: StructuredLogger;
  private readonly confidenceThreshold: number;

  constructor(logger: StructuredLogger, confidenceThreshold = 0.85) {
    this.logger = logger;
    this.confidenceThreshold = confidenceThreshold;
  }

  public extract(
    pdfB: TemplateAnalysis,
    benchmark: BenchmarkAnalysis
  ): ReferenceDataExtract {
    const extracted: ExtractedFieldValue[] = [];
    const seenFields = new Set<string>();
    const benchmarkFieldNames = new Set(benchmark.fields.map((f) => f.name.toLowerCase()));

    for (const page of pdfB.layoutModel.pages) {
      const textRegions = page.regions
        .filter((r) => r.type === 'text' && r.text && r.text.trim().length > 0)
        .sort((a, b) => (Math.abs(a.y - b.y) < 0.05 ? a.x - b.x : a.y - b.y));

      for (let i = 0; i < textRegions.length; i++) {
        const reg = textRegions[i];
        const raw = reg.text!.trim();

        const colonIdx = raw.indexOf(':');
        if (colonIdx > 1 && colonIdx < raw.length - 1) {
          const label = raw.slice(0, colonIdx).trim();
          const val = raw.slice(colonIdx + 1).trim();
          this.pushCandidate(
            extracted,
            seenFields,
            benchmarkFieldNames,
            pdfB.fileName,
            reg,
            label,
            val,
            raw,
            0.93,
            'label_colon_inline'
          );
          continue;
        }

        if (raw.endsWith(':')) {
          const label = raw.slice(0, -1).trim();
          const neighbor = textRegions.find(
            (other) =>
              other.id !== reg.id &&
              other.x > reg.x + 0.08 &&
              Math.abs(other.y - reg.y) <= 0.08 &&
              other.x - (reg.x + reg.width) < 3.2
          );
          if (neighbor?.text) {
            this.pushCandidate(
              extracted,
              seenFields,
              benchmarkFieldNames,
              pdfB.fileName,
              neighbor,
              label,
              neighbor.text.trim(),
              `${raw} ${neighbor.text.trim()}`,
              0.91,
              'label_adjacent'
            );
          }
          continue;
        }

        if (
          /^(Active|Pending|Waived|Included|Excluded|Not Covered|Approved|Declined|Yes|No|[\$\€\£]?\s*\d)/i.test(
            raw
          )
        ) {
          const leftLabel = textRegions.find(
            (other) =>
              other.id !== reg.id &&
              other.x < reg.x &&
              Math.abs(other.y - reg.y) <= 0.08 &&
              reg.x - (other.x + other.width) < 3.5 &&
              !/^[\$\d]/.test(other.text ?? '')
          );
          if (leftLabel?.text) {
            const labelText = leftLabel.text.replace(/:$/, '').trim();
            const isShortNumeric = /^\d+$/.test(raw);
            this.pushCandidate(
              extracted,
              seenFields,
              benchmarkFieldNames,
              pdfB.fileName,
              reg,
              labelText,
              raw,
              `${labelText} -> ${raw}`,
              isShortNumeric ? 0.78 : 0.87,
              'table_cell'
            );
          }
        }
      }
    }

    const row: Record<string, string | number> = {};
    for (const item of extracted) {
      row[item.field] = item.value;
    }

    this.logger.info('DummyDataExtractor', `Extracted ${extracted.length} reference field(s) from PDF B`, {
      sourcePdf: pdfB.fileName,
      confirmed: extracted.filter((f) => f.status === 'CONFIRMED').length,
      uncertain: extracted.filter((f) => f.status === 'UNCERTAIN').length,
    });

    return {
      sourcePdfFile: pdfB.fileName,
      extractedAt: new Date().toISOString(),
      fields: extracted,
      datasetRows: [row],
    };
  }

  private pushCandidate(
    out: ExtractedFieldValue[],
    seenFields: Set<string>,
    benchmarkFieldNames: Set<string>,
    fileName: string,
    region: LayoutRegion,
    label: string,
    rawValue: string,
    labelContext: string,
    baseConfidence: number,
    extractionMethod: ExtractedFieldValue['extractionMethod']
  ): void {
    const fieldName = toPascalIdentifier(label);
    if (!fieldName || seenFields.has(fieldName.toLowerCase())) return;
    seenFields.add(fieldName.toLowerCase());

    const meta = inferValueMetadata(rawValue, label);
    const boost = benchmarkFieldNames.has(fieldName.toLowerCase()) ? 0.05 : 0;
    const confidence = Math.round(Math.min(0.99, baseConfidence + boost) * 100) / 100;
    const provenance = confidence >= this.confidenceThreshold ? 'extracted' : 'inferred';

    out.push({
      id: `ext-${out.length + 1}`,
      field: fieldName,
      label,
      value: meta.parsedValue,
      inferredType: meta.inferredType,
      isStatusField: meta.isStatusField,
      candidateStates: meta.candidateStates,
      provenance,
      extractionMethod,
      traceability: {
        pdfFile: fileName,
        page: region.pageNumber,
        bbox: {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        },
        labelContext,
      },
      confidence,
      status: confidence >= this.confidenceThreshold ? 'CONFIRMED' : 'UNCERTAIN',
    });
  }
}

export function applyManualFieldConfirmations(
  extract: ReferenceDataExtract,
  overrides: Array<{ id?: string; field: string; value?: string | number; status?: 'CONFIRMED' | 'UNCERTAIN' }>
): ReferenceDataExtract {
  if (!overrides.length) return extract;
  const byField = new Map(overrides.map((o) => [o.field.toLowerCase(), o]));
  const updatedFields = extract.fields.map((f) => {
    const hit = byField.get(f.field.toLowerCase()) ?? overrides.find((o) => o.id && o.id === f.id);
    if (!hit) return f;
    return {
      ...f,
      value: hit.value !== undefined ? hit.value : f.value,
      provenance: hit.value !== undefined ? ('manually_supplied' as const) : f.provenance,
      extractionMethod: hit.value !== undefined ? ('manual' as const) : f.extractionMethod,
      status: hit.status ?? 'CONFIRMED',
      confidence: hit.status === 'CONFIRMED' || hit.status === undefined ? Math.max(0.95, f.confidence) : f.confidence,
    };
  });

  const row: Record<string, string | number> = {};
  for (const f of updatedFields) {
    row[f.field] = f.value;
  }

  return {
    ...extract,
    fields: updatedFields,
    datasetRows: [row],
  };
}
