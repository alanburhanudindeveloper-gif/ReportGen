import {
  ExistingProjectPattern,
  ReportDefinition,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
} from '../core/types.ts';

function toVbType(dataType: string): string {
  switch (dataType) {
    case 'System.Decimal':
      return 'GetType(Decimal)';
    case 'System.Int32':
      return 'GetType(Integer)';
    case 'System.DateTime':
      return 'GetType(DateTime)';
    default:
      return 'GetType(String)';
  }
}

export class VbGenerator {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public generate(
    definition: ReportDefinition,
    existingPattern?: ExistingProjectPattern
  ): { fullVbClass: string; embeddedRdlcCode: string } {
    try {
      const ns = existingPattern?.vbNamespace ?? 'ReportGen.Generated';
      const className = existingPattern?.vbClassName ?? `${definition.reportName}Report`;

      const dtColumns = definition.fields
        .map((f) => `            dt.Columns.Add("${f.name}", ${toVbType(f.dataType)})`)
        .join('\n');

      const paramLines = definition.parameters
        .map((p) => `            params.Add("${p.name}", "${(p.defaultValue ?? '').replace(/"/g, '""')}")`)
        .join('\n');

      const calcFunctions = definition.calculations
        .map((c) =>
          c.vbImplementation
            .split('\n')
            .map((line) => `        ${line}`)
            .join('\n')
        )
        .join('\n\n');

      const formattingFunctions = `        Public Function FormatCurrencyValue(ByVal amount As Decimal, Optional ByVal symbol As String = "$") As String
            Return symbol & amount.ToString("#,##0.00")
        End Function

        Public Function FormatYesNoFlag(ByVal condition As Boolean) As String
            Return If(condition, "YES", "NO")
        End Function`;

      const fullVbClass = `Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace ${ns}
    ''' <summary>
    ''' Deterministically generated VB.NET report class for ${definition.reportName}.
    ''' Separates Data Access, Business Calculations, and Formatting Helpers.
    ''' </summary>
    Public Class ${className}

        ' --- 1. DATA ACCESS ---
        Public Function GetReportData() As DataTable
            Dim dt As New DataTable("${definition.dataSetName}")
${dtColumns}
            Return dt
        End Function

        Public Function GetReportParameters() As Dictionary(Of String, String)
            Dim params As New Dictionary(Of String, String)()
${paramLines}
            Return params
        End Function

        ' --- 2. BUSINESS CALCULATIONS ---
${calcFunctions}

        ' --- 3. FORMATTING HELPERS ---
${formattingFunctions}

    End Class
End Namespace
`;

      // Embedded RDLC <Code> block omits Namespace/Class wrapper per RDLC spec
      const embeddedRdlcCode = [
        ...definition.calculations.map((c) => c.vbImplementation),
        `Public Function FormatCurrencyValue(ByVal amount As Decimal, Optional ByVal symbol As String = "$") As String
    Return symbol & amount.ToString("#,##0.00")
End Function`,
        `Public Function FormatYesNoFlag(ByVal condition As Boolean) As String
    Return If(condition, "YES", "NO")
End Function`,
      ].join('\n\n');

      this.logger.info('VbGenerator', 'VB.NET report class and RDLC code generated', {
        className,
        calculations: definition.calculations.length,
      });

      return { fullVbClass, embeddedRdlcCode };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ReportGenError(ReportGenErrorCode.VB_GENERATION_FAILED, msg, err);
    }
  }
}
