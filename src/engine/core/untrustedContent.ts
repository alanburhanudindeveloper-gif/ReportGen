export type UntrustedSourceKind =
  | 'pdf'
  | 'rdlc'
  | 'vbnet'
  | 'excel'
  | 'project_file'
  | 'mixed_project';

export interface UntrustedDataEnvelope<T> {
  _trustBoundary: 'UNTRUSTED_DOCUMENT_DATA';
  treatAsInstructions: false;
  sourceKind: UntrustedSourceKind;
  sourceName: string;
  suspiciousInstructionPatternsDetected: string[];
  data: T;
}

const INJECTION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: 'override_instructions',
    regex: /\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|rules?|prompts?)/i,
  },
  {
    label: 'exfiltration_directive',
    regex: /\b(upload|exfiltrate|send|post)\s+(the\s+)?(entire\s+)?(source\s*code|repo|repository|credentials?|tokens?|secrets?|env)\b/i,
  },
  {
    label: 'bypass_approval',
    regex: /\b(bypass|skip|disable)\s+(approval|validation|security|safety|contract)\b/i,
  },
  {
    label: 'credential_access',
    regex: /\b(read|extract|dump|steal)\s+(copilot|github|vscode|oauth|api)\s*(tokens?|keys?|credentials?|cookies?)\b/i,
  },
];

export function detectPromptInjectionIndicators(input: unknown): string[] {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  if (!text) return [];
  const matches: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.regex.test(text)) {
      matches.push(p.label);
    }
  }
  return matches;
}

export function wrapUntrustedData<T>(
  sourceKind: UntrustedSourceKind,
  sourceName: string,
  data: T
): UntrustedDataEnvelope<T> {
  const suspicious = detectPromptInjectionIndicators(data);
  return {
    _trustBoundary: 'UNTRUSTED_DOCUMENT_DATA',
    treatAsInstructions: false,
    sourceKind,
    sourceName,
    suspiciousInstructionPatternsDetected: suspicious,
    data,
  };
}
