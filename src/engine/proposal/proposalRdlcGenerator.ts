import {
  IntermediateLayoutModel,
  ReportDefinition,
  ReportFieldDef,
  StructuredLogger,
} from '../core/types.ts';
import { GridReconstructor } from '../pdf/gridReconstructor.ts';
import { RdlcGenerator } from '../rdlc/rdlcGenerator.ts';
import { TablixBuilder } from '../rdlc/tablixBuilder.ts';
import { VbGenerator } from '../vb/vbGenerator.ts';
import { Rdlc2008Patcher } from './rdlc2008Patcher.ts';
import {
  BenchmarkAnalysis,
  MinimalMutationDiffItem,
  ProposalDefinition,
} from './types.ts';

export class ProposalRdlcGenerator {
  private readonly logger: StructuredLogger;
  private readonly gridReconstructor: GridReconstructor;
  private readonly tablixBuilder: TablixBuilder;
  private readonly rdlcGenerator: RdlcGenerator;
  private readonly rdlc2008Patcher: Rdlc2008Patcher;
  private readonly vbHelperGenerator: VbGenerator;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
    this.gridReconstructor = new GridReconstructor(logger);
    this.tablixBuilder = new TablixBuilder(logger);
    this.rdlcGenerator = new RdlcGenerator(logger);
    this.rdlc2008Patcher = new Rdlc2008Patcher(logger);
    this.vbHelperGenerator = new VbGenerator(logger);
  }

  public generate(
    definition: ProposalDefinition,
    pdfALayout: IntermediateLayoutModel,
    benchmark: BenchmarkAnalysis
  ): {
    rdlcXml: string;
    additionalRdlcFiles: Array<{ fileName: string; xml: string }>;
    reportDefinition: ReportDefinition;
    diffItems: MinimalMutationDiffItem[];
  } {
    const prod = definition.productCode;
    const bench = benchmark.productCode;
    const diffItems: MinimalMutationDiffItem[] = [];

    const fields: ReportFieldDef[] = definition.dataBindings.map((b) => ({
      name: b.field,
      dataType: b.dataType,
      sampleValue: b.dummyValue,
      isCalculated: b.dataType === 'System.Decimal' && /premium|total|benefit|amount|sum/i.test(b.field),
    }));

    const reportDef: ReportDefinition = {
      reportName: `${prod}ProposalLayout`,
      dataSourceName: definition.dataSourceName,
      dataSetName: definition.dataSetName,
      pageWidthIn: definition.layoutPageSettings.pageWidthIn,
      pageHeightIn: definition.layoutPageSettings.pageHeightIn,
      marginsIn: { ...definition.layoutPageSettings.marginsIn },
      fields,
      parameters: definition.parameters.map((p) => ({
        name: p.name,
        dataType: 'String',
        prompt: p.name,
        defaultValue: p.defaultValue,
      })),
      calculations: [],
      tablixRegions: [],
      embeddedImages: [],
      existingPatternUsed: bench,
    };

    // Minimal-mutation first: clone & patch benchmark RDLC 2008 file(s) whenever available
    const benchRdlcs =
      benchmark.rawLayoutXmls && benchmark.rawLayoutXmls.length > 0
        ? benchmark.rawLayoutXmls
        : benchmark.rawLayoutXml
        ? [
            {
              fileName: `${bench}ProposalLayout.rdlc`,
              filePath: '',
              xml: benchmark.rawLayoutXml,
              rdlcSchemaVersion: '2008' as const,
            },
          ]
        : [];

    if (benchRdlcs.length > 0) {
      const patchedAll = benchRdlcs.map((bRdlc) => {
        const targetFileName = bRdlc.fileName.replace(new RegExp(`^${bench}`, 'i'), prod);
        const patched = this.rdlc2008Patcher.patchBenchmarkRdlc2008(
          bRdlc.xml,
          targetFileName,
          definition,
          benchmark
        );
        diffItems.push(...patched.diffItems);
        return { fileName: targetFileName, xml: patched.xml };
      });

      const primary =
        patchedAll.find((r) => /ProposalLayout\.rdlc$/i.test(r.fileName)) ?? patchedAll[0];
      const additionalRdlcFiles = patchedAll.filter((r) => r.fileName !== primary.fileName);

      this.logger.info('ProposalRdlcGenerator', `Minimal-mutation patched ${patchedAll.length} RDLC 2008 file(s)`, {
        primary: primary.fileName,
        additional: additionalRdlcFiles.map((a) => a.fileName),
      });

      return {
        rdlcXml: primary.xml,
        additionalRdlcFiles,
        reportDefinition: reportDef,
        diffItems,
      };
    }

    // Fallback when benchmark has no RDLC file: deterministic RDLC 2008 generation from reconstructed grid
    const clonedLayout: IntermediateLayoutModel = JSON.parse(JSON.stringify(pdfALayout));
    const reconstructedLayout = this.gridReconstructor.reconstruct(clonedLayout, 0.04);

    const builtDef = this.tablixBuilder.buildReportDefinition(reconstructedLayout, undefined, {
      sourceFiles: [bench],
      dataSourceName: definition.dataSourceName,
      dataSetName: definition.dataSetName,
      fields: fields.map((f) => f.name),
      parameters: definition.parameters.map((p) => p.name),
      vbClassName: `${prod}ProposalBuilder`,
      vbNamespace: benchmark.namespaceName,
      vbFunctions: [],
      expressions: benchmark.expressions,
      conventions: [],
    });

    const mergedFieldsMap = new Map<string, ReportFieldDef>();
    for (const f of fields) mergedFieldsMap.set(f.name, f);
    for (const f of builtDef.fields) {
      if (!mergedFieldsMap.has(f.name)) mergedFieldsMap.set(f.name, f);
    }

    reportDef.fields = Array.from(mergedFieldsMap.values());
    reportDef.tablixRegions = builtDef.tablixRegions.map((t) => ({
      ...t,
      dataSetName: definition.dataSetName,
    }));
    reportDef.embeddedImages = builtDef.embeddedImages;

    const vbHelperOut = this.vbHelperGenerator.generate(reportDef, {
      sourceFiles: [],
      dataSourceName: definition.dataSourceName,
      dataSetName: definition.dataSetName,
      fields: reportDef.fields.map((f) => f.name),
      parameters: definition.parameters.map((p) => p.name),
      vbClassName: `${prod}ReportCode`,
      vbNamespace: benchmark.namespaceName,
      vbFunctions: [],
      expressions: [],
      conventions: [],
    });

    const rdlcXml = this.rdlcGenerator.generate(reportDef, vbHelperOut.embeddedRdlcCode, {
      schemaVersion: '2008',
    });

    diffItems.push({
      fileName: `${prod}ProposalLayout.rdlc`,
      symbolName: `${prod}ProposalLayout.rdlc`,
      symbolKind: 'RDLC',
      status: 'ADDED',
      reason: 'Benchmark lacked RDLC template; generated strict RDLC 2008 from PDF A layout.',
    });

    return { rdlcXml, additionalRdlcFiles: [], reportDefinition: reportDef, diffItems };
  }
}
