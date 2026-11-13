import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as XLSX from 'xlsx';

/**
 * Generates an automated multi-page verification PDF fixture (NOT a substitute for
 * a user-supplied Golden Sample, clearly labeled as Verification Fixture) containing
 * mixed layouts: header band, cards, multi-column metadata, repeating detail table,
 * timeline/vector illustration, numbered list, and footer.
 */
export async function buildVerificationFixturePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Page 1: Executive Header + Summary Cards + Key-Value Metadata + Repeating Table + Footer
  const p1 = doc.addPage([612, 792]); // Letter 8.5 x 11 in
  p1.drawRectangle({ x: 36, y: 716, width: 540, height: 42, color: rgb(0.06, 0.09, 0.16) });
  p1.drawText('QUARTERLY FINANCIAL STATEMENT', { x: 50, y: 734, size: 14, font: fontBold, color: rgb(1, 1, 1) });
  p1.drawText('REF: INV-2026-0041', { x: 455, y: 736, size: 9.5, font: fontBold, color: rgb(0.8, 0.87, 0.96) });

  // Multi-column metadata info band
  p1.drawText('Customer:', { x: 36, y: 684, size: 9.5, font: fontBold, color: rgb(0.28, 0.33, 0.41) });
  p1.drawText('PT Nusantara Logistics', { x: 105, y: 684, size: 9.5, font: fontRegular, color: rgb(0.06, 0.09, 0.16) });
  p1.drawText('Billing Period:', { x: 320, y: 684, size: 9.5, font: fontBold, color: rgb(0.28, 0.33, 0.41) });
  p1.drawText('Q4 2026', { x: 405, y: 684, size: 9.5, font: fontRegular, color: rgb(0.06, 0.09, 0.16) });

  // 3 KPI Summary Cards (boxes)
  const cardData = [
    { title: 'Gross Revenue', val: '$1,240,000.00', x: 36 },
    { title: 'Total Discount', val: '$124,000.00', x: 222 },
    { title: 'Net Payable', val: '$1,116,000.00', x: 408 },
  ];
  for (const c of cardData) {
    p1.drawRectangle({
      x: c.x,
      y: 604,
      width: 168,
      height: 56,
      color: rgb(0.97, 0.98, 0.99),
      borderColor: rgb(0.8, 0.84, 0.88),
      borderWidth: 1,
    });
    p1.drawText(c.title, { x: c.x + 12, y: 640, size: 8.5, font: fontBold, color: rgb(0.39, 0.45, 0.54) });
    p1.drawText(c.val, { x: c.x + 12, y: 618, size: 12, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
  }

  // Detail Table
  const colsX = [36, 260, 330, 420, 505];
  const headers = ['Description', 'Qty', 'Price', 'Discount', 'LineTotal'];
  p1.drawRectangle({ x: 36, y: 554, width: 540, height: 24, color: rgb(0.93, 0.95, 0.97), borderColor: rgb(0.8, 0.84, 0.88), borderWidth: 0.75 });
  headers.forEach((h, i) => {
    p1.drawText(h, { x: colsX[i] + 6, y: 562, size: 9, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
  });

  const tableRows = [
    ['Enterprise Cloud License', '10', '100000.00', '10%', '900000.00'],
    ['Dedicated Audit Module', '4', '45000.00', '0%', '180000.00'],
    ['Compliance Connector Pack', '2', '20000.00', '10%', '36000.00'],
  ];
  tableRows.forEach((row, rIdx) => {
    const y = 528 - rIdx * 24;
    p1.drawRectangle({ x: 36, y, width: 540, height: 24, borderColor: rgb(0.88, 0.9, 0.94), borderWidth: 0.5 });
    row.forEach((cell, cIdx) => {
      p1.drawText(cell, { x: colsX[cIdx] + 6, y: y + 7, size: 9, font: fontRegular, color: rgb(0.12, 0.16, 0.23) });
    });
  });

  // Footer
  p1.drawLine({ start: { x: 36, y: 56 }, end: { x: 576, y: 56 }, thickness: 0.75, color: rgb(0.8, 0.84, 0.88) });
  p1.drawText('Page 1 — Generated Verification Fixture', { x: 36, y: 38, size: 8, font: fontRegular, color: rgb(0.45, 0.5, 0.58) });

  // Page 2: Timeline Illustration + Numbered Notes + Multi-column Narrative
  const p2 = doc.addPage([612, 792]);
  p2.drawText('IMPLEMENTATION TIMELINE & GOVERNANCE NOTES', { x: 36, y: 740, size: 13, font: fontBold, color: rgb(0.06, 0.09, 0.16) });

  // Horizontal Timeline Graphic
  p2.drawLine({ start: { x: 60, y: 650 }, end: { x: 540, y: 650 }, thickness: 2, color: rgb(0.15, 0.39, 0.92) });
  const steps = [
    { label: 'Phase 1: Extraction', x: 70 },
    { label: 'Phase 2: Grid & AI', x: 245 },
    { label: 'Phase 3: RDLC & VB', x: 425 },
  ];
  steps.forEach((st) => {
    p2.drawCircle({ x: st.x + 40, y: 650, size: 8, color: rgb(0.15, 0.39, 0.92) });
    p2.drawText(st.label, { x: st.x, y: 622, size: 9, font: fontBold, color: rgb(0.06, 0.09, 0.16) });
  });

  // Numbered list notes
  p2.drawText('1. All numeric totals are verified against the Finance Excel calculation oracle prior to release.', {
    x: 36,
    y: 540,
    size: 9.5,
    font: fontRegular,
    color: rgb(0.15, 0.2, 0.28),
  });
  p2.drawText('2. Non-tabular graphic regions preserve fidelity via Tablix embedded image cells when necessary.', {
    x: 36,
    y: 516,
    size: 9.5,
    font: fontRegular,
    color: rgb(0.15, 0.2, 0.28),
  });
  p2.drawText('Page 2 — Generated Verification Fixture', { x: 36, y: 38, size: 8, font: fontRegular, color: rgb(0.45, 0.5, 0.58) });

  return await doc.save();
}

export function buildVerificationFixtureExcel(): Buffer {
  const rows = [
    { Scenario: 'Enterprise Cloud 10% Discount', Qty: 10, Price: 100000, DiscountPercent: 10, ExpectedLineTotal: 900000, Tolerance: 0.01 },
    { Scenario: 'Dedicated Audit No Discount', Qty: 4, Price: 45000, DiscountPercent: 0, ExpectedLineTotal: 180000, Tolerance: 0.01 },
    { Scenario: 'Compliance Pack 10% Discount', Qty: 2, Price: 20000, DiscountPercent: 10, ExpectedLineTotal: 36000, Tolerance: 0.01 },
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'CalcOracle');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export const SAMPLE_EXISTING_VB = `Imports System
Imports System.Data

Namespace LegacyERP.Reports
    Public Class InvoiceReportBase
        Public Function CalculateLineTotal(ByVal qty As Decimal, ByVal price As Decimal, ByVal discountPercent As Decimal) As Decimal
            Return Math.Round((qty * price) * (1D - discountPercent / 100D), 2, MidpointRounding.AwayFromZero)
        End Function
    End Class
End Namespace
`;

export const SAMPLE_EXISTING_RDLC = `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition" xmlns:rd="http://schemas.microsoft.com/SQLServer/reporting/reportdesigner">
  <DataSources>
    <DataSource Name="dsLegacyERP">
      <ConnectionProperties><DataProvider>System.Data.DataSet</DataProvider><ConnectString /></ConnectionProperties>
    </DataSource>
  </DataSources>
  <DataSets>
    <DataSet Name="dsInvoiceLines">
      <Query><DataSourceName>dsLegacyERP</DataSourceName><CommandText /></Query>
      <Fields>
        <Field Name="Description"><DataField>Description</DataField></Field>
        <Field Name="Qty"><DataField>Qty</DataField></Field>
        <Field Name="Price"><DataField>Price</DataField></Field>
        <Field Name="Discount"><DataField>Discount</DataField></Field>
        <Field Name="LineTotal"><DataField>LineTotal</DataField></Field>
      </Fields>
    </DataSet>
  </DataSets>
  <ReportParameters>
    <ReportParameter Name="CompanyTitle"><DataType>String</DataType><Prompt>Company Title</Prompt></ReportParameter>
  </ReportParameters>
  <rd:ReportUnitType>Inch</rd:ReportUnitType>
</Report>
`;
