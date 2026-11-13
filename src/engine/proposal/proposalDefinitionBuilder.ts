import { StructuredLogger } from '../core/types.ts';
import { SampleScenarioBuilder } from './sampleScenarioBuilder.ts';
import {
  BenchmarkAnalysis,
  FieldBindingSpec,
  IProposalDefinitionBuilder,
  ModificationChange,
  ProposalDefinition,
  ProposalSectionSpec,
  ReferenceDataExtract,
  TemplateAnalysis,
} from './types.ts';

function mapFieldType(
  t: 'String' | 'Decimal' | 'Date' | 'Status'
): FieldBindingSpec['dataType'] {
  if (t === 'Decimal') return 'System.Decimal';
  if (t === 'Date') return 'System.DateTime';
  return 'System.String';
}

export class ProposalDefinitionBuilder implements IProposalDefinitionBuilder {
  private readonly logger: StructuredLogger;
  private readonly scenarioBuilder = new SampleScenarioBuilder();

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public build(input: {
    productCode: string;
    planCode: string;
    benchmark: BenchmarkAnalysis;
    pdfA: TemplateAnalysis;
    pdfB?: TemplateAnalysis;
    referenceExtract?: ReferenceDataExtract;
    changes: ModificationChange[];
  }): ProposalDefinition {
    const product = input.productCode.toUpperCase();
    const plan = input.planCode.toUpperCase();

    const bindingsMap = new Map<string, FieldBindingSpec>();

    // Seed from benchmark fields first (preserve real schema continuity)
    for (const bf of input.benchmark.fields) {
      const engineBinding = input.benchmark.productEngineBindings.find(
        (b) => b.field.toLowerCase() === bf.name.toLowerCase()
      );
      bindingsMap.set(bf.name.toLowerCase(), {
        field: bf.name,
        dataType:
          bf.dataType === 'System.Decimal' || bf.dataType === 'System.Int32' || bf.dataType === 'System.DateTime'
            ? bf.dataType
            : 'System.String',
        mode: engineBinding ? 'SampleData' : 'RealProductEngine',
        dummyValue: bf.dataType === 'System.Decimal' ? 1250.0 : `${product}-SAMPLE`,
        productionSource: engineBinding
          ? engineBinding.expression
          : `ProductEngine.Get${bf.name}("${product}", "${plan}")`,
        isStatusField: /status|rider|waiver|state/i.test(bf.name),
        confidence: 0.92,
        confirmed: true,
      });
    }

    // Merge PDF B extracted fields & status fields with traceability
    for (const ef of input.referenceExtract?.fields ?? []) {
      const existing = bindingsMap.get(ef.field.toLowerCase());
      const requiresMock = ef.inferredType === 'Decimal' || ef.isStatusField;
      bindingsMap.set(ef.field.toLowerCase(), {
        field: ef.field,
        dataType: mapFieldType(ef.inferredType),
        mode: requiresMock ? 'SampleData' : 'ReferencePdfExtract',
        dummyValue: ef.value,
        productionSource: existing?.productionSource ?? `ProductEngine.Resolve${ef.field}("${product}", "${plan}")`,
        isStatusField: ef.isStatusField,
        candidateStates: ef.candidateStates,
        confidence: ef.confidence,
        confirmed: ef.status === 'CONFIRMED',
        traceabilityRef: `${ef.traceability.pdfFile}#p${ef.traceability.page}`,
      });
    }

    if (!bindingsMap.has('productcode')) {
      bindingsMap.set('productcode', {
        field: 'ProductCode',
        dataType: 'System.String',
        mode: 'RealProductEngine',
        dummyValue: product,
        productionSource: `"${product}"`,
        isStatusField: false,
        confidence: 0.99,
        confirmed: true,
      });
    }
    if (!bindingsMap.has('plancode')) {
      bindingsMap.set('plancode', {
        field: 'PlanCode',
        dataType: 'System.String',
        mode: 'RealProductEngine',
        dummyValue: plan,
        productionSource: `"${plan}"`,
        isStatusField: false,
        confidence: 0.99,
        confirmed: true,
      });
    }

    const dataBindings = Array.from(bindingsMap.values());
    const sampleScenarios = this.scenarioBuilder.buildScenarios(dataBindings);

    // Build explicit multi-section ordering mapping elements & 1..N RDLCs
    const bench = input.benchmark.productCode;
    const primaryTargetRdlc = `${product}ProposalLayout.rdlc`;
    const rdlcNames = (input.benchmark.rawLayoutXmls ?? []).map((r) =>
      r.fileName.replace(new RegExp(`^${bench}`, 'i'), product)
    );

    const sections: ProposalSectionSpec[] = input.changes.map((c, idx) => {
      const matchedRdlc =
        rdlcNames.find((rn) =>
          c.targetElement.toLowerCase().includes('benefit') && /benefit/i.test(rn)
        ) ?? primaryTargetRdlc;
      return {
        id: c.changeId,
        title: c.targetElement,
        ordering: idx + 1,
        pageBreakBefore: Boolean(c.targetPdfRegion && c.targetPdfRegion.page > 1),
        sourceBenchmark: bench,
        sourceElement: c.benchmarkElement,
        targetRdlcFile: matchedRdlc,
        decision: c.decision,
        changes: c.changes,
      };
    });

    const highCount = input.changes.filter((c) => c.tier === 'HIGH').length;
    const mediumCount = input.changes.filter((c) => c.tier === 'MEDIUM').length;
    const lowCount = input.changes.filter((c) => c.tier === 'LOW').length;

    const firstPage = input.pdfA.pages[0];
    const layoutPageSettings = firstPage
      ? {
          pageWidthIn: firstPage.widthIn,
          pageHeightIn: firstPage.heightIn,
          marginsIn: { ...input.benchmark.pageSettings.marginsIn },
        }
      : { ...input.benchmark.pageSettings };

    const paramNames = Array.from(
      new Set(['ProductCode', 'PlanCode', ...input.benchmark.parameters])
    );

    const def: ProposalDefinition = {
      productCode: product,
      planCode: plan,
      benchmarkProductCode: bench,
      createdAt: new Date().toISOString(),
      rdlcSchemaVersion: '2008',
      confidenceSummary: {
        highCount,
        mediumCount,
        lowCount,
        requiresUserReview: mediumCount > 0 || lowCount > 0,
      },
      sections,
      changes: input.changes,
      dataBindings,
      sampleScenarios,
      parameters: paramNames.map((name) => ({
        name,
        dataType: 'String',
        defaultValue: name === 'ProductCode' ? product : name === 'PlanCode' ? plan : '',
      })),
      dataSourceName: input.benchmark.dataSourceName.replace(
        new RegExp(bench, 'gi'),
        product
      ),
      dataSetName: `${product}ProposalDataSet`,
      layoutPageSettings,
    };

    this.logger.info('ProposalDefinitionBuilder', `Built RDLC 2008 ProposalDefinition for ${product}`, {
      sections: def.sections.length,
      changes: def.changes.length,
      bindings: def.dataBindings.length,
      scenarios: sampleScenarios.length,
    });

    return def;
  }
}
