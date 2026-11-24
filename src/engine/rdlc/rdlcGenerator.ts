import crypto from 'crypto';
import {
  RdlcBandContainerSpec,
  RegionStyle,
  ReportDefinition,
  ReportGenError,
  ReportGenErrorCode,
  StructuredLogger,
  TablixCell,
  TablixRegion,
  VisualImageItem,
  VisualPageLayer,
  VisualParagraphSpec,
  VisualRectItem,
  VisualTextboxItem,
  VisualTextRun,
} from '../core/types.ts';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function deterministicUuid(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const CM_PER_INCH = 2.54;

function fmtIn(inches: number): string {
  return `${Math.max(0.05, Math.round(inches * 1000) / 1000)}in`;
}

function fmtPosIn(inches: number): string {
  return `${Math.max(0, Math.round(inches * 1000) / 1000)}in`;
}

function fmtSizeIn(inches: number, min = 0.014): string {
  return `${Math.max(min, Math.round(inches * 1000) / 1000)}in`;
}

function fmtPosCm(inches: number): string {
  const cm = Math.max(0, inches * CM_PER_INCH);
  return `${(Math.round(cm * 10000) / 10000).toFixed(4)}cm`;
}

function fmtSizeCm(inches: number, minCm = 0.0353): string {
  const cm = Math.max(minCm, inches * CM_PER_INCH);
  return `${(Math.round(cm * 10000) / 10000).toFixed(4)}cm`;
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
      const useCm = schemaVersion === '2016';
      const fmtPos = (valIn: number) => (useCm ? fmtPosCm(valIn) : fmtPosIn(valIn));
      const fmtSz = (valIn: number, minIn = 0.014) =>
        useCm ? fmtSizeCm(valIn, minIn * CM_PER_INCH) : fmtSizeIn(valIn, minIn);

      const structureSeed = `${definition.reportName}|${definition.dataSourceName}|${definition.dataSetName}|${schemaVersion}|${definition.pageWidthIn}x${definition.pageHeightIn}|${definition.fields.map((f) => f.name).join(',')}`;
      const dataSourceId = deterministicUuid(`ds::${structureSeed}`);
      const reportId = deterministicUuid(`rpt::${structureSeed}`);

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
      const bodyTablixes = schemaVersion === '2016' ? definition.bodyTablixes : undefined;
      const bodySections = schemaVersion === '2016' ? definition.bodySections : undefined;
      const visualPages = definition.visualPages;

      if (bodyTablixes && bodyTablixes.length > 0) {
        reportItemsXml = bodyTablixes
          .map((t) => this.buildTablixXml(t, definition, fmtPos, fmtSz, false))
          .join('\n');
        maxBodyHeight = Math.max(
          1.0,
          ...bodyTablixes.map((t) => t.topIn + t.heightIn)
        );
      } else if (bodySections && bodySections.length > 0) {
        reportItemsXml = bodySections
          .map((sec) => this.buildVisualRectTreeXml(sec, definition, fmtPos, fmtSz, '          '))
          .join('\n');
        maxBodyHeight = Math.max(
          1.0,
          ...bodySections.map((s) => s.topIn + s.heightIn)
        );
      } else if (visualPages && visualPages.length > 0) {
        const containerHeight =
          definition.marginsIn.top === 0 && definition.marginsIn.bottom === 0
            ? printableHeight
            : Math.max(1.0, printableHeight - 0.02);
        reportItemsXml = visualPages
          .map((vp, idx) =>
            this.buildVisualPageContainerXml(
              vp,
              idx,
              containerHeight,
              printableWidth,
              definition,
              useCm,
              fmtPos,
              fmtSz
            )
          )
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
                  return this.buildTablixXml({ ...t, topIn: pageRelativeTop }, definition, fmtPos, fmtSz);
                })
                .join('\n');
              const pageBreakXml =
                idx > 0
                  ? '\n            <PageBreak><BreakLocation>Start</BreakLocation></PageBreak>'
                  : '';
              const containerTop = Math.round(idx * containerHeight * 1000) / 1000;
              return `          <Rectangle Name="PageContainer_P${pageNum}">
            <ReportItems>
${innerXml}
            </ReportItems>
            <KeepTogether>false</KeepTogether>${pageBreakXml}
            <Top>${fmtPos(containerTop)}</Top>
            <Left>${useCm ? '0.0000cm' : '0in'}</Left>
            <Height>${fmtSz(containerHeight, 0.5)}</Height>
            <Width>${fmtSz(printableWidth, 0.5)}</Width>
            <Style>
              <Border><Style>None</Style></Border>
            </Style>
          </Rectangle>`;
            })
            .join('\n');
          maxBodyHeight = Math.max(containerHeight, sortedPages.length * containerHeight);
        } else {
          reportItemsXml = definition.tablixRegions
            .map((t) => this.buildTablixXml(t, definition, fmtPos, fmtSz))
            .join('\n');
          maxBodyHeight = Math.max(
            1.0,
            ...definition.tablixRegions.map((t) => t.topIn + t.heightIn + 0.1)
          );
        }
      }

      const pageHeaderXml =
        schemaVersion === '2016' && definition.pageHeaderSpec
          ? this.buildChromeBandXml('PageHeader', definition.pageHeaderSpec, definition, fmtPos, fmtSz)
          : '';
      const pageFooterXml =
        schemaVersion === '2016' && definition.pageFooterSpec
          ? this.buildChromeBandXml('PageFooter', definition.pageFooterSpec, definition, fmtPos, fmtSz)
          : '';

      const maxBodyWidth = printableWidth;
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
    <Height>${fmtSz(maxBodyHeight, 1.0)}</Height>
    <Style />
  </Body>
  <Width>${fmtSz(maxBodyWidth, 1.0)}</Width>
  <Page>
    <PageHeight>${fmtSz(definition.pageHeightIn, 1.0)}</PageHeight>
    <PageWidth>${fmtSz(definition.pageWidthIn, 1.0)}</PageWidth>
    <LeftMargin>${fmtPos(definition.marginsIn.left)}</LeftMargin>
    <RightMargin>${fmtPos(definition.marginsIn.right)}</RightMargin>
    <TopMargin>${fmtPos(definition.marginsIn.top)}</TopMargin>
    <BottomMargin>${fmtPos(definition.marginsIn.bottom)}</BottomMargin>
    <Style />
  </Page>`
          : `  <ReportSections>
    <ReportSection>
      <Body>
        <ReportItems>
