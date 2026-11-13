import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const PT_PER_INCH = 72;

export async function buildProposalTemplatePdfA(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageW = 8.5 * PT_PER_INCH;
  const pageH = 11 * PT_PER_INCH;
  const yFromTop = (topIn: number) => pageH - topIn * PT_PER_INCH;

  // Page 1: Executive Guard Advantage (EGA) Template
  const p1 = pdfDoc.addPage([pageW, pageH]);
  p1.drawRectangle({
    x: 0.45 * PT_PER_INCH,
    y: yFromTop(1.05),
    width: 7.6 * PT_PER_INCH,
    height: 0.65 * PT_PER_INCH,
    color: rgb(0.06, 0.11, 0.2),
  });
  p1.drawText('EXECUTIVE GUARD ADVANTAGE (EGA) — PROPOSAL TEMPLATE', {
    x: 0.6 * PT_PER_INCH,
    y: yFromTop(0.75),
    size: 13,
    font: helveticaBold,
    color: rgb(1, 1, 1),
  });
  p1.drawText('Product Code: EGA | Plan Code: EGA-EXEC-2026', {
    x: 0.6 * PT_PER_INCH,
    y: yFromTop(0.95),
    size: 9,
    font: helvetica,
    color: rgb(0.8, 0.87, 0.96),
  });

  // Section 1: Coverage Summary
  p1.drawText('Coverage Summary', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(1.45),
    size: 12,
    font: helveticaBold,
    color: rgb(0.08, 0.12, 0.2),
  });
  p1.drawRectangle({
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(2.55),
    width: 7.5 * PT_PER_INCH,
    height: 0.95 * PT_PER_INCH,
    color: rgb(0.97, 0.98, 0.99),
    borderColor: rgb(0.8, 0.84, 0.89),
    borderWidth: 1,
  });
  p1.drawText('Policy Holder Name: <PolicyHolderName>', {
    x: 0.65 * PT_PER_INCH,
    y: yFromTop(1.85),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p1.drawText('Sum Assured: <SumAssured>', {
    x: 0.65 * PT_PER_INCH,
    y: yFromTop(2.12),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p1.drawText('Executive Rider Status: <ExecutiveRiderStatus>', {
    x: 4.3 * PT_PER_INCH,
    y: yFromTop(1.85),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p1.drawText('Waiver of Premium: <WaiverStatus>', {
    x: 4.3 * PT_PER_INCH,
    y: yFromTop(2.12),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });

  // Section 2: Benefit Schedule
  p1.drawText('Benefit Schedule', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(2.95),
    size: 12,
    font: helveticaBold,
    color: rgb(0.08, 0.12, 0.2),
  });

  const cols = [0.5, 3.2, 5.2, 6.6];
  const headers = ['Benefit Component', 'Coverage Tier', 'Annual Premium', 'Status'];
  p1.drawRectangle({
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(3.38),
    width: 7.5 * PT_PER_INCH,
    height: 0.28 * PT_PER_INCH,
    color: rgb(0.9, 0.93, 0.97),
  });
  headers.forEach((h, idx) => {
    p1.drawText(h, {
      x: (cols[idx] + 0.08) * PT_PER_INCH,
      y: yFromTop(3.29),
      size: 9.5,
      font: helveticaBold,
      color: rgb(0.08, 0.12, 0.2),
    });
  });

  const rows = [
    ['Core Executive Life', 'Premier', '<AnnualPremium>', 'Included'],
    ['Critical Illness Accelerator', 'Plus', '<CriticalIllnessPremium>', 'Optional'],
    ['Global Evacuation Rider', 'Executive', '<EvacRiderFee>', 'Waived'],
  ];
  rows.forEach((r, rIdx) => {
    const topY = 3.68 + rIdx * 0.34;
    p1.drawRectangle({
      x: 0.5 * PT_PER_INCH,
      y: yFromTop(topY + 0.08),
      width: 7.5 * PT_PER_INCH,
      height: 0.3 * PT_PER_INCH,
      borderColor: rgb(0.86, 0.89, 0.93),
      borderWidth: 0.75,
    });
    r.forEach((cell, cIdx) => {
      p1.drawText(cell, {
        x: (cols[cIdx] + 0.08) * PT_PER_INCH,
        y: yFromTop(topY),
        size: 9,
        font: helvetica,
        color: rgb(0.18, 0.22, 0.3),
      });
    });
  });

  // New Section added in PDF A (not in MFA benchmark)
  p1.drawText('Executive Wellness Concierge Benefit', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(5.1),
    size: 12,
    font: helveticaBold,
    color: rgb(0.08, 0.12, 0.2),
  });
  p1.drawText('Provides annual executive health screening and dedicated medical second-opinion routing.', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(5.38),
    size: 9.5,
    font: helvetica,
    color: rgb(0.25, 0.3, 0.38),
  });

  // Footer
  p1.drawText('EGA Proposal Illustration — Confidential Template Page 1 of 2', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(10.3),
    size: 8.5,
    font: helvetica,
    color: rgb(0.45, 0.5, 0.58),
  });

  // Page 2: Cash Value & Disclosures
  const p2 = pdfDoc.addPage([pageW, pageH]);
  p2.drawText('Policy Projection & Regulatory Disclosures', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(0.85),
    size: 13,
    font: helveticaBold,
    color: rgb(0.08, 0.12, 0.2),
  });
  p2.drawText('Projected Year 10 Cash Value: <ProjectedCashValue>', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(1.35),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p2.drawText('EGA Proposal Illustration — Confidential Template Page 2 of 2', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(10.3),
    size: 8.5,
    font: helvetica,
    color: rgb(0.45, 0.5, 0.58),
  });

  return pdfDoc.save();
}

