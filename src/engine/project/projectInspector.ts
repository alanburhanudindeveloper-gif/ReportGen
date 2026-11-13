import { XMLParser } from 'fast-xml-parser';
import { ExistingProjectPattern, StructuredLogger } from '../core/types.ts';

function asArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

export class ProjectInspector {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public inspect(input: {
    rdlcXml?: string;
    rdlcFileName?: string;
    vbSource?: string;
    vbFileName?: string;
  }): ExistingProjectPattern {
    const sourceFiles: string[] = [];
    let dataSourceName = 'dsReportSource';
    let dataSetName = 'dsReportData';
    const fields = new Set<string>();
    const parameters = new Set<string>();
    const expressions = new Set<string>();
    const conventions: string[] = [];
    let vbClassName: string | undefined;
    let vbNamespace: string | undefined;
    const vbFunctions: Array<{ name: string; signature: string; bodyPreview: string }> = [];

    if (input.rdlcXml) {
      sourceFiles.push(input.rdlcFileName ?? 'ExistingReport.rdlc');
      try {
        const parser = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          removeNSPrefix: true,
        });
        const parsed = parser.parse(input.rdlcXml);
        const report = parsed?.Report ?? {};

        const dataSources = asArray(report?.DataSources?.DataSource);
        if (dataSources[0]?.['@_Name']) {
          dataSourceName = String(dataSources[0]['@_Name']);
        }

        const dataSets = asArray(report?.DataSets?.DataSet);
        if (dataSets[0]?.['@_Name']) {
          dataSetName = String(dataSets[0]['@_Name']);
        }
        for (const ds of dataSets) {
          for (const f of asArray(ds?.Fields?.Field)) {
            if (f?.['@_Name']) fields.add(String(f['@_Name']));
          }
        }

        const params = asArray(report?.ReportParameters?.ReportParameter);
        for (const p of params) {
          if (p?.['@_Name']) parameters.add(String(p['@_Name']));
        }

        // Scan serialized XML for RDLC expressions (=Fields!..., =Code...., =Parameters!...)
        const exprMatches = input.rdlcXml.match(/=[^<\n"]{2,120}/g) ?? [];
        for (const expr of exprMatches.slice(0, 30)) {
          expressions.add(expr.trim());
        }

        const unitType = report?.ReportUnitType ?? 'Inch';
        conventions.push(`RDLC unit type: ${unitType}`);
      } catch (err) {
        this.logger.warn('ProjectInspector', 'Could not fully parse existing RDLC XML', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (input.vbSource) {
      sourceFiles.push(input.vbFileName ?? 'ExistingReport.vb');
      const nsMatch = input.vbSource.match(/Namespace\s+([A-Za-z0-9_.]+)/i);
      if (nsMatch) vbNamespace = nsMatch[1];

      const clsMatch = input.vbSource.match(/(?:Public\s+)?Class\s+([A-Za-z0-9_]+)/i);
      if (clsMatch) vbClassName = clsMatch[1];

      const fnRegex = /(Public|Private|Friend)\s+(?:Shared\s+)?(Function|Sub)\s+([A-Za-z0-9_]+\s*\([^)]*\)(?:\s+As\s+[A-Za-z0-9_()]+)?)/gi;
      let match: RegExpExecArray | null;
      while ((match = fnRegex.exec(input.vbSource)) !== null) {
        const sig = `${match[1]} ${match[2]} ${match[3]}`.trim();
        const nameOnly = match[3].split('(')[0].trim();
        const startIdx = match.index;
        const endMarker = match[2].toLowerCase() === 'function' ? 'End Function' : 'End Sub';
        const endIdx = input.vbSource.indexOf(endMarker, startIdx);
        const body =
          endIdx > startIdx
            ? input.vbSource.slice(startIdx, Math.min(endIdx + endMarker.length, startIdx + 360))
            : sig;
        vbFunctions.push({
          name: nameOnly,
          signature: sig,
          bodyPreview: body.trim(),
        });
      }
      if (vbNamespace) conventions.push(`VB Namespace: ${vbNamespace}`);
      if (vbClassName) conventions.push(`VB Class: ${vbClassName}`);
    }

    this.logger.info('ProjectInspector', 'Existing report inspection completed', {
      sourceFiles,
      dataSetName,
      fieldsCount: fields.size,
      vbFunctionsCount: vbFunctions.length,
    });

    return {
      sourceFiles,
      dataSourceName,
      dataSetName,
      fields: Array.from(fields),
      parameters: Array.from(parameters),
      vbClassName,
      vbNamespace,
      vbFunctions,
      expressions: Array.from(expressions),
      conventions,
    };
  }
}
