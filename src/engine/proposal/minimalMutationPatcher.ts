import { StructuredLogger } from '../core/types.ts';
import {
  BenchmarkAnalysis,
  MinimalMutationDiffItem,
  MinimalMutationReport,
  ProposalDefinition,
  VbAstFile,
} from './types.ts';
import { VbAstAnalyzer } from './vbAstAnalyzer.ts';

function escapeVbString(val: string): string {
  return val.replace(/"/g, '""');
}

function escapeRegExp(val: string): string {
  return val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MinimalMutationPatcher {
  private readonly logger: StructuredLogger;
  private readonly astAnalyzer = new VbAstAnalyzer();

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public patchVbArtifacts(
    definition: ProposalDefinition,
    benchmark: BenchmarkAnalysis
  ): {
    builderVbCode: string;
    elementVbCode: string;
    diffItems: MinimalMutationDiffItem[];
    report: MinimalMutationReport;
  } {
    const prod = definition.productCode;
    const bench = benchmark.productCode;
    const diffItems: MinimalMutationDiffItem[] = [];

    const builderAst =
      benchmark.builderAst ??
      (benchmark.rawBuilderSource
        ? this.astAnalyzer.parseFile(`${bench}ProposalBuilder.vb`, benchmark.rawBuilderSource)
        : undefined);

    const elementAst =
      benchmark.elementAsts?.[0] ??
      (benchmark.rawElementSource
        ? this.astAnalyzer.parseFile(`${bench}ProposalElement.vb`, benchmark.rawElementSource)
        : undefined);

    // 1. Symbol-aware patching of Builder.vb preserving all unrelated methods
    const builderOut = this.patchSingleVbFile(
      benchmark.rawBuilderSource ?? '',
      builderAst,
      `${prod}ProposalBuilder.vb`,
      definition,
      benchmark,
      true
    );
    diffItems.push(...builderOut.diffItems);

    // 2. Symbol-aware patching of Element.vb preserving all unrelated helpers
    const elementOut = this.patchSingleVbFile(
      benchmark.rawElementSource ?? '',
      elementAst,
      `${prod}ProposalElement.vb`,
      definition,
      benchmark,
      false
    );
    diffItems.push(...elementOut.diffItems);

    // Also record preserved classes/methods from additional discovered Element ASTs (e.g. MFABenefitElement.vb)
    for (const extraAst of benchmark.elementAsts?.slice(1) ?? []) {
      for (const t of extraAst.types) {
        const renamedClass = t.name.startsWith(bench) ? `${prod}${t.name.slice(bench.length)}` : t.name;
        diffItems.push({
          fileName: extraAst.fileName,
          symbolName: renamedClass,
          symbolKind: 'Class',
          status: renamedClass !== t.name ? 'RENAMED' : 'UNCHANGED',
          reason: 'Preserved companion Element class structure.',
        });
        for (const m of t.methods) {
          diffItems.push({
            fileName: extraAst.fileName,
            symbolName: m.name,
            symbolKind: 'Method',
            status: 'UNCHANGED',
            reason: 'Preserved companion Element helper method verbatim.',
          });
        }
      }
    }

    const report = this.buildDiffReport(diffItems);

    this.logger.info(
      'MinimalMutationPatcher',
      `Patched VB.NET artifacts (${report.preservationPercent}% preserved)`,
      {
        unchanged: report.unchangedCount,
        renamed: report.renamedCount,
        modified: report.modifiedCount,
        added: report.addedCount,
        removed: report.removedCount,
        requiresReview: report.requiresReviewCount,
      }
    );

    return {
      builderVbCode: builderOut.source,
      elementVbCode: elementOut.source,
      diffItems,
      report,
    };
  }

  private patchSingleVbFile(
    rawSource: string,
    ast: VbAstFile | undefined,
    targetFileName: string,
    definition: ProposalDefinition,
    benchmark: BenchmarkAnalysis,
    isBuilder: boolean
  ): { source: string; diffItems: MinimalMutationDiffItem[] } {
    const prod = definition.productCode;
    const bench = benchmark.productCode;
    const diffItems: MinimalMutationDiffItem[] = [];

    if (!rawSource.trim()) {
      const fresh = isBuilder
        ? this.buildFallbackBuilder(definition, benchmark)
        : this.buildFallbackElement(definition, benchmark);
      diffItems.push({
        fileName: targetFileName,
        symbolName: isBuilder ? `${prod}ProposalBuilder` : `${prod}ProposalElement`,
        symbolKind: 'Class',
        status: 'ADDED',
        reason: 'Benchmark lacked source file; synthesized benchmark-aligned VB.NET shell.',
      });
      return { source: fresh, diffItems };
    }

    // Rename only explicit benchmark identifiers (Class, Element, DataSource, DataSet, RDLC names)
    const renamePairs: Array<[RegExp, string, string]> = [
      [new RegExp(`\\b${escapeRegExp(bench)}ProposalBuilder\\b`, 'g'), `${prod}ProposalBuilder`, 'Class'],
      [new RegExp(`\\b${escapeRegExp(bench)}ProposalElement\\b`, 'g'), `${prod}ProposalElement`, 'Class'],
      [new RegExp(`\\b${escapeRegExp(bench)}BenefitElement\\b`, 'g'), `${prod}BenefitElement`, 'Class'],
      [new RegExp(`\\b${escapeRegExp(bench)}DataSource\\b`, 'g'), definition.dataSourceName, 'DataSource'],
      [new RegExp(`\\b${escapeRegExp(bench)}ProposalDataSet\\b`, 'g'), definition.dataSetName, 'DataSet'],
      [new RegExp(`"${escapeRegExp(bench)}ProposalLayout\\.rdlc"`, 'gi'), `"${prod}ProposalLayout.rdlc"`, 'RDLC'],
      [new RegExp(`"${escapeRegExp(bench)}Benefit\\.rdlc"`, 'gi'), `"${prod}Benefit.rdlc"`, 'RDLC'],
      [new RegExp(`"${escapeRegExp(bench)}-[A-Za-z0-9_-]+"`, 'gi'), `"${escapeVbString(definition.planCode)}"`, 'PlanCode'],
      [new RegExp(`"${escapeRegExp(bench)}"`, 'g'), `"${escapeVbString(prod)}"`, 'ProductCode'],
    ];

    let patched = rawSource;
    for (const [rx, rep] of renamePairs) {
      patched = patched.replace(rx, rep);
    }

    // Audit every parsed method from VB.NET AST for minimal-mutation tracking
    const allMethods = ast?.types.flatMap((t) => t.methods) ?? [];
    for (const t of ast?.types ?? []) {
      const renamedClass = t.name.startsWith(bench) ? `${prod}${t.name.slice(bench.length)}` : t.name;
      diffItems.push({
        fileName: targetFileName,
        symbolName: renamedClass,
        symbolKind: 'Class',
        status: renamedClass !== t.name ? 'RENAMED' : 'UNCHANGED',
        reason:
          renamedClass !== t.name
            ? `Renamed benchmark class ${t.name} -> ${renamedClass} preserving structure.`
            : `Preserved benchmark type ${t.name}.`,
      });
    }

    for (const m of allMethods) {
      const chg = definition.changes.find(
        (c) => c.benchmarkElement?.toLowerCase() === m.name.toLowerCase()
      );
      if (!chg) {
        // Untouched helper or business calculation method
        const hasPlanOrProdRef =
          new RegExp(`"${escapeRegExp(bench)}`, 'i').test(m.bodyText) ||
          m.rdlcReferences.length > 0;
        diffItems.push({
          fileName: targetFileName,
          symbolName: m.name,
          symbolKind: 'Method',
          status: hasPlanOrProdRef ? 'RENAMED' : 'UNCHANGED',
          reason: hasPlanOrProdRef
            ? 'Preserved production logic; updated product/plan/RDLC reference string only.'
            : 'Preserved verbatim (95% benchmark reuse policy).',
        });
      } else if (chg.decision === 'REQUIRES_REVIEW') {
        diffItems.push({
          fileName: targetFileName,
          symbolName: m.name,
          symbolKind: 'Method',
          status: 'REQUIRES_REVIEW',
          reason: `Unsafe automatic mutation stopped: ${chg.reason}`,
        });
        patched = patched.replace(
          m.signature,
          `${m.signature}\n            ' [REPORTGEN_REQUIRES_REVIEW ${chg.changeId}] ${chg.reason}`
        );
      } else if (chg.decision === 'REMOVE' && isBuilder) {
        const callRx = new RegExp(`(^.*\\b${escapeRegExp(m.name)}\\b.*$)`, 'gim');
        patched = patched.replace(
          callRx,
          `' [REPORTGEN_REMOVED ${chg.changeId}] Benchmark call omitted for ${prod}: $1`
        );
        diffItems.push({
          fileName: targetFileName,
          symbolName: m.name,
          symbolKind: 'Method',
          status: 'REMOVED',
          reason: chg.reason,
        });
      } else {
        diffItems.push({
          fileName: targetFileName,
          symbolName: m.name,
          symbolKind: 'Method',
          status: chg.decision === 'RENAME' ? 'RENAMED' : 'MODIFIED',
          reason: chg.reason,
        });
      }
    }

    // Append isolated sample-data helper & new ADD element methods cleanly before End Class
    const additions: string[] = [];
    if (isBuilder) {
      additions.push(this.buildControlledSampleAdapterMethod(definition));
    } else {
      for (const addChg of definition.changes.filter((c) => c.decision === 'ADD')) {
        additions.push(`
        ''' <summary>
        ''' Added section from PDF A (${addChg.changeId}: ${addChg.targetElement})
        ''' </summary>
        Public Shared Function ${addChg.generatedSymbol}(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "${escapeVbString(addChg.targetElement)}"
            element("ProductCode") = "${escapeVbString(prod)}"
            element("PlanCode") = "${escapeVbString(definition.planCode)}"
            Return element
        End Function`);
        diffItems.push({
          fileName: targetFileName,
          symbolName: addChg.generatedSymbol,
          symbolKind: 'Method',
          status: 'ADDED',
          reason: addChg.reason,
        });
      }

      for (const sb of definition.dataBindings.filter((b) => b.isStatusField)) {
        const symName = `Format${sb.field}Status`;
        additions.push(`
        ' [REPORTGEN_MOCK] Status badge formatter for ${sb.field} (states: ${(sb.candidateStates ?? ['Included', 'Not Covered']).join(', ')})
        Public Shared Function ${symName}(ByVal rawStatus As String) As String
            If String.IsNullOrWhiteSpace(rawStatus) Then
                Return "${escapeVbString(String(sb.dummyValue))}"
            End If
            Return rawStatus.Trim()
        End Function`);
        diffItems.push({
          fileName: targetFileName,
          symbolName: symName,
          symbolKind: 'Method',
          status: 'ADDED',
          reason: `Added status-field helper for ${sb.field}`,
        });
      }
    }

    const endClassIdx = patched.lastIndexOf('End Class');
    if (endClassIdx !== -1 && additions.length > 0) {
      patched = `${patched.slice(0, endClassIdx)}\n${additions.join('\n')}\n${patched.slice(endClassIdx)}`;
    } else if (additions.length > 0) {
      patched = `${patched}\n${additions.join('\n')}`;
    }

    return { source: patched, diffItems };
  }

  public buildDiffReport(items: MinimalMutationDiffItem[]): MinimalMutationReport {
    const unchangedCount = items.filter((i) => i.status === 'UNCHANGED').length;
    const renamedCount = items.filter((i) => i.status === 'RENAMED').length;
    const modifiedCount = items.filter((i) => i.status === 'MODIFIED').length;
    const addedCount = items.filter((i) => i.status === 'ADDED').length;
    const removedCount = items.filter((i) => i.status === 'REMOVED').length;
    const requiresReviewItems = items.filter((i) => i.status === 'REQUIRES_REVIEW');

    const benchmarkSymbolTotal =
      unchangedCount +
      renamedCount +
      modifiedCount +
      removedCount +
      requiresReviewItems.length;
    const preserved = unchangedCount + renamedCount;
    const preservationPercent =
      benchmarkSymbolTotal > 0
        ? Math.round((preserved / benchmarkSymbolTotal) * 1000) / 10
        : 0;

    return {
      preservationPercent,
      unchangedCount,
      renamedCount,
      modifiedCount,
      addedCount,
      removedCount,
      requiresReviewCount: requiresReviewItems.length,
      requiresReviewReasons: requiresReviewItems.map((r) => `${r.symbolName}: ${r.reason}`),
      items,
    };
  }

  private buildControlledSampleAdapterMethod(definition: ProposalDefinition): string {
    const assignments = definition.dataBindings
      .map((b) => {
        const valExpr =
          b.dataType === 'System.Decimal' || b.dataType === 'System.Int32'
            ? `${Number(b.dummyValue) || 0}D`
            : `"${escapeVbString(String(b.dummyValue))}"`;
        const marker =
          b.mode === 'RealProductEngine'
            ? ''
            : ` ' [REPORTGEN_MOCK mode=${b.mode} source=${b.productionSource} ref=${b.traceabilityRef ?? 'N/A'}]`;
        return `            row("${b.field}") = ${valExpr}${marker}`;
      })
      .join('\n');

    const colDefs = definition.dataBindings
      .map((b) => `            dt.Columns.Add("${b.field}", GetType(${b.dataType}))`)
      .join('\n');

    return `
        ''' <summary>
        ''' Isolated Sample/Reference DataTable adapter matching ${definition.dataSetName} when ProductEngine is unavailable.
        ''' </summary>
        Public Shared Function BuildReferenceDataTable() As DataTable
            Dim dt As New DataTable("${definition.dataSetName}")
${colDefs}
            Dim row As DataRow = dt.NewRow()
${assignments}
            dt.Rows.Add(row)
            Return dt
        End Function`;
  }

  private buildFallbackBuilder(definition: ProposalDefinition, benchmark: BenchmarkAnalysis): string {
    return `Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace ${benchmark.namespaceName}
    Public Class ${definition.productCode}ProposalBuilder
        Public Shared ReadOnly ProductCode As String = "${escapeVbString(definition.productCode)}"
        Public Shared ReadOnly PlanCode As String = "${escapeVbString(definition.planCode)}"

        Public Function BuildProposalDataSet() As DataSet
            Dim ds As New DataSet("${definition.dataSourceName}")
            ds.Tables.Add(BuildReferenceDataTable())
            Return ds
        End Function
${this.buildControlledSampleAdapterMethod(definition)}
    End Class
End Namespace
`;
  }

  private buildFallbackElement(definition: ProposalDefinition, benchmark: BenchmarkAnalysis): string {
    return `Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace ${benchmark.namespaceName}
    Public Class ${definition.productCode}ProposalElement
        Public Shared Function BuildSummaryElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("ProductCode") = "${escapeVbString(definition.productCode)}"
            element("PlanCode") = "${escapeVbString(definition.planCode)}"
            Return element
        End Function
    End Class
End Namespace
`;
  }
}
