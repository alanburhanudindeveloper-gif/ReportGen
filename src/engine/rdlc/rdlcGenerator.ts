import crypto from 'crypto';
import {
  ReportDefinition,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
  TablixCell,
  TablixRegion,
} from '../core/types.ts';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmtIn(inches: number): string {
  return `${Math.max(0.05, Math.round(inches * 1000) / 1000)}in`;
}

export class RdlcGenerator {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public generate(
    definition: ReportDefinition,
    embeddedVbCode: string,
    options?: { schemaVersion?: '2008' | '2016' }
  ): string {
    try {
      const schemaVersion = options?.schemaVersion ?? '2016';
      const dataSourceId = crypto.randomUUID();
      const reportId = crypto.randomUUID();

      const dataSetsXml = this.buildDataSetsXml(definition);
      const parametersXml = this.buildParametersXml(definition);
      const embeddedImagesXml = this.buildEmbeddedImagesXml(definition);
      const tablixXml = definition.tablixRegions.map((t) => this.buildTablixXml(t, definition)).join('\n');

      const maxBodyWidth = Math.max(
        definition.pageWidthIn - definition.marginsIn.left - definition.marginsIn.right,
        ...definition.tablixRegions.map((t) => t.leftIn + t.widthIn)
      );
      const maxBodyHeight = Math.max(
        1.0,
        ...definition.tablixRegions.map((t) => t.topIn + t.heightIn + 0.1)
      );

      const namespaceUrl =
        schemaVersion === '2008'
          ? 'http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition'
          : 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition';

      const bodyAndPageXml =
        schemaVersion === '2008'
          ? `  <Body>
    <ReportItems>
${tablixXml}
    </ReportItems>
    <Height>${fmtIn(maxBodyHeight)}</Height>
    <Style />
  </Body>
  <Width>${fmtIn(maxBodyWidth)}</Width>
  <Page>
    <PageHeight>${fmtIn(definition.pageHeightIn)}</PageHeight>
    <PageWidth>${fmtIn(definition.pageWidthIn)}</PageWidth>
    <LeftMargin>${fmtIn(definition.marginsIn.left)}</LeftMargin>
    <RightMargin>${fmtIn(definition.marginsIn.right)}</RightMargin>
    <TopMargin>${fmtIn(definition.marginsIn.top)}</TopMargin>
    <BottomMargin>${fmtIn(definition.marginsIn.bottom)}</BottomMargin>
    <Style />
  </Page>`
          : `  <ReportSections>
    <ReportSection>
      <Body>
        <ReportItems>
${tablixXml}
        </ReportItems>
        <Height>${fmtIn(maxBodyHeight)}</Height>
        <Style />
      </Body>
      <Width>${fmtIn(maxBodyWidth)}</Width>
      <Page>
        <PageHeight>${fmtIn(definition.pageHeightIn)}</PageHeight>
        <PageWidth>${fmtIn(definition.pageWidthIn)}</PageWidth>
        <LeftMargin>${fmtIn(definition.marginsIn.left)}</LeftMargin>
        <RightMargin>${fmtIn(definition.marginsIn.right)}</RightMargin>
        <TopMargin>${fmtIn(definition.marginsIn.top)}</TopMargin>
        <BottomMargin>${fmtIn(definition.marginsIn.bottom)}</BottomMargin>
        <Style />
      </Page>
    </ReportSection>
  </ReportSections>`;

      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns="${namespaceUrl}" xmlns:rd="http://schemas.microsoft.com/SQLServer/reporting/reportdesigner">
  <AutoRefresh>0</AutoRefresh>
  <DataSources>
    <DataSource Name="${escapeXml(definition.dataSourceName)}">
      <ConnectionProperties>
        <DataProvider>System.Data.DataSet</DataProvider>
        <ConnectString>/* Local Connection */</ConnectString>
      </ConnectionProperties>
      <rd:DataSourceID>${dataSourceId}</rd:DataSourceID>
    </DataSource>
  </DataSources>
  <DataSets>
${dataSetsXml}
  </DataSets>
${embeddedImagesXml}
${bodyAndPageXml}
  <ReportParameters>
${parametersXml}
  </ReportParameters>
  <Code>${escapeXml(embeddedVbCode)}</Code>
  <rd:ReportUnitType>Inch</rd:ReportUnitType>
  <rd:ReportID>${reportId}</rd:ReportID>
</Report>
`;

      this.logger.info('RdlcGenerator', `RDLC ${schemaVersion} generated deterministically`, {
        schemaVersion,
        tablixCount: definition.tablixRegions.length,
        xmlBytes: Buffer.byteLength(xml, 'utf-8'),
      });
      return xml;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ReportGenError(ReportGenErrorCode.RDLC_GENERATION_FAILED, msg, err);
    }
  }

  private buildDataSetsXml(definition: ReportDefinition): string {
    const fieldsXml = definition.fields
      .map(
        (f) => `        <Field Name="${escapeXml(f.name)}">
          <DataField>${escapeXml(f.name)}</DataField>
          <rd:TypeName>${escapeXml(f.dataType)}</rd:TypeName>
        </Field>`
      )
      .join('\n');

    return `    <DataSet Name="${escapeXml(definition.dataSetName)}">
      <Query>
        <DataSourceName>${escapeXml(definition.dataSourceName)}</DataSourceName>
        <CommandText>/* Local Query */</CommandText>
      </Query>
      <Fields>
${fieldsXml}
      </Fields>
    </DataSet>`;
  }

  private buildParametersXml(definition: ReportDefinition): string {
    return definition.parameters
      .map(
        (p) => `    <ReportParameter Name="${escapeXml(p.name)}">
      <DataType>${escapeXml(p.dataType)}</DataType>
      <Nullable>true</Nullable>
      <AllowBlank>true</AllowBlank>
      <Prompt>${escapeXml(p.prompt)}</Prompt>
    </ReportParameter>`
      )
      .join('\n');
  }

  private buildEmbeddedImagesXml(definition: ReportDefinition): string {
    if (definition.embeddedImages.length === 0) return '';
    const items = definition.embeddedImages
      .map(
        (img) => `    <EmbeddedImage Name="${escapeXml(img.name)}">
      <MIMEType>${escapeXml(img.mimeType)}</MIMEType>
      <ImageData>${img.base64Data}</ImageData>
    </EmbeddedImage>`
      )
      .join('\n');
    return `  <EmbeddedImages>\n${items}\n  </EmbeddedImages>`;
  }

  private buildTablixXml(tablix: TablixRegion, definition: ReportDefinition): string {
    const columnsXml = tablix.columnWidthsIn
      .map(
        (w) => `              <TablixColumn>
                <Width>${fmtIn(w)}</Width>
              </TablixColumn>`
      )
      .join('\n');

    const colMembersXml = tablix.columnWidthsIn
      .map(() => `              <TablixMember />`)
      .join('\n');

    const rowsXml = tablix.rows
      .map((row) => {
        const cellsXml = row.cells.map((cell) => this.buildCellXml(cell, definition)).join('\n');
        return `              <TablixRow>
                <Height>${fmtIn(row.heightIn)}</Height>
                <TablixCells>
${cellsXml}
                </TablixCells>
              </TablixRow>`;
      })
      .join('\n');

    const rowMembersXml = tablix.rows
      .map((row, idx) => {
        if (tablix.isRepeatingDetail && row.isDetailRow) {
          return `              <TablixMember>
                <Group Name="Details_${escapeXml(tablix.name)}_${idx}" />
              </TablixMember>`;
        }
        return `              <TablixMember>
                <KeepWithGroup>After</KeepWithGroup>
              </TablixMember>`;
      })
      .join('\n');

    return `          <Tablix Name="${escapeXml(tablix.name)}">
            <TablixBody>
              <TablixColumns>
${columnsXml}
              </TablixColumns>
              <TablixRows>
${rowsXml}
              </TablixRows>
            </TablixBody>
            <TablixColumnHierarchy>
              <TablixMembers>
${colMembersXml}
              </TablixMembers>
            </TablixColumnHierarchy>
            <TablixRowHierarchy>
              <TablixMembers>
${rowMembersXml}
              </TablixMembers>
            </TablixRowHierarchy>
            <DataSetName>${escapeXml(tablix.dataSetName ?? definition.dataSetName)}</DataSetName>
            <Top>${fmtIn(tablix.topIn)}</Top>
            <Left>${fmtIn(tablix.leftIn)}</Left>
            <Height>${fmtIn(tablix.heightIn)}</Height>
            <Width>${fmtIn(tablix.widthIn)}</Width>
            <Style>
              <Border>
                <Style>None</Style>
              </Border>
            </Style>
          </Tablix>`;
  }

  private buildCellXml(cell: TablixCell, definition: ReportDefinition): string {
    if (cell.skipBecauseMerged) {
      return `                  <TablixCell />`;
    }

    const colSpanTag = cell.colSpan > 1 ? `\n                        <ColSpan>${cell.colSpan}</ColSpan>` : '';
    const rowSpanTag = cell.rowSpan > 1 ? `\n                        <RowSpan>${cell.rowSpan}</RowSpan>` : '';

    if (cell.content.kind === 'Image') {
      const matched = definition.embeddedImages.find((img) => img.base64Data === (cell.content as { base64Data: string }).base64Data);
      const imageValue = matched ? matched.name : 'EmbeddedGraphic';
      return `                  <TablixCell>
                    <CellContents>
                      <Image Name="${escapeXml(cell.content.name)}">
                        <Source>Embedded</Source>
                        <Value>${escapeXml(imageValue)}</Value>
                        <Sizing>${cell.content.sizing}</Sizing>
                        <Style>
                          <Border>
                            <Style>None</Style>
                          </Border>
                        </Style>
                      </Image>${colSpanTag}${rowSpanTag}
                    </CellContents>
                  </TablixCell>`;
    }

    if (cell.content.kind === 'Empty') {
      return `                  <TablixCell>
                    <CellContents>
                      <Textbox Name="${escapeXml(cell.content.name)}">
                        <CanGrow>true</CanGrow>
                        <KeepTogether>true</KeepTogether>
                        <Paragraphs>
                          <Paragraph>
                            <TextRuns>
                              <TextRun>
                                <Value />
                                <Style />
                              </TextRun>
                            </TextRuns>
                            <Style />
                          </Paragraph>
                        </Paragraphs>
                        <Style />
                      </Textbox>${colSpanTag}${rowSpanTag}
                    </CellContents>
                  </TablixCell>`;
    }

    const tb = cell.content;
    const st = tb.style;
    const borderXml = st.borderColor
      ? `<Border>
                            <Color>${escapeXml(st.borderColor)}</Color>
                            <Style>Solid</Style>
                            <Width>${Math.max(0.5, st.borderWidthPt ?? 0.75)}pt</Width>
                          </Border>`
      : `<Border>
                            <Style>None</Style>
                          </Border>`;
    const bgXml = st.backgroundColor
      ? `\n                          <BackgroundColor>${escapeXml(st.backgroundColor)}</BackgroundColor>`
      : '';

    return `                  <TablixCell>
                    <CellContents>
                      <Textbox Name="${escapeXml(tb.name)}">
                        <CanGrow>${tb.canGrow ? 'true' : 'false'}</CanGrow>
                        <KeepTogether>true</KeepTogether>
                        <Paragraphs>
                          <Paragraph>
                            <TextRuns>
                              <TextRun>
                                <Value>${escapeXml(tb.value)}</Value>
                                <Style>
                                  <FontFamily>${escapeXml(st.fontFamily)}</FontFamily>
                                  <FontSize>${st.fontSizePt}pt</FontSize>
                                  <FontWeight>${st.bold ? 'Bold' : 'Normal'}</FontWeight>
                                  <FontStyle>${st.italic ? 'Italic' : 'Normal'}</FontStyle>
                                  <Color>${escapeXml(st.color)}</Color>
                                </Style>
                              </TextRun>
                            </TextRuns>
                            <Style>
                              <TextAlign>${st.textAlign}</TextAlign>
                            </Style>
                          </Paragraph>
                        </Paragraphs>
                        <Style>
                          ${borderXml}${bgXml}
                          <VerticalAlign>${st.verticalAlign}</VerticalAlign>
                          <PaddingLeft>${st.paddingPt.left}pt</PaddingLeft>
                          <PaddingRight>${st.paddingPt.right}pt</PaddingRight>
                          <PaddingTop>${st.paddingPt.top}pt</PaddingTop>
                          <PaddingBottom>${st.paddingPt.bottom}pt</PaddingBottom>
                        </Style>
                      </Textbox>${colSpanTag}${rowSpanTag}
                    </CellContents>
                  </TablixCell>`;
  }
}