${reportItemsXml}
        </ReportItems>
        <Height>${fmtSz(maxBodyHeight, 1.0)}</Height>
        <Style />
      </Body>
      <Width>${fmtSz(maxBodyWidth, 1.0)}</Width>
      <Page>
${pageHeaderXml}${pageFooterXml}        <PageHeight>${fmtSz(definition.pageHeightIn, 1.0)}</PageHeight>
        <PageWidth>${fmtSz(definition.pageWidthIn, 1.0)}</PageWidth>
        <LeftMargin>${fmtPos(definition.marginsIn.left)}</LeftMargin>
        <RightMargin>${fmtPos(definition.marginsIn.right)}</RightMargin>
        <TopMargin>${fmtPos(definition.marginsIn.top)}</TopMargin>
        <BottomMargin>${fmtPos(definition.marginsIn.bottom)}</BottomMargin>
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
  <rd:ReportUnitType>${useCm ? 'Cm' : 'Inch'}</rd:ReportUnitType>
  <rd:ReportID>${reportId}</rd:ReportID>
</Report>
`;

      this.logger.info('RdlcGenerator', `RDLC ${schemaVersion} generated deterministically`, {
        schemaVersion,
        unitType: useCm ? 'Cm' : 'Inch',
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
      .map((p) => {
        const defaultXml =
          p.defaultValue !== undefined
            ? `\n      <DefaultValue>
        <Values>
          <Value>${escapeXml(p.defaultValue)}</Value>
        </Values>
      </DefaultValue>`
            : '';
        return `    <ReportParameter Name="${escapeXml(p.name)}">
      <DataType>${escapeXml(p.dataType)}</DataType>
      <Nullable>true</Nullable>
      <AllowBlank>true</AllowBlank>${defaultXml}
      <Prompt>${escapeXml(p.prompt)}</Prompt>
    </ReportParameter>`;
      })
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

  private buildChromeBandXml(
    tagName: 'PageHeader' | 'PageFooter',
    spec: RdlcBandContainerSpec,
    definition: ReportDefinition,
    fmtPos: (val: number) => string,
    fmtSz: (val: number, min?: number) => string
  ): string {
    const chunks: string[] = [];
    for (const r of spec.rectangles) {
      chunks.push(this.buildVisualRectTreeXml(r, definition, fmtPos, fmtSz, '            '));
    }
    for (const img of spec.images) {
      chunks.push(this.buildVisualImageXml(img, fmtPos, fmtSz));
    }
    for (const t of spec.tablixes) {
      chunks.push(this.buildTablixXml(t, definition, fmtPos, fmtSz));
    }
    for (const tb of spec.textboxes) {
      chunks.push(this.buildVisualTextboxXml(tb, fmtPos, fmtSz));
    }

    const itemsXml = chunks.join('\n');
    return `        <${tagName}>
          <Height>${fmtSz(spec.heightIn, 0.12)}</Height>
          <PrintOnFirstPage>${spec.printOnFirstPage !== false ? 'true' : 'false'}</PrintOnFirstPage>
          <PrintOnLastPage>${spec.printOnLastPage !== false ? 'true' : 'false'}</PrintOnLastPage>
          <ReportItems>
