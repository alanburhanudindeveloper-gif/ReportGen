import { ReportParameterDef, VisualTextRun } from '../core/types.ts';

export interface ParameterDetectionContext {
  parameters: Map<string, ReportParameterDef>;
  usedValues: Map<string, string>;
  counter: {
    date: number;
    currency: number;
    percent: number;
    refId: number;
    text: number;
  };
}

export function createParameterDetectionContext(
  existingParams: Iterable<ReportParameterDef> = []
): ParameterDetectionContext {
  const parameters = new Map<string, ReportParameterDef>();
  const usedValues = new Map<string, string>();
  for (const p of existingParams) {
    parameters.set(p.name, { ...p });
    if (p.defaultValue) {
      usedValues.set(`${p.dataType}::${p.defaultValue}`, p.name);
    }
  }
  return {
    parameters,
    usedValues,
    counter: { date: 0, currency: 0, percent: 0, refId: 0, text: 0 },
  };
}

function sanitizeParamName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  if (!cleaned) return fallback;
  const safe = /^[0-9]/.test(cleaned) ? `P_${cleaned}` : cleaned;
  return safe.slice(0, 36);
}

const MAX_AUTO_PARAMETERS = 24;

interface TokenMatch {
  start: number;
  end: number;
  value: string;
  kind: 'date' | 'currency' | 'percent' | 'refId' | 'labelValue';
  dataType: ReportParameterDef['dataType'];
  preferredName?: string;
  prompt?: string;
}

const DATE_RE =
  /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+(?:Jan(?:uari|uary)?|Feb(?:ruari|ruary)?|Mar(?:et|ch)?|Apr(?:il)?|Mei|May|Jun(?:i|e)?|Jul(?:i|y)?|Agu(?:stus)?|Aug(?:ust)?|Sep(?:tember)?|Okt(?:ober)?|Oct(?:ober)?|Nov(?:ember)?|Des(?:ember)?|Dec(?:ember)?)\s+\d{4}|Q[1-4]\s+20\d{2})\b/gi;
const CURRENCY_RE =
  /(?:Rp\.?|IDR|USD|\$|€|£)\s*-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\b/g;
const PERCENT_RE = /\b\d{1,3}(?:[.,]\d{1,2})?%/g;
const REF_ID_RE = /\b(?:INV|POL|RIPLAY|REF|DOC|NO)[-/][A-Z0-9][A-Z0-9-]{2,}\b/g;

