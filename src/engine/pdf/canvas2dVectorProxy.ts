import { VectorFillBox, VectorHLine, VectorVLine } from '../core/types.ts';

export type Mat6 = [number, number, number, number, number, number];

export interface CurveBoxPt {
  x: number;
  y: number;
  width: number;
  height: number;
  fillHex?: string;
  strokeColor?: string;
  lineWidthPt?: number;
}

export interface ImageBoxPt {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextColorEventPt {
  x: number;
  y: number;
  color: string;
}

export interface RecordedCanvasPrimitives {
  hLines: VectorHLine[];
  vLines: VectorVLine[];
  fillBoxes: VectorFillBox[];
  curveBoxes: CurveBoxPt[];
  imageBoxes: ImageBoxPt[];
  textColorEvents: TextColorEventPt[];
}

function mulMat6(m1: Mat6, m2: Mat6): Mat6 {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyMat6(m: Mat6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export class VirtualDOMMatrix {
  public a = 1;
  public b = 0;
  public c = 0;
  public d = 1;
  public e = 0;
  public f = 0;
  public readonly is2D = true;

  constructor(init?: number[] | Float32Array | Float64Array | { a: number; b: number; c: number; d: number; e: number; f: number } | string) {
    if (init && typeof init === 'object') {
      if ('a' in init && typeof init.a === 'number') {
        this.a = init.a;
        this.b = init.b;
        this.c = init.c;
        this.d = init.d;
        this.e = init.e;
        this.f = init.f;
      } else if ('length' in init) {
        if (init.length === 6) {
          this.a = Number(init[0]);
          this.b = Number(init[1]);
          this.c = Number(init[2]);
          this.d = Number(init[3]);
          this.e = Number(init[4]);
          this.f = Number(init[5]);
        } else if (init.length >= 16) {
          this.a = Number(init[0]);
          this.b = Number(init[1]);
          this.c = Number(init[4]);
          this.d = Number(init[5]);
          this.e = Number(init[12]);
          this.f = Number(init[13]);
        }
      }
    }
  }

  public get m11(): number { return this.a; }
  public get m12(): number { return this.b; }
  public get m21(): number { return this.c; }
  public get m22(): number { return this.d; }
  public get m41(): number { return this.e; }
  public get m42(): number { return this.f; }

  public get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  public toMat6(): Mat6 {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }

  public multiplySelf(other: VirtualDOMMatrix | { a: number; b: number; c: number; d: number; e: number; f: number }): this {
    const res = mulMat6(this.toMat6(), [other.a, other.b, other.c, other.d, other.e, other.f]);
    [this.a, this.b, this.c, this.d, this.e, this.f] = res;
    return this;
  }

  public multiply(other: VirtualDOMMatrix): VirtualDOMMatrix {
    return new VirtualDOMMatrix(this).multiplySelf(other);
  }

  public invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (!det || !Number.isFinite(det)) {
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
      return this;
    }
    const na = this.d / det;
    const nb = -this.b / det;
    const nc = -this.c / det;
    const nd = this.a / det;
    const ne = (this.c * this.f - this.d * this.e) / det;
    const nf = (this.b * this.e - this.a * this.f) / det;
    this.a = na;
    this.b = nb;
    this.c = nc;
    this.d = nd;
    this.e = ne;
    this.f = nf;
    return this;
  }

  public inverse(): VirtualDOMMatrix {
    return new VirtualDOMMatrix(this).invertSelf();
  }

  public translate(tx = 0, ty = 0): VirtualDOMMatrix {
    return new VirtualDOMMatrix(mulMat6(this.toMat6(), [1, 0, 0, 1, tx, ty]));
  }

  public scale(sx = 1, sy = sx): VirtualDOMMatrix {
    return new VirtualDOMMatrix(mulMat6(this.toMat6(), [sx, 0, 0, sy, 0, 0]));
  }

  public transformPoint(pt: { x?: number; y?: number }): { x: number; y: number; z: number; w: number } {
    const x = pt.x ?? 0;
    const y = pt.y ?? 0;
    return {
      x: this.a * x + this.c * y + this.e,
      y: this.b * x + this.d * y + this.f,
      z: 0,
      w: 1,
    };
  }
}

export interface PathSubpath {
  pts: Array<{ x: number; y: number }>;
  isRect: boolean;
  hasCurves: boolean;
  closed: boolean;
}

export class VirtualPath2D {
  public readonly subpaths: PathSubpath[] = [];
  private active: PathSubpath | null = null;

  constructor(source?: VirtualPath2D | string) {
    if (source && typeof source === 'object' && Array.isArray(source.subpaths)) {
      for (const sp of source.subpaths) {
        this.subpaths.push({
          pts: sp.pts.map((p) => ({ ...p })),
          isRect: sp.isRect,
          hasCurves: sp.hasCurves,
          closed: sp.closed,
        });
      }
    }
  }

  private ensureActive(x: number, y: number): PathSubpath {
    if (!this.active) {
      this.active = { pts: [{ x, y }], isRect: false, hasCurves: false, closed: false };
      this.subpaths.push(this.active);
    }
    return this.active;
  }

  public moveTo(x: number, y: number): void {
    this.active = { pts: [{ x, y }], isRect: false, hasCurves: false, closed: false };
    this.subpaths.push(this.active);
  }

  public lineTo(x: number, y: number): void {
    const sp = this.ensureActive(x, y);
    sp.pts.push({ x, y });
  }

  public bezierCurveTo(_cp1x: number, _cp1y: number, _cp2x: number, _cp2y: number, x: number, y: number): void {
    const sp = this.ensureActive(x, y);
    sp.hasCurves = true;
    sp.pts.push({ x: _cp1x, y: _cp1y }, { x: _cp2x, y: _cp2y }, { x, y });
  }

  public quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    const sp = this.ensureActive(x, y);
    sp.hasCurves = true;
    sp.pts.push({ x: cpx, y: cpy }, { x, y });
  }

  public arc(x: number, y: number, radius: number): void {
    this.subpaths.push({
      pts: [
        { x: x - radius, y: y - radius },
        { x: x + radius, y: y + radius },
      ],
      isRect: false,
      hasCurves: true,
      closed: true,
    });
    this.active = null;
  }

  public ellipse(x: number, y: number, rx: number, ry: number): void {
    this.subpaths.push({
      pts: [
        { x: x - rx, y: y - ry },
        { x: x + rx, y: y + ry },
      ],
      isRect: false,
      hasCurves: true,
      closed: true,
    });
    this.active = null;
  }

  public rect(x: number, y: number, w: number, h: number): void {
    const sp: PathSubpath = {
      pts: [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      isRect: true,
      hasCurves: false,
      closed: true,
    };
    this.subpaths.push(sp);
    this.active = null;
  }

  public closePath(): void {
    if (this.active) {
      this.active.closed = true;
      if (this.active.pts.length >= 2) {
        const first = this.active.pts[0];
        const last = this.active.pts[this.active.pts.length - 1];
        if (Math.abs(first.x - last.x) > 0.01 || Math.abs(first.y - last.y) > 0.01) {
          this.active.pts.push({ x: first.x, y: first.y });
        }
      }
      this.active = null;
    }
  }

  public addPath(path: VirtualPath2D, transform?: VirtualDOMMatrix | { a: number; b: number; c: number; d: number; e: number; f: number }): void {
    if (!path || !Array.isArray(path.subpaths)) return;
    const mat: Mat6 = transform
      ? [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f]
      : [1, 0, 0, 1, 0, 0];
    for (const sp of path.subpaths) {
      const transformedPts = sp.pts.map((p) => {
        const [tx, ty] = applyMat6(mat, p.x, p.y);
        return { x: tx, y: ty };
      });
      this.subpaths.push({
        pts: transformedPts,
        isRect: sp.isRect && Math.abs(mat[1]) < 1e-4 && Math.abs(mat[2]) < 1e-4,
        hasCurves: sp.hasCurves,
        closed: sp.closed,
      });
    }
    this.active = null;
  }
}

function normalizeStyleColor(val: unknown): string | undefined {
  if (!val) return undefined;
  if (typeof val === 'object' && '_firstColor' in (val as Record<string, unknown>)) {
    const first = (val as { _firstColor?: string })._firstColor;
    return first ? normalizeStyleColor(first) : undefined;
  }
  if (typeof val !== 'string') return undefined;
  const s = val.trim();
  if (!s || s === 'none' || s === 'transparent') return undefined;
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const h = s.slice(1);
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{8}$/.test(s)) {
    const alpha = parseInt(s.slice(7, 9), 16);
    if (alpha === 0) return undefined;
    return s.slice(0, 7).toUpperCase();
  }
  const rgbMatch = s.match(/^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (rgbMatch) {
    if (rgbMatch[4] !== undefined && Number(rgbMatch[4]) === 0) return undefined;
    const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(Number(rgbMatch[1]))}${toHex(Number(rgbMatch[2]))}${toHex(Number(rgbMatch[3]))}`;
  }
  if (s.toLowerCase() === 'black') return '#000000';
  if (s.toLowerCase() === 'white') return '#FFFFFF';
  return undefined;
}

class VirtualGradient {
  public _firstColor?: string;
  public addColorStop(_offset: number, color: string): void {
    if (!this._firstColor) {
      this._firstColor = normalizeStyleColor(color);
    }
  }
}

interface CtxGState {
  ctm: Mat6;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  globalCompositeOperation: string;
  fillRule: string;
  lineCap: string;
  lineJoin: string;
  miterLimit: number;
  lineDash: number[];
  lineDashOffset: number;
  font: string;
  filter: string;
}

export interface VirtualCanvas {
  width: number;
  height: number;
  _recorder: RecordedCanvasPrimitives;
  _pdfjsCanvasName?: string;
  getContext: (type: string, opts?: unknown) => CanvasRenderingContext2D;
  setAttribute?: (k: string, v: string) => void;
}

function isIgnoredCompositeOp(op: string): boolean {
  return op === 'destination-in' || op === 'destination-out' || op === 'destination-atop';
}

function isAxisAlignedClosedRect(pts: Array<{ x: number; y: number }>, closed: boolean): boolean {
  if (pts.length < 4 || pts.length > 5) return false;
  if (!closed && pts.length === 4) {
    // Allow 4 vertices if edges are strictly axis-aligned
  }
  const uniqPts =
    pts.length === 5 &&
    Math.abs(pts[0].x - pts[4].x) <= 0.2 &&
    Math.abs(pts[0].y - pts[4].y) <= 0.2
      ? pts.slice(0, 4)
      : pts;
  if (uniqPts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = uniqPts[i];
    const b = uniqPts[(i + 1) % 4];
    const isHoriz = Math.abs(a.y - b.y) <= 0.25 && Math.abs(a.x - b.x) > 0.5;
    const isVert = Math.abs(a.x - b.x) <= 0.25 && Math.abs(a.y - b.y) > 0.5;
    if (!isHoriz && !isVert) return false;
  }
  return true;
}

function replayPrimitivesTransformed(
  src: RecordedCanvasPrimitives,
  dst: RecordedCanvasPrimitives,
  m: Mat6,
  pageW: number,
  pageH: number
): void {
  const clampX = (x: number) => Math.max(0, Math.min(pageW, x));
  const clampY = (y: number) => Math.max(0, Math.min(pageH, y));

  for (const hl of src.hLines) {
    const [ax1, ay1] = applyMat6(m, hl.x1, hl.y);
    const [ax2, ay2] = applyMat6(m, hl.x2, hl.y);
    if (Math.abs(ay1 - ay2) <= 1.5) {
      const x1 = clampX(Math.min(ax1, ax2));
      const x2 = clampX(Math.max(ax1, ax2));
      if (x2 - x1 >= 12) {
        dst.hLines.push({ x1, y: clampY((ay1 + ay2) / 2), x2, strokeColor: hl.strokeColor, lineWidthPt: hl.lineWidthPt });
      }
    } else if (Math.abs(ax1 - ax2) <= 1.5) {
      const y1 = clampY(Math.min(ay1, ay2));
      const y2 = clampY(Math.max(ay1, ay2));
      if (y2 - y1 >= 12) {
        dst.vLines.push({ x: clampX((ax1 + ax2) / 2), y1, y2, strokeColor: hl.strokeColor, lineWidthPt: hl.lineWidthPt });
      }
    }
  }
  for (const vl of src.vLines) {
    const [ax1, ay1] = applyMat6(m, vl.x, vl.y1);
    const [ax2, ay2] = applyMat6(m, vl.x, vl.y2);
    if (Math.abs(ax1 - ax2) <= 1.5) {
      const y1 = clampY(Math.min(ay1, ay2));
      const y2 = clampY(Math.max(ay1, ay2));
      if (y2 - y1 >= 12) {
        dst.vLines.push({ x: clampX((ax1 + ax2) / 2), y1, y2, strokeColor: vl.strokeColor, lineWidthPt: vl.lineWidthPt });
      }
    } else if (Math.abs(ay1 - ay2) <= 1.5) {
      const x1 = clampX(Math.min(ax1, ax2));
      const x2 = clampX(Math.max(ax1, ax2));
      if (x2 - x1 >= 12) {
        dst.hLines.push({ x1, y: clampY((ay1 + ay2) / 2), x2, strokeColor: vl.strokeColor, lineWidthPt: vl.lineWidthPt });
      }
    }
  }
  for (const fb of src.fillBoxes) {
    const [p1x, p1y] = applyMat6(m, fb.x, fb.y);
    const [p2x, p2y] = applyMat6(m, fb.x + fb.width, fb.y + fb.height);
    const x1 = clampX(Math.min(p1x, p2x));
    const x2 = clampX(Math.max(p1x, p2x));
    const y1 = clampY(Math.min(p1y, p2y));
    const y2 = clampY(Math.max(p1y, p2y));
    if (x2 - x1 > 12 && y2 - y1 > 6) {
      dst.fillBoxes.push({
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
        fillHex: fb.fillHex,
        strokeColor: fb.strokeColor,
        lineWidthPt: fb.lineWidthPt,
      });
    }
  }
  for (const cb of src.curveBoxes) {
    const [p1x, p1y] = applyMat6(m, cb.x, cb.y);
    const [p2x, p2y] = applyMat6(m, cb.x + cb.width, cb.y + cb.height);
    const x1 = clampX(Math.min(p1x, p2x));
    const x2 = clampX(Math.max(p1x, p2x));
    const y1 = clampY(Math.min(p1y, p2y));
    const y2 = clampY(Math.max(p1y, p2y));
    if (x2 - x1 >= 3 && y2 - y1 >= 3) {
      dst.curveBoxes.push({
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
        fillHex: cb.fillHex,
        strokeColor: cb.strokeColor,
        lineWidthPt: cb.lineWidthPt,
      });
    }
  }
  for (const ib of src.imageBoxes) {
    const [p1x, p1y] = applyMat6(m, ib.x, ib.y);
    const [p2x, p2y] = applyMat6(m, ib.x + ib.width, ib.y + ib.height);
    const x1 = clampX(Math.min(p1x, p2x));
    const x2 = clampX(Math.max(p1x, p2x));
    const y1 = clampY(Math.min(p1y, p2y));
    const y2 = clampY(Math.max(p1y, p2y));
    if (x2 - x1 >= 3 && y2 - y1 >= 3) {
      dst.imageBoxes.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    }
  }
  for (const tc of src.textColorEvents) {
    const [tx, ty] = applyMat6(m, tc.x, tc.y);
    dst.textColorEvents.push({ x: tx, y: ty, color: tc.color });
  }
}

export function createRecordingCanvas(width: number, height: number): VirtualCanvas {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const recorder: RecordedCanvasPrimitives = {
    hLines: [],
    vLines: [],
    fillBoxes: [],
    curveBoxes: [],
    imageBoxes: [],
    textColorEvents: [],
  };

  let state: CtxGState = {
    ctm: [1, 0, 0, 1, 0, 0],
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRule: 'nonzero',
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDash: [],
    lineDashOffset: 0,
    font: '10px sans-serif',
    filter: 'none',
  };
  const stack: CtxGState[] = [];
  let activePath = new VirtualPath2D();

  const clampBoxToPage = (minX: number, minY: number, maxX: number, maxY: number) => {
    if (maxX <= 0 || minX >= safeW || maxY <= 0 || minY >= safeH) return null;
    const x1 = Math.max(0, minX);
    const y1 = Math.max(0, minY);
    const x2 = Math.min(safeW, maxX);
    const y2 = Math.min(safeH, maxY);
    return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
  };

  const handleStrokePath = (pathArg?: VirtualPath2D) => {
    if (state.globalAlpha <= 0.01 || isIgnoredCompositeOp(state.globalCompositeOperation)) return;
    const strokeHex = normalizeStyleColor(state.strokeStyle);
    if (!strokeHex) return;
    const p = pathArg instanceof VirtualPath2D ? pathArg : activePath;
    if (!p || p.subpaths.length === 0) return;

    const scaleAvg =
      (Math.hypot(state.ctm[0], state.ctm[1]) + Math.hypot(state.ctm[2], state.ctm[3])) / 2 || 1;
    const lwPt = Math.max(0.4, state.lineWidth * scaleAvg);

    for (const sp of p.subpaths) {
      if (sp.pts.length < 2) continue;
      const tPts = sp.pts.map((pt) => {
        const [tx, ty] = applyMat6(state.ctm, pt.x, pt.y);
        return { x: tx, y: ty };
      });

      if (sp.hasCurves) {
        const xs = tPts.map((pt) => pt.x);
        const ys = tPts.map((pt) => pt.y);
        const box = clampBoxToPage(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
        if (box && box.w >= 3 && box.h >= 3 && box.w <= safeW + 6 && box.h <= 324) {
          recorder.curveBoxes.push({
            x: box.x1,
            y: box.y1,
            width: box.w,
            height: box.h,
            strokeColor: strokeHex,
            lineWidthPt: lwPt,
          });
        }
        continue;
      }

      // Inspect every line segment (plus closing edge if rect/closed)
      const segPts = sp.isRect ? [...tPts, tPts[0]] : tPts;
      let emittedAxisSegment = false;
      for (let i = 0; i < segPts.length - 1; i++) {
        const a = segPts[i];
        const b = segPts[i + 1];
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        if (dy <= 1.5 && dx >= 12) {
          const box = clampBoxToPage(Math.min(a.x, b.x), Math.min(a.y, b.y) - 0.5, Math.max(a.x, b.x), Math.max(a.y, b.y) + 0.5);
          if (box && box.w >= 12) {
            recorder.hLines.push({
              x1: box.x1,
              y: (a.y + b.y) / 2,
              x2: box.x2,
              strokeColor: strokeHex,
              lineWidthPt: lwPt,
            });
            emittedAxisSegment = true;
          }
        } else if (dx <= 1.5 && dy >= 12) {
          const box = clampBoxToPage(Math.min(a.x, b.x) - 0.5, Math.min(a.y, b.y), Math.max(a.x, b.x) + 0.5, Math.max(a.y, b.y));
          if (box && box.h >= 12) {
            recorder.vLines.push({
              x: (a.x + b.x) / 2,
              y1: box.y1,
              y2: box.y2,
              strokeColor: strokeHex,
              lineWidthPt: lwPt,
            });
            emittedAxisSegment = true;
          }
        }
      }

      if (!emittedAxisSegment) {
        const xs = tPts.map((pt) => pt.x);
        const ys = tPts.map((pt) => pt.y);
        const box = clampBoxToPage(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
        if (box && box.w >= 3 && box.h >= 3 && box.h <= 324) {
          recorder.curveBoxes.push({
            x: box.x1,
            y: box.y1,
            width: box.w,
            height: box.h,
            strokeColor: strokeHex,
            lineWidthPt: lwPt,
          });
        }
      }
    }
  };

  const handleFillPath = (pathArg?: VirtualPath2D) => {
    if (state.globalAlpha <= 0.01 || isIgnoredCompositeOp(state.globalCompositeOperation)) return;
    const fillHex = normalizeStyleColor(state.fillStyle);
    if (!fillHex) return;
    const p = pathArg instanceof VirtualPath2D ? pathArg : activePath;
    if (!p || p.subpaths.length === 0) return;

    const transformedSubs = p.subpaths
      .filter((sp) => sp.pts.length >= 2)
      .map((sp) => {
        const tPts = sp.pts.map((pt) => {
          const [tx, ty] = applyMat6(state.ctm, pt.x, pt.y);
          return { x: tx, y: ty };
        });
        const xs = tPts.map((pt) => pt.x);
        const ys = tPts.map((pt) => pt.y);
        return {
          sp,
          tPts,
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minY: Math.min(...ys),
          maxY: Math.max(...ys),
        };
      });

    // Detect hollow frame compound paths (outer rect + concentric inner cutout within <= 4pt thickness)
    if (transformedSubs.length === 2) {
      const [s0, s1] = transformedSubs;
      const outer = (s0.maxX - s0.minX) * (s0.maxY - s0.minY) >= (s1.maxX - s1.minX) * (s1.maxY - s1.minY) ? s0 : s1;
      const inner = outer === s0 ? s1 : s0;
      const dL = inner.minX - outer.minX;
      const dR = outer.maxX - inner.maxX;
      const dT = inner.minY - outer.minY;
      const dB = outer.maxY - inner.maxY;
      if (dL > 0.1 && dL <= 4 && dR > 0.1 && dR <= 4 && dT > 0.1 && dT <= 4 && dB > 0.1 && dB <= 4) {
        const box = clampBoxToPage(outer.minX, outer.minY, outer.maxX, outer.maxY);
        if (box && box.w >= 12 && box.h >= 12) {
          recorder.hLines.push(
            { x1: box.x1, y: box.y1 + dT / 2, x2: box.x2, strokeColor: fillHex, lineWidthPt: dT },
            { x1: box.x1, y: box.y2 - dB / 2, x2: box.x2, strokeColor: fillHex, lineWidthPt: dB }
          );
          recorder.vLines.push(
            { x: box.x1 + dL / 2, y1: box.y1, y2: box.y2, strokeColor: fillHex, lineWidthPt: dL },
            { x: box.x2 - dR / 2, y1: box.y1, y2: box.y2, strokeColor: fillHex, lineWidthPt: dR }
          );
          return;
        }
      }
    }

    for (const sub of transformedSubs) {
      const box = clampBoxToPage(sub.minX, sub.minY, sub.maxX, sub.maxY);
      if (!box) continue;
      // Skip giant shading bounds or full-page white background clear
      if (sub.maxX - sub.minX > safeW * 2 || sub.maxY - sub.minY > safeH * 2) continue;
      if (box.w >= safeW * 0.95 && box.h >= safeH * 0.95 && fillHex === '#FFFFFF') continue;

      if (box.h <= 3 && box.w >= 12) {
        recorder.hLines.push({
          x1: box.x1,
          y: (box.y1 + box.y2) / 2,
          x2: box.x2,
          strokeColor: fillHex,
          lineWidthPt: Math.max(0.5, box.h),
        });
        continue;
      }

      if (box.w <= 3 && box.h >= 12) {
        recorder.vLines.push({
          x: (box.x1 + box.x2) / 2,
          y1: box.y1,
          y2: box.y2,
          strokeColor: fillHex,
          lineWidthPt: Math.max(0.5, box.w),
        });
        continue;
      }

      const isRectLike =
        sub.sp.isRect ||
        isAxisAlignedClosedRect(sub.tPts, sub.sp.closed) ||
        (sub.sp.hasCurves && box.w >= safeW * 0.25 && box.h >= 8 && box.h <= 60);

      if (isRectLike && box.w > 12 && box.h > 6) {
        recorder.fillBoxes.push({
          x: box.x1,
          y: box.y1,
          width: box.w,
          height: box.h,
          fillHex,
        });
      } else if (sub.sp.hasCurves && box.w >= 3 && box.h >= 3 && box.h <= 324) {
        recorder.curveBoxes.push({
          x: box.x1,
          y: box.y1,
          width: box.w,
          height: box.h,
          fillHex,
        });
      } else if (!sub.sp.hasCurves && box.w > 12 && box.h > 6) {
        recorder.fillBoxes.push({
          x: box.x1,
          y: box.y1,
          width: box.w,
          height: box.h,
          fillHex,
        });
      } else if (box.w >= 3 && box.h >= 3 && box.h <= 324) {
        recorder.curveBoxes.push({
          x: box.x1,
          y: box.y1,
          width: box.w,
          height: box.h,
          fillHex,
        });
      }
    }
  };

  let canvasObj!: VirtualCanvas;

  const target: Record<string, unknown> = {
    get canvas() {
      return canvasObj;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: unknown) {
      state.fillStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: unknown) {
      state.strokeStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = Number.isFinite(v) ? v : 1;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = Number.isFinite(v) ? v : 1;
    },
    get globalCompositeOperation() {
      return state.globalCompositeOperation;
    },
    set globalCompositeOperation(v: string) {
      state.globalCompositeOperation = String(v || 'source-over');
    },
    get fillRule() {
      return state.fillRule;
    },
    set fillRule(v: string) {
      state.fillRule = String(v || 'nonzero');
    },
    get lineCap() {
      return state.lineCap;
    },
    set lineCap(v: string) {
      state.lineCap = String(v || 'butt');
    },
    get lineJoin() {
      return state.lineJoin;
    },
    set lineJoin(v: string) {
      state.lineJoin = String(v || 'miter');
    },
    get miterLimit() {
      return state.miterLimit;
    },
    set miterLimit(v: number) {
      state.miterLimit = Number.isFinite(v) ? v : 10;
    },
    get lineDashOffset() {
      return state.lineDashOffset;
    },
    set lineDashOffset(v: number) {
      state.lineDashOffset = Number.isFinite(v) ? v : 0;
    },
    get font() {
      return state.font;
    },
    set font(v: string) {
      state.font = String(v || '10px sans-serif');
    },
    get filter() {
      return state.filter;
    },
    set filter(v: string) {
      state.filter = String(v || 'none');
    },
    imageSmoothingEnabled: true,

    save() {
      stack.push({
        ...state,
        ctm: [...state.ctm] as Mat6,
        lineDash: [...state.lineDash],
      });
    },
    restore() {
      const prev = stack.pop();
      if (prev) state = prev;
    },
    transform(a: number, b: number, c: number, d: number, e: number, f: number) {
      state.ctm = mulMat6(state.ctm, [a, b, c, d, e, f]);
    },
    setTransform(aOrMat: number | { a: number; b: number; c: number; d: number; e: number; f: number }, b?: number, c?: number, d?: number, e?: number, f?: number) {
      if (typeof aOrMat === 'object' && aOrMat !== null) {
        state.ctm = [aOrMat.a, aOrMat.b, aOrMat.c, aOrMat.d, aOrMat.e, aOrMat.f];
      } else {
        state.ctm = [Number(aOrMat), Number(b ?? 0), Number(c ?? 0), Number(d ?? 1), Number(e ?? 0), Number(f ?? 0)];
      }
    },
    resetTransform() {
      state.ctm = [1, 0, 0, 1, 0, 0];
    },
    translate(tx: number, ty: number) {
      state.ctm = mulMat6(state.ctm, [1, 0, 0, 1, tx, ty]);
    },
    scale(sx: number, sy: number) {
      state.ctm = mulMat6(state.ctm, [sx, 0, 0, sy, 0, 0]);
    },
    rotate(rad: number) {
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      state.ctm = mulMat6(state.ctm, [cos, sin, -sin, cos, 0, 0]);
    },
    getTransform() {
      return new VirtualDOMMatrix(state.ctm);
    },
    setLineDash(dashes: number[]) {
      state.lineDash = Array.isArray(dashes) ? [...dashes] : [];
    },
    getLineDash() {
      return [...state.lineDash];
    },

    beginPath() {
      activePath = new VirtualPath2D();
    },
    moveTo(x: number, y: number) {
      activePath.moveTo(x, y);
    },
    lineTo(x: number, y: number) {
      activePath.lineTo(x, y);
    },
    bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) {
      activePath.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    },
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
      activePath.quadraticCurveTo(cpx, cpy, x, y);
    },
    rect(x: number, y: number, w: number, h: number) {
      activePath.rect(x, y, w, h);
    },
    closePath() {
      activePath.closePath();
    },

    stroke(pathArg?: VirtualPath2D) {
      handleStrokePath(pathArg);
    },
    fill(pathOrRule?: VirtualPath2D | string) {
      handleFillPath(typeof pathOrRule === 'object' ? pathOrRule : undefined);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      if (Math.abs(w) > safeW * 20 || Math.abs(h) > safeH * 20) return;
      const p = new VirtualPath2D();
      p.rect(x, y, w, h);
      handleFillPath(p);
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      if (Math.abs(w) > safeW * 20 || Math.abs(h) > safeH * 20) return;
      const p = new VirtualPath2D();
      p.rect(x, y, w, h);
      handleStrokePath(p);
    },
    clearRect(x: number, y: number, w: number, h: number) {
      if (x <= 1 && y <= 1 && w >= safeW - 1 && h >= safeH - 1) {
        recorder.hLines.length = 0;
        recorder.vLines.length = 0;
        recorder.fillBoxes.length = 0;
        recorder.curveBoxes.length = 0;
        recorder.imageBoxes.length = 0;
        recorder.textColorEvents.length = 0;
      }
    },
    clip() {
      // No-op clipping in primitive recorder
    },

    fillText(_text: string, x: number, y: number) {
      if (state.globalAlpha <= 0.01 || isIgnoredCompositeOp(state.globalCompositeOperation)) return;
      const col = normalizeStyleColor(state.fillStyle);
      if (!col) return;
      const [tx, ty] = applyMat6(state.ctm, x, y);
      recorder.textColorEvents.push({ x: tx, y: ty, color: col });
    },
    strokeText(_text: string, x: number, y: number) {
      if (state.globalAlpha <= 0.01 || isIgnoredCompositeOp(state.globalCompositeOperation)) return;
      const col = normalizeStyleColor(state.strokeStyle);
      if (!col) return;
      const [tx, ty] = applyMat6(state.ctm, x, y);
      recorder.textColorEvents.push({ x: tx, y: ty, color: col });
    },

    drawImage(img: unknown, ...args: number[]) {
      if (!img || isIgnoredCompositeOp(state.globalCompositeOperation)) return;
      const srcObj = img as Partial<VirtualCanvas> & { width?: number; height?: number; displayWidth?: number; displayHeight?: number };
      const imgW = Number(srcObj.width ?? srcObj.displayWidth ?? 1);
      const imgH = Number(srcObj.height ?? srcObj.displayHeight ?? 1);

      let sx = 0, sy = 0, sw = imgW, sh = imgH;
      let dx = 0, dy = 0, dw = imgW, dh = imgH;
      if (args.length === 2) {
        [dx, dy] = args;
      } else if (args.length === 4) {
        [dx, dy, dw, dh] = args;
      } else if (args.length >= 8) {
        [sx, sy, sw, sh, dx, dy, dw, dh] = args;
      }

      if (srcObj._recorder) {
        const scaleX = sw > 0 ? dw / sw : 1;
        const scaleY = sh > 0 ? dh / sh : 1;
        const srcToLocal: Mat6 = [scaleX, 0, 0, scaleY, dx - sx * scaleX, dy - sy * scaleY];
        const composed = mulMat6(state.ctm, srcToLocal);
        replayPrimitivesTransformed(srcObj._recorder, recorder, composed, safeW, safeH);
        return;
      }

      // Real raster image draw
      const [p1x, p1y] = applyMat6(state.ctm, dx, dy);
      const [p2x, p2y] = applyMat6(state.ctm, dx + dw, dy + dh);
      const box = clampBoxToPage(Math.min(p1x, p2x), Math.min(p1y, p2y), Math.max(p1x, p2x), Math.max(p1y, p2y));
      if (box && box.w >= 3 && box.h >= 3) {
        // Skip tiny scratch/mask 1x1 test images
        if (box.w <= 3 && box.h <= 3 && imgW <= 3) return;
        recorder.imageBoxes.push({ x: box.x1, y: box.y1, width: box.w, height: box.h });
      }
    },

    createLinearGradient() {
      return new VirtualGradient();
    },
    createRadialGradient() {
      return new VirtualGradient();
    },
    createPattern() {
      return {};
    },
    measureText(text: string) {
      const m = state.font.match(/(\d+(?:\.\d+)?)px/);
      const fSize = m ? Number(m[1]) : 10;
      const w = Math.max(1, (text?.length ?? 0) * fSize * 0.52);
      return {
        width: w,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: w,
        actualBoundingBoxAscent: fSize * 0.8,
        actualBoundingBoxDescent: fSize * 0.2,
      };
    },
    createImageData(w: number, h: number) {
      return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4) };
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4) };
    },
    putImageData() {
      // No-op
    },
    transferFromImageBitmap() {
      // No-op
    },
  };

  const ctxProxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (Reflect.has(obj, prop)) {
        return Reflect.get(obj, prop, receiver);
      }
      return undefined;
    },
    set(obj, prop, value, receiver) {
      return Reflect.set(obj, prop, value, receiver);
    },
  }) as unknown as CanvasRenderingContext2D;

  canvasObj = {
    width: safeW,
    height: safeH,
    _recorder: recorder,
    getContext() {
      return ctxProxy;
    },
    setAttribute() {
      // No-op
    },
  };

  return canvasObj;
}

export class VirtualCanvasFactory {
  public create(width: number, height: number): { canvas: VirtualCanvas; context: CanvasRenderingContext2D } {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    const canvas = createRecordingCanvas(w, h);
    return { canvas, context: canvas.getContext('2d') };
  }

  public reset(entry: { canvas: VirtualCanvas }, width: number, height: number): void {
    if (!entry?.canvas) return;
    entry.canvas.width = Math.max(1, Math.ceil(width));
    entry.canvas.height = Math.max(1, Math.ceil(height));
    entry.canvas._recorder.hLines.length = 0;
    entry.canvas._recorder.vLines.length = 0;
    entry.canvas._recorder.fillBoxes.length = 0;
    entry.canvas._recorder.curveBoxes.length = 0;
    entry.canvas._recorder.imageBoxes.length = 0;
    entry.canvas._recorder.textColorEvents.length = 0;
  }

  public destroy(entry: { canvas: VirtualCanvas | null; context?: unknown }): void {
    if (!entry) return;
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    entry.canvas = null;
    entry.context = null;
  }

  public getNoAlphaContext(canvas: VirtualCanvas): CanvasRenderingContext2D {
    return canvas.getContext('2d');
  }
}

export function deduplicateVectorPrimitives(raw: RecordedCanvasPrimitives): RecordedCanvasPrimitives {
  const roundPt = (v: number) => Math.round(v * 100) / 100;

  // Deduplicate HLines within <= 2pt Y (merging overlapping/touching X segments within <= 2pt)
  const sortedH = [...raw.hLines]
    .map((h) => ({ ...h, x1: roundPt(h.x1), y: roundPt(h.y), x2: roundPt(h.x2) }))
    .sort((a, b) => a.y - b.y || a.x1 - b.x1);
  const hLines: VectorHLine[] = [];
  for (const cur of sortedH) {
    const match = hLines.find(
      (prev) =>
        Math.abs(prev.y - cur.y) <= 2.0 &&
        cur.x1 <= prev.x2 + 2.0 &&
        cur.x2 >= prev.x1 - 2.0
    );
    if (match) {
      match.x1 = Math.min(match.x1, cur.x1);
      match.x2 = Math.max(match.x2, cur.x2);
      match.y = roundPt((match.y + cur.y) / 2);
      match.lineWidthPt = Math.max(match.lineWidthPt, cur.lineWidthPt);
    } else {
      hLines.push(cur);
    }
  }

  // Deduplicate VLines within <= 2pt X (merging overlapping/touching Y segments within <= 2pt)
  const sortedV = [...raw.vLines]
    .map((v) => ({ ...v, x: roundPt(v.x), y1: roundPt(v.y1), y2: roundPt(v.y2) }))
    .sort((a, b) => a.x - b.x || a.y1 - b.y1);
  const vLines: VectorVLine[] = [];
  for (const cur of sortedV) {
    const match = vLines.find(
      (prev) =>
        Math.abs(prev.x - cur.x) <= 2.0 &&
        cur.y1 <= prev.y2 + 2.0 &&
        cur.y2 >= prev.y1 - 2.0
    );
    if (match) {
      match.y1 = Math.min(match.y1, cur.y1);
      match.y2 = Math.max(match.y2, cur.y2);
      match.x = roundPt((match.x + cur.x) / 2);
      match.lineWidthPt = Math.max(match.lineWidthPt, cur.lineWidthPt);
    } else {
      vLines.push(cur);
    }
  }

  // Deduplicate identical FillBoxes
  const fillBoxes: VectorFillBox[] = [];
  for (const cur of raw.fillBoxes) {
    const rCur: VectorFillBox = {
      x: roundPt(cur.x),
      y: roundPt(cur.y),
      width: roundPt(cur.width),
      height: roundPt(cur.height),
      fillHex: cur.fillHex.toUpperCase(),
      strokeColor: cur.strokeColor,
      lineWidthPt: cur.lineWidthPt,
    };
    const dup = fillBoxes.some(
      (prev) =>
        Math.abs(prev.x - rCur.x) <= 1.2 &&
        Math.abs(prev.y - rCur.y) <= 1.2 &&
        Math.abs(prev.width - rCur.width) <= 1.5 &&
        Math.abs(prev.height - rCur.height) <= 1.5 &&
        prev.fillHex === rCur.fillHex
    );
    if (!dup) fillBoxes.push(rCur);
  }

  // Deduplicate ImageBoxes
  const imageBoxes: ImageBoxPt[] = [];
  for (const cur of raw.imageBoxes) {
    const dup = imageBoxes.some(
      (prev) =>
        Math.abs(prev.x - cur.x) <= 1.5 &&
        Math.abs(prev.y - cur.y) <= 1.5 &&
        Math.abs(prev.width - cur.width) <= 2.0 &&
        Math.abs(prev.height - cur.height) <= 2.0
    );
    if (!dup) imageBoxes.push(cur);
  }

  return {
    hLines,
    vLines,
    fillBoxes,
    curveBoxes: raw.curveBoxes,
    imageBoxes,
    textColorEvents: raw.textColorEvents,
  };
}

class VirtualCSSStyleSheet {
  public cssRules: Array<{ cssText: string }> = [];

  public insertRule(rule: string, index = this.cssRules.length): number {
    this.cssRules.splice(index, 0, { cssText: rule });
    return index;
  }

  public deleteRule(index: number): void {
    if (index >= 0 && index < this.cssRules.length) {
      this.cssRules.splice(index, 1);
    }
  }
}

export function createVirtualOwnerDocument(): Record<string, unknown> {
  const adoptedStyleSheets: VirtualCSSStyleSheet[] = [];
  const noopEl = () => ({
    style: {},
    setAttribute() {},
    appendChild() {},
    remove() {},
  });
  return {
    adoptedStyleSheets,
    documentElement: noopEl(),
    head: noopEl(),
    body: noopEl(),
    defaultView: {
      CSSStyleSheet: VirtualCSSStyleSheet,
    },
    createElement() {
      return noopEl();
    },
    createElementNS() {
      return noopEl();
    },
  };
}

export function rasterizePrimitivesToRgba(
  raw: RecordedCanvasPrimitives,
  pageWidthPt: number,
  pageHeightPt: number,
  scale = 2
): { width: number; height: number; data: Uint8ClampedArray } {
  const w = Math.max(1, Math.round(pageWidthPt * scale));
  const h = Math.max(1, Math.round(pageHeightPt * scale));
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(255);

  const parseHex = (hex?: string): [number, number, number] => {
    if (!hex) return [0, 0, 0];
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return [0, 0, 0];
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? [0, 0, 0] : [r, g, b];
  };

  const paintRect = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
    const px0 = Math.max(0, Math.min(w - 1, Math.floor(x0)));
    const py0 = Math.max(0, Math.min(h - 1, Math.floor(y0)));
    const px1 = Math.max(px0 + 1, Math.min(w, Math.ceil(x1)));
    const py1 = Math.max(py0 + 1, Math.min(h, Math.ceil(y1)));
    for (let py = py0; py < py1; py++) {
      const rowBase = py * w * 4;
      for (let px = px0; px < px1; px++) {
        const idx = rowBase + px * 4;
        data[idx] = rgb[0];
        data[idx + 1] = rgb[1];
        data[idx + 2] = rgb[2];
        data[idx + 3] = 255;
      }
    }
  };

  for (const fb of raw.fillBoxes) {
    const rgb = parseHex(fb.fillHex);
    paintRect(fb.x * scale, fb.y * scale, (fb.x + fb.width) * scale, (fb.y + fb.height) * scale, rgb);
    if (fb.strokeColor) {
      const srgb = parseHex(fb.strokeColor);
      const t = Math.max(1, Math.round((fb.lineWidthPt ?? 0.75) * scale));
      paintRect(fb.x * scale, fb.y * scale, (fb.x + fb.width) * scale, fb.y * scale + t, srgb);
      paintRect(fb.x * scale, (fb.y + fb.height) * scale - t, (fb.x + fb.width) * scale, (fb.y + fb.height) * scale, srgb);
      paintRect(fb.x * scale, fb.y * scale, fb.x * scale + t, (fb.y + fb.height) * scale, srgb);
      paintRect((fb.x + fb.width) * scale - t, fb.y * scale, (fb.x + fb.width) * scale, (fb.y + fb.height) * scale, srgb);
    }
  }

  for (const hl of raw.hLines) {
    const rgb = parseHex(hl.strokeColor ?? '#94A3B8');
    const t = Math.max(1, Math.round((hl.lineWidthPt || 0.75) * scale));
    paintRect(hl.x1 * scale, hl.y * scale - t / 2, hl.x2 * scale, hl.y * scale + t / 2, rgb);
  }

  for (const vl of raw.vLines) {
    const rgb = parseHex(vl.strokeColor ?? '#94A3B8');
    const t = Math.max(1, Math.round((vl.lineWidthPt || 0.75) * scale));
    paintRect(vl.x * scale - t / 2, vl.y1 * scale, vl.x * scale + t / 2, vl.y2 * scale, rgb);
  }

  return { width: w, height: h, data };
}

export async function withVirtualCanvasGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const hadDOMMatrix = 'DOMMatrix' in g && g.DOMMatrix !== undefined;
  const prevDOMMatrix = g.DOMMatrix;
  const hadPath2D = 'Path2D' in g;
  const prevPath2D = g.Path2D;

  if (!hadDOMMatrix) {
    g.DOMMatrix = VirtualDOMMatrix;
  }
  g.Path2D = VirtualPath2D;

  try {
    return await fn();
  } finally {
    if (!hadDOMMatrix) {
      delete g.DOMMatrix;
    } else {
      g.DOMMatrix = prevDOMMatrix;
    }
    if (!hadPath2D) {
      delete g.Path2D;
    } else {
      g.Path2D = prevPath2D;
    }
  }
}
