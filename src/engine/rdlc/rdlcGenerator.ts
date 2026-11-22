import crypto from 'crypto';
import {
  ReportDefinition,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
  TablixCell,
  TablixRegion,
  VisualImageItem,
  VisualPageLayer,
  VisualRectItem,
  VisualTextboxItem,
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

function fmtPosIn(inches: number): string {
  return `${Math.max(0, Math.round(inches * 1000) / 1000)}in`;
}

function fmtSizeIn(inches: number, min = 0.014): string {
  return `${Math.max(min, Math.round(inches * 1000) / 1000)}in`;
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
      const printableWidth = Math.max(
        1.5,
        definition.pageWidthIn - definition.marginsIn.left - definition.marginsIn.right
      );
      const printableHeight = Math.max(
        2.0,
        definition.pageHeightIn - definition.marginsIn.top - definition.marginsIn.bottom
      );

      let reportItemsXml: string;
      let maxBodyHeight: number;
      const visualPages = definition.visualPages;

      if (visualPages && visualPages.length > 0) {
        const containerHeight = Math.max(1.0, printableHeight - 0.02);
        reportItemsXml = visualPages
          .map((vp, idx) => this.buildVisualPageContainerXml(vp, idx, visualPages.length, containerHeight, printableWidth, definition))
          .join('\n');
        maxBodyHeight = Math.max(containerHeight, visualPages.length * containerHeight);
      } else {
        const pageGroups = new Map<number, TablixRegion[]>();
        for (const t of definition.tablixRegions) {
          const list = pageGroups.get(t.pageNumber) ?? [];
          list.push(t);
          pageGroups.set(t.pageNumber, list);
        }
        const sortedPages = Array.from(pageGroups.keys()).sort((a, b) => a - b);

        if (sortedPages.length > 1) {
          const containerHeight = Math.max(1.0, printableHeight - 0.05);
          reportItemsXml = sortedPages
            .map((pageNum, idx) => {
              const pageTablixes = pageGroups.get(pageNum) ?? [];
              const innerXml = pageTablixes
                .map((t) => {
                  const pageRelativeTop = Math.max(
                    0.05,
                    Math.round((t.topIn - (pageNum - 1) * definition.pageHeightIn) * 1000) / 1000
                  );
                  return this.buildTablixXml({ ...t, topIn: pageRelativeTop }, definition);
                })
                .join('\n');
              const pageBreakXml =
                idx < sortedPages.length - 1
                  ? '\n            <PageBreak><BreakLocation>End</BreakLocation></PageBreak>'
                  : '';
              const containerTop = Math.round(idx * containerHeight * 1000) / 1000;
              return `          <Rectangle Name="PageContainer_P${pageNum}">
            <ReportItems>
${innerXml}
            </ReportItems>
            <KeepTogether>false</KeepTogether>${pageBreakXml}
            <Top>${fmtPosIn(containerTop)}</Top>
            <Left>0in</Left>
            <Height>${fmtSizeIn(containerHeight, 0.5)}</Height>
            <Width>${fmtSizeIn(printableWidth, 0.5)}</Width>
            <Style>
              <Border><Style>None</Style></Border>
            </Style>
          </Rectangle>`;
            })
            .join('\n');
          maxBodyHeight = Math.max(containerHeight, sortedPages.length * containerHeight);
        } else {
          reportItemsXml = definition.tablixRegions.map((t) => this.buildTablixXml(t, definition)).join('\n');
          maxBodyHeight = Math.max(
            1.0,
            ...definition.tablixRegions.map((t) => t.topIn + t.heightIn + 0.1)
          );
        }
      }

      const maxBodyWidth = Math.min(
        printableWidth,
        Math.max(
          printableWidth,
          ...definition.tablixRegions.map((t) => Math.min(printableWidth, t.leftIn + t.widthIn))
        )
      );

      const namespaceUrl =
        schemaVersion === '2008'
          ? 'http://schemas.microsoft.com/sqlserver/reporting/2008/01/reportdefinition'
          : 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition';

      const bodyAndPageXml =
        schemaVersion === '2008'
          ? `  <Body>
    <ReportItems>
${reportItemsXml}
    </ReportItems>
    <Height>${fmtSizeIn(maxBodyHeight, 1.0)}</Height>
    <Style />
  </Body>
  <Width>${fmtSizeIn(maxBodyWidth, 1.0)}</Width>
  <Page>
    <PageHeight>${fmtSizeIn(definition.pageHeightIn, 1.0)}</PageHeight>
    <PageWidth>${fmtSizeIn(definition.pageWidthIn, 1.0)}</PageWidth>
    <LeftMargin>${fmtPosIn(definition.marginsIn.left)}</LeftMargin>
    <RightMargin>${fmtPosIn(definition.marginsIn.right)}</RightMargin>
    <TopMargin>${fmtPosIn(definition.marginsIn.top)}</TopMargin>
    <BottomMargin>${fmtPosIn(definition.marginsIn.bottom)}</BottomMargin>
    <Style />
  </Page>`
          : `  <ReportSections>
    <ReportSection>
      <Body>
        <ReportItems>
${reportItemsXml}
        </ReportItems>
        <Height>${fmtSizeIn(maxBodyHeight, 1.0)}</Height>
        <Style />
      </Body>
      <Width>${fmtSizeIn(maxBodyWidth, 1.0)}</Width>
      <Page>
        <PageHeight>${fmtSizeIn(definition.pageHeightIn, 1.0)}</PageHeight>
        <PageWidth>${fmtSizeIn(definition.pageWidthIn, 1.0)}</PageWidth>
        <LeftMargin>${fmtPosIn(definition.marginsIn.left)}</LeftMargin>
        <RightMargin>${fmtPosIn(definition.marginsIn.right)}</RightMargin>
        <TopMargin>${fmtPosIn(definition.marginsIn.top)}</TopMargin>
        <BottomMargin>${fmtPosIn(definition.marginsIn.bottom)}</BottomMargin>
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

  private buildVisualPageContainerXml(
    vp: VisualPageLayer,
    idx: number,
    totalPages: number,
    containerHeight: number,
    printableWidth: number,
    definition: ReportDefinition
  ): string {
    const chunks: string[] = [];
    for (const r of vp.rectangles) chunks.push(this.buildVisualRectXml(r));
    for (const t of vp.tablixes) chunks.push(this.buildTablixXml(t, definition));
    for (const img of vp.images) chunks.push(this.buildVisualImageXml(img));
    for (const tb of vp.textboxes) chunks.push(this.buildVisualTextboxXml(tb));

    const innerXml = chunks.join('\n');
    const pageBreakXml =
      idx < totalPages - 1
        ? '\n            <PageBreak><BreakLocation>End</BreakLocation></PageBreak>'
        : '';
    const containerTop = Math.round(idx * containerHeight * 1000) / 1000;

    return `          <Rectangle Name="PageContainer_P${vp.pageNumber}">
            <ReportItems>
${innerXml}
            </ReportItems>
            <KeepTogether>false</KeepTogether>${pageBreakXml}
            <Top>${fmtPosIn(containerTop)}</Top>
            <Left>0in</Left>
            <Height>${fmtSizeIn(containerHeight, 0.5)}</Height>
            <Width>${fmtSizeIn(printableWidth, 0.5)}</Width>
            <Style>
              <Border><Style>None</Style></Border>
            </Style>
          </Rectangle>`;
  }

  private buildVisualRectXml(rect: VisualRectItem): string {
    const borderXml = rect.borderColor
      ? `<Border>
                <Color>${escapeXml(rect.borderColor)}</Color>
                <Style>Solid</Style>
                <Width>${Math.max(0.5, rect.borderWidthPt ?? 0.75)}pt</Width>
              </Border>`
      : `<Border>
                <Style>None</Style>
              </Border>`;
    const bgXml = rect.backgroundColor
      ? `\n              <BackgroundColor>${escapeXml(rect.backgroundColor)}</BackgroundColor>`
      : '';
    return `            <Rectangle Name="${escapeXml(rect.name)}">
              <Top>${fmtPosIn(rect.topIn)}</Top>
              <Left>${fmtPosIn(rect.leftIn)}</Left>
              <Height>${fmtSizeIn(rect.heightIn, 0.014)}</Height>
              <Width>${fmtSizeIn(rect.widthIn, 0.014)}</Width>
              <Style>
                ${borderXml}${bgXml}
              </Style>
            </Rectangle>`;
  }

  private buildVisualImageXml(img: VisualImageItem): string {
    return `            <Image Name="${escapeXml(img.name)}">
              <Source>Embedded</Source>
              <Value>${escapeXml(img.embeddedImageName)}</Value>
              <Sizing>${img.sizing}</Sizing>
              <Top>${fmtPosIn(img.topIn)}</Top>
              <Left>${fmtPosIn(img.leftIn)}</Left>
              <Height>${fmtSizeIn(img.heightIn, 0.05)}</Height>
              <Width>${fmtSizeIn(img.widthIn, 0.05)}</Width>
              <Style>
                <Border>
                  <Style>None</Style>
                </Border>
              </Style>
            </Image>`;
  }

  private buildVisualTextboxXml(tb: VisualTextboxItem): string {
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
      ? `\n              <BackgroundColor>${escapeXml(st.backgroundColor)}</BackgroundColor>`
      : '';

    return `            <Textbox Name="${escapeXml(tb.name)}">
              <CanGrow>true</CanGrow>
              <KeepTogether>true</KeepTogether>
              <Paragraphs>
                <Paragraph>
                  <TextRuns>
                    <TextRun>
                      <Value>${escapeXml(tb.text)}</Value>
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
              <Top>${fmtPosIn(tb.topIn)}</Top>
              <Left>${fmtPosIn(tb.leftIn)}</Left>
              <Height>${fmtSizeIn(tb.heightIn, 0.08)}</Height>
              <Width>${fmtSizeIn(tb.widthIn, 0.08)}</Width>
              <Style>
                ${borderXml}${bgXml}
                <VerticalAlign>${st.verticalAlign}</VerticalAlign>
                <PaddingLeft>${st.paddingPt.left}pt</PaddingLeft>
                <PaddingRight>${st.paddingPt.right}pt</PaddingRight>
                <PaddingTop>${st.paddingPt.top}pt</PaddingTop>
                <PaddingBottom>${st.paddingPt.bottom}pt</PaddingBottom>
              </Style>
            </Textbox>`;
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
            <Top>${fmtPosIn(tablix.topIn)}</Top>
            <Left>${fmtPosIn(tablix.leftIn)}</Left>
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