export async function buildReferenceSystemPdfB(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageW = 8.5 * PT_PER_INCH;
  const pageH = 11 * PT_PER_INCH;
  const yFromTop = (topIn: number) => pageH - topIn * PT_PER_INCH;

  const p1 = pdfDoc.addPage([pageW, pageH]);
  p1.drawRectangle({
    x: 0.45 * PT_PER_INCH,
    y: yFromTop(1.05),
    width: 7.6 * PT_PER_INCH,
    height: 0.65 * PT_PER_INCH,
    color: rgb(0.06, 0.11, 0.2),
  });
  p1.drawText('GENERATED PROPOSAL SUMMARY — EXISTING SYSTEM REFERENCE', {
    x: 0.6 * PT_PER_INCH,
    y: yFromTop(0.75),
    size: 13,
    font: helveticaBold,
    color: rgb(1, 1, 1),
  });

  p1.drawText('Coverage Summary', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(1.45),
    size: 12,
    font: helveticaBold,
    color: rgb(0.08, 0.12, 0.2),
  });

  p1.drawText('Policy Holder Name: Jordan Alexander Mercer', {
    x: 0.65 * PT_PER_INCH,
    y: yFromTop(1.85),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p1.drawText('Sum Assured: $750,000.00', {
    x: 0.65 * PT_PER_INCH,
    y: yFromTop(2.12),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p1.drawText('Executive Rider Status: Included', {
    x: 4.3 * PT_PER_INCH,
    y: yFromTop(1.85),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p1.drawText('Waiver of Premium: Waived', {
    x: 4.3 * PT_PER_INCH,
    y: yFromTop(2.12),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });

  p1.drawText('Annual Premium:', {
    x: 0.65 * PT_PER_INCH,
    y: yFromTop(2.42),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p1.drawText('$4,280.00', {
    x: 2.0 * PT_PER_INCH,
    y: yFromTop(2.42),
    size: 10,
    font: helveticaBold,
    color: rgb(0.1, 0.16, 0.25),
  });

  p1.drawText('Effective Date: 2026-04-01', {
    x: 4.3 * PT_PER_INCH,
    y: yFromTop(2.42),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });

  // Page 2
  const p2 = pdfDoc.addPage([pageW, pageH]);
  p2.drawText('Projected Cash Value: $89,450.00', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(1.35),
    size: 10,
    font: helvetica,
    color: rgb(0.15, 0.2, 0.28),
  });
  p2.drawText('Reference System Output — Page 2 of 2', {
    x: 0.5 * PT_PER_INCH,
    y: yFromTop(10.3),
    size: 8.5,
    font: helvetica,
    color: rgb(0.45, 0.5, 0.58),
  });

  return pdfDoc.save();
}