${itemsXml}
          </ReportItems>
          <Style>
            <Border><Style>None</Style></Border>
          </Style>
        </${tagName}>\n`;
  }

  private buildVisualPageContainerXml(
    vp: VisualPageLayer,
    idx: number,
    containerHeight: number,
    printableWidth: number,
    definition: ReportDefinition,
    useCm: boolean,
    fmtPos: (val: number) => string,
    fmtSz: (val: number, min?: number) => string
  ): string {
    const chunks: string[] = [];
    for (const r of vp.rectangles) chunks.push(this.buildVisualRectXml(r, fmtPos, fmtSz));
    for (const img of vp.images) chunks.push(this.buildVisualImageXml(img, fmtPos, fmtSz));
    for (const t of vp.tablixes) chunks.push(this.buildTablixXml(t, definition, fmtPos, fmtSz));
    for (const tb of vp.textboxes) chunks.push(this.buildVisualTextboxXml(tb, fmtPos, fmtSz));

    const innerXml = chunks.join('\n');
    const pageBreakXml =
      idx > 0
        ? '\n            <PageBreak><BreakLocation>Start</BreakLocation></PageBreak>'
        : '';
    const containerTop = idx * containerHeight;

    return `          <Rectangle Name="PageContainer_P${vp.pageNumber}">
            <ReportItems>
${innerXml}
            </ReportItems>
            <KeepTogether>false</KeepTogether>${pageBreakXml}
            <Top>${fmtPos(containerTop)}</Top>
            <Left>${useCm ? '0.0000cm' : '0in'}</Left>
            <Height>${fmtSz(containerHeight, 0.5)}</Height>
            <Width>${fmtSz(printableWidth, 0.5)}</Width>
            <Style>
              <Border><Style>None</Style></Border>
            </Style>
          </Rectangle>`;
  }

  private buildVisualRectTreeXml(
    rect: VisualRectItem,
    definition: ReportDefinition,
    fmtPos: (val: number) => string,
    fmtSz: (val: number, min?: number) => string,
    indent = '            '
  ): string {
    const borderXml = rect.borderColor
      ? `<Border>
${indent}    <Color>${escapeXml(rect.borderColor)}</Color>
${indent}    <Style>Solid</Style>
${indent}    <Width>${Math.max(0.5, rect.borderWidthPt ?? 0.75)}pt</Width>
${indent}  </Border>`
      : `<Border>
${indent}    <Style>None</Style>
${indent}  </Border>`;
    const bgXml = rect.backgroundColor
      ? `\n${indent}  <BackgroundColor>${escapeXml(rect.backgroundColor)}</BackgroundColor>`
      : '';
    const zIndexXml = rect.zIndex !== undefined ? `\n${indent}  <ZIndex>${rect.zIndex}</ZIndex>` : '';
    const keepTogetherXml =
      rect.keepTogether !== undefined
        ? `\n${indent}  <KeepTogether>${rect.keepTogether ? 'true' : 'false'}</KeepTogether>`
        : '';
    const pageBreakXml = rect.pageBreakLocation
      ? `\n${indent}  <PageBreak><BreakLocation>${rect.pageBreakLocation}</BreakLocation></PageBreak>`
      : '';

    let reportItemsXml = '';
    if (rect.children) {
      const childChunks: string[] = [];
      for (const r of rect.children.rectangles) {
        childChunks.push(this.buildVisualRectTreeXml(r, definition, fmtPos, fmtSz, `${indent}    `));
      }
      for (const img of rect.children.images) {
        childChunks.push(this.buildVisualImageXml(img, fmtPos, fmtSz));
      }
      for (const t of rect.children.tablixes) {
        childChunks.push(this.buildTablixXml(t, definition, fmtPos, fmtSz));
      }
      for (const tb of rect.children.textboxes) {
        childChunks.push(this.buildVisualTextboxXml(tb, fmtPos, fmtSz));
      }
      reportItemsXml = `\n${indent}  <ReportItems>\n${childChunks.join('\n')}\n${indent}  </ReportItems>`;
    }

    const minDim = rect.role === 'line' ? 0.005 : 0.014;
    return `${indent}<Rectangle Name="${escapeXml(rect.name)}">${reportItemsXml}${keepTogetherXml}${pageBreakXml}
