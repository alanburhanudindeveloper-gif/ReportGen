import { VectorFillBox, VectorHLine, VectorVLine } from '../core/types.ts';

export interface RgbaBuffer {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface TextBoxPt {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelGeometryResult {
  fillBanners: VectorFillBox[];
  fillBands: VectorFillBox[];
  fillBoxes: VectorFillBox[];
  hLines: VectorHLine[];
  vLines: VectorVLine[];
  hasPureWhiteGutter: (x0Pt: number, x1Pt: number, y0Pt: number, y1Pt: number) => boolean;
}

function rgbLuminance(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function isNearWhite(r: number, g: number, b: number): boolean {
  return r >= 245 && g >= 245 && b >= 245;
}

function colorDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return `#${c(r)}${c(g)}${c(b)}`;
}

function roundPt(val: number): number {
  return Math.round(val * 100) / 100;
}

export function scanPixelGeometry(
  rgba: RgbaBuffer,
  pageWidthPt: number,
  pageHeightPt: number,
  textBoxesPt: TextBoxPt[],
  printableWidthPt: number
): PixelGeometryResult {
  const w = rgba.width;
  const h = rgba.height;
  const src = rgba.data;
  const scaleX = w / Math.max(1, pageWidthPt);
  const scaleY = h / Math.max(1, pageHeightPt);

  // 1. Build 1pt-expanded vector text mask so pixel geometry sees ONLY fills, banners, and lines
  const textMask = new Uint8Array(w * h);
  const padPt = 1.0;
  for (const tb of textBoxesPt) {
    const px0 = Math.max(0, Math.floor((tb.x - padPt) * scaleX));
    const py0 = Math.max(0, Math.floor((tb.y - padPt) * scaleY));
    const px1 = Math.min(w, Math.ceil((tb.x + tb.width + padPt) * scaleX));
    const py1 = Math.min(h, Math.ceil((tb.y + tb.height + padPt) * scaleY));
    for (let py = py0; py < py1; py++) {
      const rowOff = py * w;
      for (let px = px0; px < px1; px++) {
        textMask[rowOff + px] = 1;
      }
    }
  }

  // 2. Build text-inpainted working RGB buffer (replace masked glyph pixels with local unmasked background RGB)
  const workRgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    workRgb[i * 3] = src[j];
    workRgb[i * 3 + 1] = src[j + 1];
    workRgb[i * 3 + 2] = src[j + 2];
  }

  for (let py = 0; py < h; py++) {
    const rowMaskOff = py * w;
    let px = 0;
    while (px < w) {
      if (textMask[rowMaskOff + px] === 0) {
        px++;
        continue;
      }
      const spanStart = px;
      while (px < w && textMask[rowMaskOff + px] === 1) px++;
      const spanEnd = px;

      // Sample nearest unmasked pixels immediately outside the text box span on the same scanline
      let lIdx = -1;
      for (let lx = spanStart - 1; lx >= Math.max(0, spanStart - 6); lx--) {
        if (textMask[rowMaskOff + lx] === 0) {
          lIdx = (rowMaskOff + lx) * 3;
          break;
        }
      }
      let rIdx = -1;
      for (let rx = spanEnd; rx < Math.min(w, spanEnd + 6); rx++) {
        if (textMask[rowMaskOff + rx] === 0) {
          rIdx = (rowMaskOff + rx) * 3;
          break;
        }
      }

      let fillR = 255;
      let fillG = 255;
      let fillB = 255;
      if (lIdx >= 0 && rIdx >= 0) {
        const d = colorDist(
          workRgb[lIdx],
          workRgb[lIdx + 1],
          workRgb[lIdx + 2],
          workRgb[rIdx],
          workRgb[rIdx + 1],
          workRgb[rIdx + 2]
        );
        if (d <= 36) {
          fillR = Math.round((workRgb[lIdx] + workRgb[rIdx]) / 2);
          fillG = Math.round((workRgb[lIdx + 1] + workRgb[rIdx + 1]) / 2);
          fillB = Math.round((workRgb[lIdx + 2] + workRgb[rIdx + 2]) / 2);
        } else {
          // Pick whichever neighbor has higher area consistency / lighter background unless one is a border
          const lumL = rgbLuminance(workRgb[lIdx], workRgb[lIdx + 1], workRgb[lIdx + 2]);
          const lumR = rgbLuminance(workRgb[rIdx], workRgb[rIdx + 1], workRgb[rIdx + 2]);
          const pick = lumL >= lumR ? lIdx : rIdx;
          fillR = workRgb[pick];
          fillG = workRgb[pick + 1];
          fillB = workRgb[pick + 2];
        }
      } else if (lIdx >= 0) {
        fillR = workRgb[lIdx];
        fillG = workRgb[lIdx + 1];
        fillB = workRgb[lIdx + 2];
      } else if (rIdx >= 0) {
        fillR = workRgb[rIdx];
        fillG = workRgb[rIdx + 1];
        fillB = workRgb[rIdx + 2];
      }

      for (let mx = spanStart; mx < spanEnd; mx++) {
        const outIdx = (rowMaskOff + mx) * 3;
        workRgb[outIdx] = fillR;
        workRgb[outIdx + 1] = fillG;
        workRgb[outIdx + 2] = fillB;
      }
    }
  }