function findTokensInText(
  text: string,
  precedingLabel?: string,
  isShortLine = true
): TokenMatch[] {
  const matches: TokenMatch[] = [];

  // 1. Standalone "Label: Value" inside a single line (e.g., "REF: INV-2026-0041")
  const kvMatch = text.match(/^([A-Za-z][A-Za-z0-9\s/.-]{1,26}):\s+(.{2,48})$/);
  if (kvMatch) {
    const label = kvMatch[1].trim();
    const val = kvMatch[2].trim();
    const start = text.indexOf(val, kvMatch[1].length);
    if (start >= 0 && val.length <= 45) {
      matches.push({
        start,
        end: start + val.length,
        value: val,
        kind: 'labelValue',
        dataType: 'String',
        preferredName: sanitizeParamName(label, 'FieldParam'),
        prompt: label,
      });
      return matches;
    }
  }

  // 2. If preceded by a short label on the same baseline (e.g. "Customer:" -> "PT Nusantara Logistics")
  if (precedingLabel && isShortLine && text.trim().length >= 2 && text.trim().length <= 48) {
    const cleanLabel = precedingLabel.replace(/[:\s]+$/, '').trim();
    if (cleanLabel.length >= 2 && cleanLabel.length <= 30) {
      const val = text.trim();
      const start = text.indexOf(val);
      matches.push({
        start,
        end: start + val.length,
        value: val,
        kind: 'labelValue',
        dataType: 'String',
        preferredName: sanitizeParamName(cleanLabel, 'MetadataValue'),
        prompt: cleanLabel,
      });
      return matches;
    }
  }

  const collectRegex = (
    re: RegExp,
    kind: TokenMatch['kind'],
    dataType: ReportParameterDef['dataType']
  ) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const val = m[0];
      const s = m.index;
      const e = s + val.length;
      const overlaps = matches.some((ex) => !(e <= ex.start || s >= ex.end));
      if (!overlaps) {
        matches.push({ start: s, end: e, value: val, kind, dataType });
      }
    }
  };

  collectRegex(REF_ID_RE, 'refId', 'String');
  collectRegex(DATE_RE, 'date', 'String');
  collectRegex(CURRENCY_RE, 'currency', 'String');
  // Avoid noisy percent tokenization inside long legal prose sentences
  if (isShortLine || text.length <= 80) {
    collectRegex(PERCENT_RE, 'percent', 'String');
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

function registerOrReuseParam(
  ctx: ParameterDetectionContext,
  token: TokenMatch,
  pageNumber: number
): string | undefined {
  const dedupKey = `${token.dataType}::${token.value}`;
  const existingName = ctx.usedValues.get(dedupKey);
  if (existingName) return existingName;

  if (ctx.parameters.size >= MAX_AUTO_PARAMETERS) {
    return undefined;
  }

  let candidate = token.preferredName;
  if (!candidate) {
    if (token.kind === 'date') {
      ctx.counter.date++;
      candidate = `ReportDate_${ctx.counter.date}`;
    } else if (token.kind === 'currency') {
      ctx.counter.currency++;
      candidate = `NominalValue_${ctx.counter.currency}`;
    } else if (token.kind === 'percent') {
      ctx.counter.percent++;
      candidate = `RatePercent_${ctx.counter.percent}`;
    } else if (token.kind === 'refId') {
      ctx.counter.refId++;
      candidate = `DocumentRef_${ctx.counter.refId}`;
    } else {
      ctx.counter.text++;
      candidate = `FieldValue_${ctx.counter.text}`;
    }
  }

  let unique = candidate;
  let suffix = 2;
  while (ctx.parameters.has(unique)) {
    const existing = ctx.parameters.get(unique)!;
    if (existing.defaultValue === token.value) {
      ctx.usedValues.set(dedupKey, unique);
      return unique;
    }
    unique = `${candidate}_${suffix++}`;
  }

  ctx.parameters.set(unique, {
    name: unique,
    dataType: token.dataType,
    prompt: token.prompt ?? unique.replace(/_/g, ' '),
    defaultValue: token.value,
    matchedPattern: token.kind,
    pageNumber,
  });
  ctx.usedValues.set(dedupKey, unique);
  return unique;
}

export function parameterizeTextRuns(
  ctx: ParameterDetectionContext,
  runs: VisualTextRun[],
  pageNumber: number,
  precedingLabel?: string
): VisualTextRun[] {
  const fullLen = runs.reduce((s, r) => s + r.text.length, 0);
  const isShortLine = fullLen <= 55;
  const output: VisualTextRun[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.parameterName || !run.text || run.text.trim().length === 0) {
      output.push(run);
      continue;
    }

    const labelCtx = i === 0 ? precedingLabel : undefined;
    const tokens = findTokensInText(run.text, labelCtx, isShortLine);
    if (tokens.length === 0) {
      output.push(run);
      continue;
    }

    let cursor = 0;
    for (const tok of tokens) {
      const paramName = registerOrReuseParam(ctx, tok, pageNumber);
      if (!paramName) continue;
      if (tok.start > cursor) {
        output.push({
          ...run,
          text: run.text.slice(cursor, tok.start),
        });
      }
      output.push({
        ...run,
        text: tok.value,
        parameterName: paramName,
      });
      cursor = tok.end;
    }

    if (cursor < run.text.length) {
      output.push({
        ...run,
        text: run.text.slice(cursor),
      });
    }
  }

  return output.length > 0 ? output : runs;
}