${indent}  <Top>${fmtPos(rect.topIn)}</Top>
${indent}  <Left>${fmtPos(rect.leftIn)}</Left>
${indent}  <Height>${fmtSz(rect.heightIn, minDim)}</Height>
${indent}  <Width>${fmtSz(rect.widthIn, minDim)}</Width>${zIndexXml}
${indent}  <Style>
${indent}    ${borderXml}${bgXml}
${indent}  </Style>
${indent}</Rectangle>`;
  }

  private buildVisualRectXml(
    rect: VisualRectItem,
    fmtPos: (val: number) => string,
    fmtSz: (val: number, min?: number) => string
  ): string {
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
    const zIndexXml = rect.zIndex !== undefined ? `\n              <ZIndex>${rect.zIndex}</ZIndex>` : '';
    const minDim = rect.role === 'line' ? 0.005 : 0.014;
    return `            <Rectangle Name="${escapeXml(rect.name)}">
              <Top>${fmtPos(rect.topIn)}</Top>
              <Left>${fmtPos(rect.leftIn)}</Left>
              <Height>${fmtSz(rect.heightIn, minDim)}</Height>
              <Width>${fmtSz(rect.widthIn, minDim)}</Width>${zIndexXml}
              <Style>
                ${borderXml}${bgXml}
              </Style>
            </Rectangle>`;
  }

  private buildVisualImageXml(
    img: VisualImageItem,
    fmtPos: (val: number) => string,
    fmtSz: (val: number, min?: number) => string
  ): string {
    const zIndexXml = img.zIndex !== undefined ? `\n              <ZIndex>${img.zIndex}</ZIndex>` : '';
    return `            <Image Name="${escapeXml(img.name)}">
              <Source>Embedded</Source>
              <Value>${escapeXml(img.embeddedImageName)}</Value>
              <Sizing>${img.sizing}</Sizing>
              <Top>${fmtPos(img.topIn)}</Top>
              <Left>${fmtPos(img.leftIn)}</Left>
              <Height>${fmtSz(img.heightIn, 0.05)}</Height>
              <Width>${fmtSz(img.widthIn, 0.05)}</Width>${zIndexXml}
              <Style>
                <Border>
                  <Style>None</Style>
                </Border>
              </Style>
            </Image>`;
  }

  private buildTextRunsXml(
    runs: VisualTextRun[] | undefined,
    fallbackValue: string,
    fallbackStyle: RegionStyle,
    indent = '                    '
  ): string {
    const effectiveRuns: VisualTextRun[] =
      runs && runs.length > 0
        ? runs
        : [
            {
              text: fallbackValue,
              fontFamily: fallbackStyle.fontFamily,
              fontSizePt: fallbackStyle.fontSizePt,
              bold: fallbackStyle.bold,
              italic: fallbackStyle.italic,
              underline: fallbackStyle.underline,
              color: fallbackStyle.color,
            },
          ];

    return effectiveRuns
      .map((run) => {
        const val = run.parameterName
          ? `=Parameters!${escapeXml(run.parameterName)}.Value`
          : escapeXml(run.text);
        const underlineTag = run.underline
          ? `\n${indent}    <TextDecoration>Underline</TextDecoration>`
          : '';
        return `${indent}<TextRun>