  // 3. Detect horizontal non-white runs per row in `workRgb` and merge vertically into filled rectangles
  const minRunWpx = Math.max(8, Math.round(16 * scaleX));
  interface ActiveBox {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    rSum: number;
    gSum: number;
    bSum: number;
    rowCount: number;
    avgR: number;
    avgG: number;
    avgB: number;
  }

  const activeBoxes: ActiveBox[] = [];
  const completedBoxes: ActiveBox[] = [];

  for (let py = 0; py < h; py++) {
    const rowRuns: Array<{ x0: number; x1: number; r: number; g: number; b: number }> = [];
    let px = 0;
    while (px < w) {
      const idx = (py * w + px) * 3;
      const r0 = workRgb[idx];
      const g0 = workRgb[idx + 1];
      const b0 = workRgb[idx + 2];
      if (isNearWhite(r0, g0, b0)) {
        px++;
        continue;
      }
      const startX = px;
      let rSum = r0;
      let gSum = g0;
      let bSum = b0;
      let cnt = 1;
      px++;
      while (px < w) {
        const idx2 = (py * w + px) * 3;
        const r = workRgb[idx2];
        const g = workRgb[idx2 + 1];
        const b = workRgb[idx2 + 2];
        if (isNearWhite(r, g, b)) break;
        const avgR = rSum / cnt;
        const avgG = gSum / cnt;
        const avgB = bSum / cnt;
        if (colorDist(r, g, b, avgR, avgG, avgB) > 42) break;
        rSum += r;
        gSum += g;
        bSum += b;
        cnt++;
        px++;
      }
      if (px - startX >= minRunWpx) {
        rowRuns.push({
          x0: startX,
          x1: px,
          r: rSum / cnt,
          g: gSum / cnt,
          b: bSum / cnt,
        });
      }
    }

    const matchedActive = new Set<number>();
    for (const run of rowRuns) {
      let bestIdx = -1;
      let bestScore = Infinity;
      for (let i = 0; i < activeBoxes.length; i++) {
        if (matchedActive.has(i)) continue;
        const ab = activeBoxes[i];
        if (ab.y1 !== py - 1) continue;
        if (Math.abs(ab.x0 - run.x0) <= Math.max(4, 3 * scaleX) && Math.abs(ab.x1 - run.x1) <= Math.max(4, 3 * scaleX)) {
          const cd = colorDist(ab.avgR, ab.avgG, ab.avgB, run.r, run.g, run.b);
          if (cd <= 40 && cd < bestScore) {
            bestScore = cd;
            bestIdx = i;
          }
        }
      }

      if (bestIdx >= 0) {
        const ab = activeBoxes[bestIdx];
        matchedActive.add(bestIdx);
        ab.x0 = Math.round((ab.x0 * ab.rowCount + run.x0) / (ab.rowCount + 1));
        ab.x1 = Math.round((ab.x1 * ab.rowCount + run.x1) / (ab.rowCount + 1));
        ab.y1 = py;
        ab.rSum += run.r;
        ab.gSum += run.g;
        ab.bSum += run.b;
        ab.rowCount++;
        ab.avgR = ab.rSum / ab.rowCount;
        ab.avgG = ab.gSum / ab.rowCount;
        ab.avgB = ab.bSum / ab.rowCount;
      } else {
        activeBoxes.push({
          x0: run.x0,
          x1: run.x1,
          y0: py,
          y1: py,
          rSum: run.r,
          gSum: run.g,
          bSum: run.b,
          rowCount: 1,
          avgR: run.r,
          avgG: run.g,
          avgB: run.b,
        });
        matchedActive.add(activeBoxes.length - 1);
      }
    }

    for (let i = activeBoxes.length - 1; i >= 0; i--) {
      if (activeBoxes[i].y1 < py) {
        completedBoxes.push(activeBoxes[i]);
        activeBoxes.splice(i, 1);
      }
    }
  }
  completedBoxes.push(...activeBoxes);

  const fillBanners: VectorFillBox[] = [];
  const fillBands: VectorFillBox[] = [];
  const fillBoxes: VectorFillBox[] = [];

