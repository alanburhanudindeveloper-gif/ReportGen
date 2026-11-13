import { StructuredLogger } from '../core/types.ts';
import {
  BenchmarkAnalysis,
  MinimalMutationDiffItem,
  ProposalDefinition,
} from './types.ts';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeRegExp(val: string): string {
  return val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Rdlc2008Patcher {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public patchBenchmarkRdlc2008(
    rawBenchmarkXml: string,
    targetFileName: string,
    definition: ProposalDefinition,
    benchmark: BenchmarkAnalysis
  ): { xml: string; diffItems: MinimalMutationDiffItem[] } {
    const prod = definition.productCode;
    const bench = benchmark.productCode;
    const diffItems: MinimalMutationDiffItem[] = [];

    // 1. Copy benchmark RDLC and safely rename DataSource / DataSet / Product references
    let xml = rawBenchmarkXml;
    if (!xml || !xml.trim()) {
      this.logger.warn(
        'Rdlc2008Patcher',
        `Benchmark RDLC for ${targetFileName} was empty on disk; synthesizing minimal RDLC 2008 skeleton.`
      );
      xml = `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition" xmlns:rd="http://schemas.microsoft.com/SQLServer/reporting/reportdesigner">
  <DataSources>
    <DataSource Name="${escapeXml(definition.dataSourceName)}">
      <ConnectionProperties><DataProvider>System.Data.DataSet</DataProvider><ConnectString>/* Local Connection */</ConnectString></ConnectionProperties>
      <rd:DataSourceID>33333333-3333-4333-8333-333333333333</rd:DataSourceID>
    </DataSource>
  </DataSources>
  <DataSets>
    <DataSet Name="${escapeXml(definition.dataSetName)}">
      <Query><DataSourceName>${escapeXml(definition.dataSourceName)}</DataSourceName><CommandText>/* Local Query */</CommandText></Query>
      <Fields>
      </Fields>
    </DataSet>
  </DataSets>
  <Body>
    <ReportItems>
    </ReportItems>
    <Height>1.5in</Height>
    <Style />
  </Body>
  <Width>7.7in</Width>
  <Page><PageHeight>11in</PageHeight><PageWidth>8.5in</PageWidth><LeftMargin>0.4in</LeftMargin><RightMargin>0.4in</RightMargin><TopMargin>0.4in</TopMargin><BottomMargin>0.4in</BottomMargin><Style /></Page>
  <ReportParameters>
  </ReportParameters>
  <rd:ReportUnitType>Inch</rd:ReportUnitType>
</Report>
`;
    }
    xml = xml.replace(
      new RegExp(`"${escapeRegExp(bench)}DataSource"`, 'g'),
      `"${escapeXml(definition.dataSourceName)}"`
    );
    xml = xml.replace(
      new RegExp(`<DataSourceName>${escapeRegExp(bench)}DataSource</DataSourceName>`, 'g'),
      `<DataSourceName>${escapeXml(definition.dataSourceName)}</DataSourceName>`
    );
    xml = xml.replace(
      new RegExp(`"${escapeRegExp(bench)}ProposalDataSet"`, 'g'),
      `"${escapeXml(definition.dataSetName)}"`
    );
    xml = xml.replace(
      new RegExp(`<DataSetName>${escapeRegExp(bench)}ProposalDataSet</DataSetName>`, 'g'),
      `<DataSetName>${escapeXml(definition.dataSetName)}</DataSetName>`
    );
    xml = xml.replace(
      new RegExp(`Tablix_${escapeRegExp(bench)}`, 'g'),
      `Tablix_${prod}`
    );

    // Normalize RDLC 2016 <ReportSections><ReportSection> wrapper down to strict RDLC 2008 if benchmark happened to be 2016
    if (/<ReportSections>/i.test(xml)) {
      xml = xml
        .replace(
          /http:\/\/schemas\.microsoft\.com\/sqlserver\/reporting\/2016\/01\/reportdefinition/gi,
          'http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition'
        )
        .replace(/<ReportSections>\s*<ReportSection>/i, '')
        .replace(/<\/ReportSection>\s*<\/ReportSections>/i, '');
    }

    diffItems.push({
      fileName: targetFileName,
      symbolName: targetFileName,
      symbolKind: 'RDLC',
      status: 'RENAMED',
      reason: `Cloned benchmark RDLC 2008 XML and rebound DataSet "${definition.dataSetName}" preserving Tablix layout.`,
    });

    // Audit preserved Tablix blocks & existing ReportParameters from benchmark
    for (const match of xml.matchAll(/<Tablix\s+Name="([^"]+)"/gi)) {
      const tName = match[1];
      const wasRenamed = bench !== prod && tName.includes(prod);
      diffItems.push({
        fileName: targetFileName,
        symbolName: tName,
        symbolKind: 'Tablix',
        status: wasRenamed ? 'RENAMED' : 'UNCHANGED',
        reason: wasRenamed
          ? 'Preserved benchmark Tablix layout with updated product identifier.'
          : 'Preserved benchmark Tablix layout verbatim.',
      });
    }

    for (const match of xml.matchAll(/<ReportParameter\s+Name="([^"]+)"/gi)) {
      diffItems.push({
        fileName: targetFileName,
        symbolName: match[1],
        symbolKind: 'Parameter',
        status: 'UNCHANGED',
        reason: 'Reused existing benchmark ReportParameter.',
      });
    }

    // 2. Patch only missing <Field> entries into <Fields>
    const addedFields: string[] = [];
    for (const binding of definition.dataBindings) {
      const fieldPattern = new RegExp(`<Field\\s+Name="${escapeRegExp(binding.field)}"`, 'i');
      if (!fieldPattern.test(xml)) {
        addedFields.push(
          `        <Field Name="${escapeXml(binding.field)}"><DataField>${escapeXml(
            binding.field
          )}</DataField><rd:TypeName>${escapeXml(binding.dataType)}</rd:TypeName></Field>`
        );
        diffItems.push({
          fileName: targetFileName,
          symbolName: binding.field,
          symbolKind: 'Field',
          status: 'ADDED',
          reason: `Added new DataSet field binding (${binding.mode})`,
        });
      } else {
        diffItems.push({
          fileName: targetFileName,
          symbolName: binding.field,
          symbolKind: 'Field',
          status: 'UNCHANGED',
          reason: 'Reused existing benchmark DataSet field.',
        });
      }
    }
    if (addedFields.length > 0 && xml.includes('</Fields>')) {
      xml = xml.replace('</Fields>', `${addedFields.join('\n')}\n      </Fields>`);
    }

    // 3. Patch only missing <ReportParameter> entries into <ReportParameters>
    const addedParams: string[] = [];
    for (const param of definition.parameters) {
      const paramPattern = new RegExp(`<ReportParameter\\s+Name="${escapeRegExp(param.name)}"`, 'i');
      if (!paramPattern.test(xml)) {
        addedParams.push(
          `    <ReportParameter Name="${escapeXml(param.name)}"><DataType>${escapeXml(
            param.dataType
          )}</DataType><Nullable>true</Nullable><AllowBlank>true</AllowBlank><Prompt>${escapeXml(
            param.name
          )}</Prompt></ReportParameter>`
        );
        diffItems.push({
          fileName: targetFileName,
          symbolName: param.name,
          symbolKind: 'Parameter',
          status: 'ADDED',
          reason: 'Added missing ReportParameter from ProposalDefinition.',
        });
      }
    }
    if (addedParams.length > 0 && xml.includes('</ReportParameters>')) {
      xml = xml.replace('</ReportParameters>', `${addedParams.join('\n')}\n  </ReportParameters>`);
    }

    // 4. Patch new ADD sections into </ReportItems> as RDLC 2008 Tablix blocks without altering existing Tablix blocks
    const addSections = definition.sections.filter(
      (s) => s.decision === 'ADD' && s.targetRdlcFile.toLowerCase() === targetFileName.toLowerCase()
    );

    if (addSections.length > 0 && xml.includes('</ReportItems>')) {
      let topCursor = 2.6;
      const newTablixBlocks = addSections
        .map((sec, idx) => {
          const safeId = sec.id.replace(/[^A-Za-z0-9_]/g, '_');
          const topIn = (topCursor + idx * 0.75).toFixed(2);
          const pageBreakXml = sec.pageBreakBefore
            ? '\n        <PageBreak><BreakLocation>Start</BreakLocation></PageBreak>'
            : '';
          diffItems.push({
            fileName: targetFileName,
            symbolName: `Tablix_${safeId}`,
            symbolKind: 'Tablix',
            status: 'ADDED',
            reason: `Inserted RDLC 2008 Tablix section for "${sec.title}".`,
          });

          return `      <Tablix Name="Tablix_${escapeXml(safeId)}">
        <TablixBody>
          <TablixColumns>
            <TablixColumn><Width>6.8in</Width></TablixColumn>
          </TablixColumns>
          <TablixRows>
            <TablixRow>
              <Height>0.32in</Height>
              <TablixCells>
                <TablixCell>
                  <CellContents>
                    <Textbox Name="txtSection_${escapeXml(safeId)}">
                      <CanGrow>true</CanGrow>
                      <Paragraphs><Paragraph><TextRuns><TextRun><Value>${escapeXml(
                        sec.title
                      )}</Value><Style><FontWeight>Bold</FontWeight></Style></TextRun></TextRuns><Style /></Paragraph></Paragraphs>
                      <Style />
                    </Textbox>
                  </CellContents>
                </TablixCell>
              </TablixCells>
            </TablixRow>
          </TablixRows>
        </TablixBody>
        <TablixColumnHierarchy><TablixMembers><TablixMember /></TablixMembers></TablixColumnHierarchy>
        <TablixRowHierarchy><TablixMembers><TablixMember><KeepWithGroup>After</KeepWithGroup></TablixMember></TablixMembers></TablixRowHierarchy>
        <DataSetName>${escapeXml(definition.dataSetName)}</DataSetName>${pageBreakXml}
        <Top>${topIn}in</Top>
        <Left>0.4in</Left>
        <Height>0.32in</Height>
        <Width>6.8in</Width>
      </Tablix>`;
        })
        .join('\n');

      xml = xml.replace('</ReportItems>', `${newTablixBlocks}\n    </ReportItems>`);
      xml = xml.replace(/<Height>[\d.]+in<\/Height>(\s*<Style \/>\s*<\/Body>)/i, `<Height>${(topCursor + addSections.length * 0.75 + 0.5).toFixed(2)}in</Height>$1`);
    }

    this.logger.info('Rdlc2008Patcher', `Minimal-mutation patched ${targetFileName}`, {
      addedFields: addedFields.length,
      addedParams: addedParams.length,
      addedSections: addSections.length,
    });

    return { xml, diffItems };
  }
}