${indent}  <Value>${val}</Value>
${indent}  <Style>
${indent}    <FontFamily>${escapeXml(run.fontFamily)}</FontFamily>
${indent}    <FontSize>${run.fontSizePt}pt</FontSize>
${indent}    <FontWeight>${run.bold ? 'Bold' : 'Normal'}</FontWeight>
${indent}    <FontStyle>${run.italic ? 'Italic' : 'Normal'}</FontStyle>${underlineTag}
${indent}    <Color>${escapeXml(run.color)}</Color>
${indent}  </Style>
${indent}</TextRun>`;
      })
      .join('\n');
  }

  private buildParagraphsXml(tb: VisualTextboxItem): string {
    const st = tb.style;
    const paras: VisualParagraphSpec[] =
      tb.paragraphLines && tb.paragraphLines.length > 0
        ? tb.paragraphLines
        : [
            {
              runs: tb.runs ?? [],
              lineHeightPt: st.lineHeightPt,
              textAlign: st.textAlign,
            },
          ];

    return paras
      .map((pLine, idx) => {
        const runsXml = this.buildTextRunsXml(
          pLine.runs.length > 0 ? pLine.runs : idx === 0 ? tb.runs : undefined,
          idx === 0 ? tb.text : '',
          st,
          '                    '
        );
        const lh = pLine.lineHeightPt ?? st.lineHeightPt;
        const lhXml = lh && lh > 0 ? `\n                    <LineHeight>${lh}pt</LineHeight>` : '';
        return `                <Paragraph>
                  <TextRuns>
${runsXml}
                  </TextRuns>
                  <Style>
                    <TextAlign>${pLine.textAlign ?? st.textAlign}</TextAlign>${lhXml}
                  </Style>
                </Paragraph>`;
      })
      .join('\n');
  }

  private buildVisualTextboxXml(
    tb: VisualTextboxItem,
    fmtPos: (val: number) => string,
    fmtSz: (val: number, min?: number) => string
  ): string {
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
    const zIndexXml = tb.zIndex !== undefined ? `\n              <ZIndex>${tb.zIndex}</ZIndex>` : '';
    const paragraphsXml = this.buildParagraphsXml(tb);
    const canGrowVal = tb.canGrow === undefined ? 'true' : tb.canGrow ? 'true' : 'false';

    return `            <Textbox Name="${escapeXml(tb.name)}">
              <CanGrow>${canGrowVal}</CanGrow>
              <KeepTogether>true</KeepTogether>
              <Paragraphs>