  for (const box of completedBoxes) {
    const xPt = roundPt(box.x0 / scaleX);
    const yPt = roundPt(box.y0 / scaleY);
    const wPt = roundPt((box.x1 - box.x0) / scaleX);
    const hPt = roundPt((box.y1 - box.y0 + 1) / scaleY);
    if (wPt < 16 || hPt < 8) continue;

    // Skip near-full-page background fills
    if (wPt >= pageWidthPt * 0.96 && hPt >= pageHeightPt * 0.90) continue;

    const lum = rgbLuminance(box.avgR, box.avgG, box.avgB);
    if (lum > 0.978) continue;

    const fillHex = toHex(box.avgR, box.avgG, box.avgB);
    const fb: VectorFillBox = {
      x: xPt,
      y: yPt,
      width: wPt,
      height: hPt,
      fillHex,
    };

    if (hPt >= 12 && wPt >= 0.35 * printableWidthPt && lum < 0.75) {
      fillBanners.push(fb);
      fillBoxes.push(fb);
    } else if (lum >= 0.75 && lum <= 0.975 && hPt >= 8 && wPt >= 16) {
      fillBands.push(fb);
      fillBoxes.push(fb);
    } else if (hPt >= 8 && wPt >= 16 && lum < 0.975) {
      fillBoxes.push(fb);
    }
  }

  // 4. Scan HLine (horizontal rules & table horizontal dividers) with >= 70% continuity
  const maxThickHPx = Math.max(2, Math.ceil(4.2 * scaleY));
  const minHWidthPx = Math.max(12, Math.round(12 * scaleX));
  const rawHLines: VectorHLine[] = [];

  const isBorderPxAt = (px: number, py: number): boolean => {
    const idx = (py * w + px) * 3;
    const r = workRgb[idx];
    const g = workRgb[idx + 1];
    const b = workRgb[idx + 2];
    const lum = rgbLuminance(r, g, b);
    if (lum > 0.91) return false;

    // Check contrast vertically above and below within maxThickHPx so filled banners don't masquerade as thick lines
    const upY = Math.max(0, py - maxThickHPx);
    const dnY = Math.min(h - 1, py + maxThickHPx);
    const upIdx = (upY * w + px) * 3;
    const dnIdx = (dnY * w + px) * 3;
    const upLum = rgbLuminance(workRgb[upIdx], workRgb[upIdx + 1], workRgb[upIdx + 2]);
    const dnLum = rgbLuminance(workRgb[dnIdx], workRgb[dnIdx + 1], workRgb[dnIdx + 2]);

    return upLum - lum >= 0.06 && dnLum - lum >= 0.06;
  };

  for (let py = 1; py < h - 1; py++) {
    let px = 0;
    while (px < w) {
      if (!isBorderPxAt(px, py)) {
        px++;
        continue;
      }
      const startX = px;
      let endX = px;
      let solidCount = 0;
      let totalSpan = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let unmaskedCount = 0;
      let gap = 0;
      const maxGapPx = Math.max(2, Math.round(3 * scaleX));

      while (px < w) {
        if (isBorderPxAt(px, py)) {
          endX = px;
          solidCount++;
          const idx = (py * w + px) * 3;
          rSum += workRgb[idx];
          gSum += workRgb[idx + 1];
          bSum += workRgb[idx + 2];
          if (textMask[py * w + px] === 0) unmaskedCount++;
          gap = 0;
          px++;
          totalSpan = endX - startX + 1;
        } else {
          gap++;
          if (gap > maxGapPx) break;
          px++;
        }
      }

      if (totalSpan >= minHWidthPx && solidCount / totalSpan >= 0.7 && unmaskedCount / Math.max(1, solidCount) >= 0.45) {
        rawHLines.push({
          x1: roundPt(startX / scaleX),
          y: roundPt(py / scaleY),
          x2: roundPt((endX + 1) / scaleX),
          strokeColor: toHex(rSum / solidCount, gSum / solidCount, bSum / solidCount),
          lineWidthPt: 0.75,
        });
      }
    }
  }

  // Deduplicate HLines within <= 2pt Y and overlapping X
  const hLines: VectorHLine[] = [];
  rawHLines.sort((a, b) => a.y - b.y || a.x1 - b.x1);
  for (const hl of rawHLines) {
    const existing = hLines.find(
      (o) =>
        Math.abs(o.y - hl.y) <= 2.0 &&
        Math.min(o.x2, hl.x2) - Math.max(o.x1, hl.x1) >= -2.5
    );
    if (existing) {
      existing.x1 = Math.min(existing.x1, hl.x1);
      existing.x2 = Math.max(existing.x2, hl.x2);
      existing.y = roundPt((existing.y + hl.y) / 2);
    } else {
      hLines.push({ ...hl });
    }
  }

  // 5. Scan VLine (vertical grid borders) with >= 70% continuity
  const maxThickVPx = Math.max(2, Math.ceil(4.2 * scaleX));
  const minVHeightPx = Math.max(12, Math.round(12 * scaleY));
  const rawVLines: VectorVLine[] = [];

  const isVertBorderPxAt = (px: number, py: number): boolean => {
    const idx = (py * w + px) * 3;
    const r = workRgb[idx];
    const g = workRgb[idx + 1];
    const b = workRgb[idx + 2];
    const lum = rgbLuminance(r, g, b);
    if (lum > 0.91) return false;

    const lX = Math.max(0, px - maxThickVPx);
    const rX = Math.min(w - 1, px + maxThickVPx);
    const lIdx = (py * w + lX) * 3;
    const rIdx = (py * w + rX) * 3;
    const lLum = rgbLuminance(workRgb[lIdx], workRgb[lIdx + 1], workRgb[lIdx + 2]);
    const rLum = rgbLuminance(workRgb[rIdx], workRgb[rIdx + 1], workRgb[rIdx + 2]);

    return lLum - lum >= 0.06 && rLum - lum >= 0.06;
  };

  for (let px = 1; px < w - 1; px++) {
    let py = 0;
    while (py < h) {
      if (!isVertBorderPxAt(px, py)) {
        py++;
        continue;
      }
      const startY = py;
      let endY = py;
      let solidCount = 0;
      let totalSpan = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let unmaskedCount = 0;
      let gap = 0;
      const maxGapPx = Math.max(2, Math.round(3 * scaleY));

      while (py < h) {
        if (isVertBorderPxAt(px, py)) {
          endY = py;
          solidCount++;
          const idx = (py * w + px) * 3;
          rSum += workRgb[idx];
          gSum += workRgb[idx + 1];
          bSum += workRgb[idx + 2];
          if (textMask[py * w + px] === 0) unmaskedCount++;
          gap = 0;
          py++;
          totalSpan = endY - startY + 1;
        } else {
          gap++;
          if (gap > maxGapPx) break;
          py++;
        }
      }

      if (totalSpan >= minVHeightPx && solidCount / totalSpan >= 0.7 && unmaskedCount / Math.max(1, solidCount) >= 0.45) {
        rawVLines.push({
          x: roundPt(px / scaleX),
          y1: roundPt(startY / scaleY),
          y2: roundPt((endY + 1) / scaleY),
          strokeColor: toHex(rSum / solidCount, gSum / solidCount, bSum / solidCount),
          lineWidthPt: 0.75,
        });
      }
    }
  }

  const vLines: VectorVLine[] = [];
  rawVLines.sort((a, b) => a.x - b.x || a.y1 - b.y1);
  for (const vl of rawVLines) {
    const existing = vLines.find(
      (o) =>
        Math.abs(o.x - vl.x) <= 2.0 &&
        Math.min(o.y2, vl.y2) - Math.max(o.y1, vl.y1) >= -2.5
    );
    if (existing) {
      existing.y1 = Math.min(existing.y1, vl.y1);
      existing.y2 = Math.max(existing.y2, vl.y2);
      existing.x = roundPt((existing.x + vl.x) / 2);
    } else {
      vLines.push({ ...vl });
    }
  }

  // 6. Pure white vertical gutter check for twin-column track detection
  const hasPureWhiteGutter = (x0Pt: number, x1Pt: number, y0Pt: number, y1Pt: number): boolean => {
    if (x1Pt - x0Pt < 6 || y1Pt <= y0Pt + 8) return false;
    const px0 = Math.max(0, Math.floor(x0Pt * scaleX));
    const px1 = Math.min(w, Math.ceil(x1Pt * scaleX));
    const py0 = Math.max(0, Math.floor(y0Pt * scaleY));
    const py1 = Math.min(h, Math.ceil(y1Pt * scaleY));
    if (px1 <= px0 || py1 <= py0) return false;

    let whiteCount = 0;
    let totalCount = 0;
    for (let py = py0; py < py1; py += 2) {
      for (let px = px0; px < px1; px += 2) {
        const idx = (py * w + px) * 3;
        totalCount++;
        if (workRgb[idx] >= 244 && workRgb[idx + 1] >= 244 && workRgb[idx + 2] >= 244) {
          whiteCount++;
        }
      }
    }
    if (totalCount === 0 || whiteCount / totalCount < 0.96) return false;

    const crossesHLine = hLines.some(
      (hl) => hl.y >= y0Pt && hl.y <= y1Pt && hl.x1 < x0Pt && hl.x2 > x1Pt
    );
    const crossesBanner = fillBanners.some(
      (fb) => fb.y + fb.height >= y0Pt && fb.y <= y1Pt && fb.x < x0Pt && fb.x + fb.width > x1Pt
    );
    return !crossesHLine && !crossesBanner;
  };

  return {
    fillBanners,
    fillBands,
    fillBoxes,
    hLines,
    vLines,
    hasPureWhiteGutter,
  };
}