${paragraphsXml}
              </Paragraphs>
              <Top>${fmtPos(tb.topIn)}</Top>
              <Left>${fmtPos(tb.leftIn)}</Left>
              <Height>${fmtSz(tb.heightIn, 0.08)}</Height>
              <Width>${fmtSz(tb.widthIn, 0.08)}</Width>${zIndexXml}
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

  private buildTablixXml(
    tablix: TablixRegion,
    definition: ReportDefinition,
    fmtPos: (val: number) => string = fmtPosIn,
    fmtSz: (val: number, min?: number) => string = fmtIn,
    nested = false
  ): string {
    const columnsXml = tablix.columnWidthsIn
      .map(
        (w) => `              <TablixColumn>
                <Width>${fmtSz(w, 0.05)}</Width>
              </TablixColumn>`
      )
      .join('\n');

    const colMembersXml = tablix.columnWidthsIn
      .map(() => `              <TablixMember />`)
      .join('\n');

    const rowsXml = tablix.rows
      .map((row) => {
        const cellsXml = row.cells
          .map((cell) => this.buildCellXml(cell, definition, fmtPos, fmtSz))
          .join('\n');
        return `              <TablixRow>
                <Height>${fmtSz(row.heightIn, 0.05)}</Height>
                <TablixCells>
${cellsXml}
                </TablixCells>
              </TablixRow>`;
      })
      .join('\n');

    const rowMembersXml = tablix.rows
      .map((row, idx) => {
        const memberPb =
          idx > 0 && row.pageBreakBefore
            ? '\n                <PageBreak><BreakLocation>Start</BreakLocation></PageBreak>'
            : '';
        if (tablix.isRepeatingDetail && row.isDetailRow) {
          return `              <TablixMember>${memberPb}
                <Group Name="Details_${escapeXml(tablix.name)}_${idx}" />
              </TablixMember>`;
        }
        return `              <TablixMember>${memberPb}
                <KeepWithGroup>After</KeepWithGroup>
              </TablixMember>`;
      })
      .join('\n');

    const zIndexXml = !nested && tablix.zIndex !== undefined ? `\n            <ZIndex>${tablix.zIndex}</ZIndex>` : '';
    const keepTogetherXml =
      tablix.keepTogether !== undefined
        ? `\n            <KeepTogether>${tablix.keepTogether ? 'true' : 'false'}</KeepTogether>`
        : '';
    const pageBreakXml =
      !nested && tablix.pageBreakBefore
        ? '\n            <PageBreak><BreakLocation>Start</BreakLocation></PageBreak>'
        : '';
    const posXml = nested
      ? `\n            <Height>${fmtSz(tablix.heightIn, 0.05)}</Height>\n            <Width>${fmtSz(tablix.widthIn, 0.05)}</Width>`
      : `\n            <Top>${fmtPos(tablix.topIn)}</Top>\n            <Left>${fmtPos(tablix.leftIn)}</Left>\n            <Height>${fmtSz(tablix.heightIn, 0.05)}</Height>\n            <Width>${fmtSz(tablix.widthIn, 0.05)}</Width>`;

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
            <DataSetName>${escapeXml(tablix.dataSetName ?? definition.dataSetName)}</DataSetName>${keepTogetherXml}${pageBreakXml}${posXml}${zIndexXml}
            <Style>
              <Border>
                <Style>None</Style>
              </Border>
            </Style>
          </Tablix>`;
  }

  private buildCellXml(
    cell: TablixCell,
    definition: ReportDefinition,
    fmtPos: (val: number) => string = fmtPosIn,
    fmtSz: (val: number, min?: number) => string = fmtIn
  ): string {
    if (cell.skipBecauseMerged) {
      return `                  <TablixCell />`;
    }

    const colSpanTag = cell.colSpan > 1 ? `\n                        <ColSpan>${cell.colSpan}</ColSpan>` : '';
    const rowSpanTag = cell.rowSpan > 1 ? `\n                        <RowSpan>${cell.rowSpan}</RowSpan>` : '';

    if (cell.content.kind === 'Tablix') {
      const nestedXml = this.buildTablixXml(cell.content.tablix, definition, fmtPos, fmtSz, true);
      return `                  <TablixCell>
                    <CellContents>
${nestedXml}${colSpanTag}${rowSpanTag}
                    </CellContents>
                  </TablixCell>`;
    }

    if (cell.content.kind === 'Rectangle') {
      const rc = cell.content;
      const childChunks: string[] = [];
      for (const r of rc.rectangles) {
        childChunks.push(this.buildVisualRectTreeXml(r, definition, fmtPos, fmtSz, '                          '));
      }
      for (const img of rc.images) {
        childChunks.push(this.buildVisualImageXml(img, fmtPos, fmtSz));
      }
      for (const t of rc.tablixes) {
        childChunks.push(this.buildTablixXml(t, definition, fmtPos, fmtSz, false));
      }
      for (const tb of rc.textboxes) {
        childChunks.push(this.buildVisualTextboxXml(tb, fmtPos, fmtSz));
      }
      return `                  <TablixCell>
                    <CellContents>
                      <Rectangle Name="${escapeXml(rc.name)}">
                        <ReportItems>
${childChunks.join('\n')}
                        </ReportItems>
                        <Style>
                          <Border>
                            <Style>None</Style>
                          </Border>
                        </Style>
                      </Rectangle>${colSpanTag}${rowSpanTag}
                    </CellContents>
                  </TablixCell>`;
    }

    if (cell.content.kind === 'Image') {
      const matched = definition.embeddedImages.find(
        (img) => img.base64Data === (cell.content as { base64Data: string }).base64Data
      );
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
                        <Style>
                          <Border>
                            <Style>None</Style>
                          </Border>
                        </Style>
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

    const syntheticTb: VisualTextboxItem = {
      kind: 'Textbox',
      name: tb.name,
      leftIn: 0,
      topIn: 0,
      widthIn: 1,
      heightIn: 0.2,
      text: tb.value,
      runs: tb.runs,
      paragraphLines: tb.paragraphLines,
      style: st,
      canGrow: tb.canGrow,
    };
    const paragraphsXml = this.buildParagraphsXml(syntheticTb);

    return `                  <TablixCell>
                    <CellContents>
                      <Textbox Name="${escapeXml(tb.name)}">
                        <CanGrow>${tb.canGrow ? 'true' : 'false'}</CanGrow>
                        <KeepTogether>true</KeepTogether>
                        <Paragraphs>
${paragraphsXml}
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
