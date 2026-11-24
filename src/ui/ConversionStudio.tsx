import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileDown,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { FrontendPipelineResult } from './types.ts';

interface ConversionStudioProps {
  result: FrontendPipelineResult;
  originalPdfBase64?: string;
}

type RightPaneMode = 'rendered' | 'diff' | 'html';
type ZoomOption = 'fit' | 75 | 100 | 125 | 150;

interface LiveRenderState {
  html: string;
  renderedPagesBase64: string[];
  originalPagesBase64?: string[];
  parityReport?: FrontendPipelineResult['visualDiff'];
}

export function ConversionStudio({ result, originalPdfBase64 }: ConversionStudioProps) {
  const pageCount = Math.max(1, result.layoutModel.document.pageCount);
  const [pageIdx, setPageIdx] = useState(0);
  const [zoom, setZoom] = useState<ZoomOption>('fit');
  const [rightMode, setRightMode] = useState<RightPaneMode>('rendered');
  const [showBounds, setShowBounds] = useState(false);

  const initialParamMap = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of result.reportDefinition.parameters) {
      out[p.name] = p.defaultValue ?? '';
    }
    return out;
  }, [result]);

  const [paramValues, setParamValues] = useState<Record<string, string>>(initialParamMap);
  const [liveRender, setLiveRender] = useState<LiveRenderState | null>(null);
  const [rendering, setRendering] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [studioError, setStudioError] = useState<string | null>(null);

  useEffect(() => {
    setPageIdx(0);
    setParamValues(initialParamMap);
    setLiveRender(null);
    setStudioError(null);
  }, [result, initialParamMap]);

  const activeDiff = liveRender?.parityReport ?? result.visualDiff;
  const pageDiff = activeDiff?.pages[pageIdx];

  const originalImgB64 =
    liveRender?.originalPagesBase64?.[pageIdx] ??
    pageDiff?.originalImageBase64 ??
    result.layoutModel.pages[pageIdx]?.rasterPreviewBase64;

  const renderedImgB64 =
    liveRender?.renderedPagesBase64?.[pageIdx] ?? pageDiff?.comparedImageBase64;

  const diffImgB64 = pageDiff?.diffImageBase64;

  const handleRerender = async (overrides: Record<string, string>, targetMode?: RightPaneMode) => {
    setRendering(true);
    setStudioError(null);
    try {
      const resp = await fetch('/api/pipeline/preview-render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rdlcXml: result.rdlcXml,
          title: result.reportDefinition.reportName,
          sampleFields: result.dummyJson,
          parameterOverrides: overrides,
          originalPdfBase64,
        }),
      });
      const text = await resp.text();
      const data = JSON.parse(text);
      if (!resp.ok) throw new Error(data.error ?? 'Failed to re-render RDLC');
      setLiveRender({
        html: data.html,
        renderedPagesBase64: data.renderedPagesBase64 ?? [],
        originalPagesBase64: data.originalPagesBase64,
        parityReport: data.parityReport,
      });
      if (targetMode) setRightMode(targetMode);
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : String(err));
    } finally {
      setRendering(false);
    }
  };

  const handleSelectRightMode = (mode: RightPaneMode) => {
    setRightMode(mode);
    if (mode === 'html' && !liveRender?.html) {
      void handleRerender(paramValues, 'html');
    }
  };

  const handleDownloadRdlc = () => {
    const blob = new Blob([result.rdlcXml], { type: 'application/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.reportDefinition.reportName}.rdlc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadPdf = async () => {
    setDownloadingPdf(true);
    setStudioError(null);
    try {
      const resp = await fetch('/api/pipeline/preview-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rdlcXml: result.rdlcXml,
          title: result.reportDefinition.reportName,
          filename: result.reportDefinition.reportName,
          sampleFields: result.dummyJson ?? {},
          parameterOverrides: paramValues,
        }),
      });
      if (!resp.ok) {
        const raw = await resp.text();
        throw new Error(raw.slice(0, 180) || 'PDF export failed');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${result.reportDefinition.reportName}_RDLC.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingPdf(false);
    }
  };

  const overallParity =
    activeDiff?.overallParityPercent ?? (activeDiff ? activeDiff.overallSimilarity * 100 : 0);
  const pageParity =
    pageDiff?.parityPercent ?? (pageDiff ? pageDiff.similarity * 100 : 0);
  const overallMae = activeDiff?.meanAbsoluteError ?? 0;
  const targetPct = (activeDiff?.targetSimilarity ?? 0.95) * 100;
  const parityPasses = overallParity >= targetPct;

  const imgWidthStyle = zoom === 'fit' ? { width: '100%' } : { width: `${zoom}%`, maxWidth: 'none' };
  const pageWIn = result.reportDefinition.pageWidthIn || result.layoutModel.document.pageWidth || 8.27;
  const pageHIn = result.reportDefinition.pageHeightIn || result.layoutModel.document.pageHeight || 11.69;
  const hierarchy = result.reportDefinition.hierarchy;
  const bodySections = result.reportDefinition.bodySections ?? [];
  const bodyTablixes = result.reportDefinition.bodyTablixes ?? [];
  const activePageBodySections = bodySections.filter((s) => s.pageNumber === pageIdx + 1);
  const activeHierarchySections = (hierarchy?.sections ?? []).filter(
    (s) => s.pageNumber === pageIdx + 1
  );
  const showHeaderOnActivePage = Boolean(
    hierarchy?.pageHeader && (pageIdx > 0 || hierarchy.pageHeader.printOnFirstPage)
  );
  const headerOffsetIn = showHeaderOnActivePage ? hierarchy!.pageHeader!.heightIn : 0;
  const firstSecTopIn =
    activePageBodySections.length > 0
      ? activePageBodySections[0].topIn
      : activeHierarchySections.length > 0
      ? activeHierarchySections[0].topIn
      : 0;

  const renderBoundsOverlay = () => {
    if (!showBounds) return null;
    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {showHeaderOnActivePage && hierarchy?.pageHeader && (
          <div
            className="absolute left-0 right-0 top-0 border border-indigo-500/80 bg-indigo-500/5"
            style={{ height: `${(hierarchy.pageHeader.heightIn / pageHIn) * 100}%` }}
          >
            <span className="absolute top-0 left-0 bg-indigo-600 text-white font-mono text-[9px] px-1 leading-3">
              PageHeader ({(hierarchy.pageHeader.heightIn * 2.54).toFixed(2)}cm)
            </span>
          </div>
        )}
        {activePageBodySections.length > 0
          ? activePageBodySections.map((sec) => {
              const secTopIn = headerOffsetIn + (sec.topIn - firstSecTopIn);
              return (
                <div
                  key={sec.name}
                  className="absolute border border-dashed border-blue-600/80 bg-blue-500/5"
                  style={{
                    left: `${(sec.leftIn / pageWIn) * 100}%`,
                    top: `${(secTopIn / pageHIn) * 100}%`,
                    width: `${(sec.widthIn / pageWIn) * 100}%`,
                    height: `${(sec.heightIn / pageHIn) * 100}%`,
                  }}
                >
                  <span className="absolute top-0 right-0 bg-blue-600 text-white font-mono text-[9px] px-1 leading-3">
                    {sec.name}
                  </span>
                </div>
              );
            })
          : activeHierarchySections.map((sec) => {
              const secTopIn = headerOffsetIn + (sec.topIn - firstSecTopIn);
              const matchingTablix = bodyTablixes.find((t) => t.name === sec.name);
              const colWidths = matchingTablix?.columnWidthsIn ?? [];
              let runningColX = 0;
              return (
                <div
                  key={sec.name}
                  className="absolute border border-dashed border-blue-600/80 bg-blue-500/5"
                  style={{
                    left: `${(sec.leftIn / pageWIn) * 100}%`,
                    top: `${(secTopIn / pageHIn) * 100}%`,
                    width: `${(sec.widthIn / pageWIn) * 100}%`,
                    height: `${(sec.heightIn / pageHIn) * 100}%`,
                  }}
                >
                  {colWidths.length > 1 &&
                    colWidths.slice(0, -1).map((cw, cIdx) => {
                      runningColX += cw;
                      return (
                        <div
                          key={cIdx}
                          className="absolute top-0 bottom-0 border-l border-emerald-600/60"
                          style={{
                            left: `${sec.widthIn > 0 ? (runningColX / sec.widthIn) * 100 : 0}%`,
                          }}
                        />
                      );
                    })}
                  <span className="absolute top-0 right-0 bg-blue-600 text-white font-mono text-[9px] px-1 leading-3">
                    {sec.name} {sec.archetype ? `[${sec.archetype}]` : ''}
                  </span>
                </div>
              );
            })}
        {hierarchy?.pageFooter && (
          <div
            className="absolute left-0 right-0 bottom-0 border border-slate-700/80 bg-slate-700/5"
            style={{ height: `${(hierarchy.pageFooter.heightIn / pageHIn) * 100}%` }}
          >
            <span className="absolute bottom-0 left-0 bg-slate-800 text-white font-mono text-[9px] px-1 leading-3">
              PageFooter ({(hierarchy.pageFooter.heightIn * 2.54).toFixed(2)}cm)
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
      {/* Studio Header & Quantitative Parity Readout */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="font-display text-base font-bold text-slate-900">
            Side-by-Side Verification Studio
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
            <span>RDLC 2016 ({result.rdlcSchemaVersion ?? '2016'})</span>
            <span aria-hidden="true">·</span>
            <span title={result.rdlcSha256}>
              SHA-256: {result.rdlcSha256 ? result.rdlcSha256.slice(0, 12) : '—'}
            </span>
            {result.conversionMetrics && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {result.conversionMetrics.sectionsCount ?? 0} Body Tablix (
                  {result.conversionMetrics.dualColumnSections ?? 0} Multi-Col) /{' '}
                  {result.conversionMetrics.nestedTablixes ?? 0} Nested /{' '}
                  {result.conversionMetrics.textboxes} Textbox /{' '}
                  {result.conversionMetrics.collisionsCount ?? 0} Collisions /{' '}
                  {result.conversionMetrics.nativeHeaderPresent
                    ? `PageHeader (FirstPage=${String(result.conversionMetrics.printOnFirstPage ?? false)})`
                    : 'No PageHeader'}{' '}
                  / {result.conversionMetrics.nativeFooterPresent ? 'Native PageFooter' : 'No Footer'}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleDownloadRdlc}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Download .rdlc
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={downloadingPdf}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <FileDown className="w-3.5 h-3.5" />
            {downloadingPdf ? 'Exporting PDF...' : 'Download Rendered PDF'}
          </button>
        </div>
      </div>

      {/* Deterministic Parity Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="text-xs text-slate-500">Overall Visual Parity</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-lg font-semibold font-mono tabular-nums text-slate-900">
              {activeDiff?.available ? `${overallParity.toFixed(2)}%` : 'N/A'}
            </span>
            {activeDiff?.available && (
              <span className={`text-xs font-mono font-semibold ${parityPasses ? 'text-emerald-700' : 'text-amber-700'}`}>
                {parityPasses ? `PASS (>=${targetPct.toFixed(0)}%)` : `CHECK (<${targetPct.toFixed(0)}%)`}
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500">Page {pageIdx + 1} Parity</div>
          <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900">
            {pageDiff ? `${pageParity.toFixed(2)}%` : '—'}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500">Mean Absolute Error (RGB)</div>
          <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900">
            {activeDiff?.available ? `${overallMae.toFixed(2)} / 255` : '—'}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500">Fake-Bold Merged / Determinism</div>
          <div className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-900">
            {result.conversionMetrics?.deduplicatedFakeBold ?? 0} spans · Exact
          </div>
        </div>
      </div>

      {studioError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3 text-xs text-red-700 font-mono">
          {studioError}
        </div>
      )}

      {/* Synced Pagination, Zoom, and View Mode Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPageIdx((p) => Math.max(0, p - 1))}
            disabled={pageIdx <= 0}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Prev
          </button>
          <span className="text-xs font-mono tabular-nums text-slate-700 px-2">
            Page {pageIdx + 1} of {pageCount}
          </span>
          <button
            onClick={() => setPageIdx((p) => Math.min(pageCount - 1, p + 1))}
            disabled={pageIdx >= pageCount - 1}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            Next
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setShowBounds((v) => !v)}
            className={`px-2.5 py-1 text-xs font-medium border rounded-md whitespace-nowrap shrink-0 transition-colors ${
              showBounds
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
          >
            Section &amp; Column Bounds
          </button>

          <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
            {(['fit', 75, 100, 125, 150] as const).map((z) => (
              <button
                key={String(z)}
                onClick={() => setZoom(z)}
                className={`px-2.5 py-1 text-xs font-mono rounded whitespace-nowrap shrink-0 ${
                  zoom === z ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {z === 'fit' ? 'Fit' : `${z}%`}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
            {(
              [
                ['rendered', 'Rendered RDLC'],
                ['diff', 'Pixel Diff'],
                ['html', 'HTML Sandbox'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => handleSelectRightMode(mode)}
                className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                  rightMode === mode
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Side-by-Side Split Viewport */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <div className="border border-slate-200 rounded-md bg-slate-100 flex flex-col">
          <div className="px-3 py-2 bg-white border-b border-slate-200 flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-900">Original Input PDF (Page {pageIdx + 1})</span>
            <span className="font-mono text-slate-500 tabular-nums">
              {result.layoutModel.document.pageWidth.toFixed(2)}in ×{' '}
              {result.layoutModel.document.pageHeight.toFixed(2)}in
            </span>
          </div>
          <div className="p-3 overflow-auto max-h-[680px] flex-1 flex justify-center items-start">
            {originalImgB64 ? (
              <div className="relative inline-block" style={imgWidthStyle}>
                <img
                  src={`data:image/png;base64,${originalImgB64}`}
                  alt={`Original PDF Page ${pageIdx + 1}`}
                  className="w-full bg-white border border-slate-300 shadow-xs block"
                />
                {renderBoundsOverlay()}
              </div>
            ) : (
              <div className="py-24 text-xs text-slate-500">Original raster unavailable.</div>
            )}
          </div>
        </div>

        <div className="border border-slate-200 rounded-md bg-slate-100 flex flex-col">
          <div className="px-3 py-2 bg-white border-b border-slate-200 flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-900">
              {rightMode === 'rendered'
                ? `Rendered RDLC Output (Page ${pageIdx + 1})`
                : rightMode === 'diff'
                ? `Pixel Diff Overlay (Page ${pageIdx + 1})`
                : 'HTML Coordinate Preview (All Pages)'}
            </span>
            {pageDiff && (
              <span className="font-mono text-slate-500 tabular-nums">
                {pageDiff.mismatchPixels.toLocaleString()} / {pageDiff.totalPixels.toLocaleString()} diff px
              </span>
            )}
          </div>
          <div className="p-3 overflow-auto max-h-[680px] flex-1 flex justify-center items-start">
            {rightMode === 'html' ? (
              liveRender?.html ? (
                <iframe
                  title="RDLC HTML Preview"
                  srcDoc={liveRender.html}
                  sandbox=""
                  className="w-full h-[640px] border border-slate-300 bg-slate-900 rounded"
                />
              ) : (
                <div className="py-24 text-xs font-mono text-slate-600">
                  {rendering ? 'Rendering HTML preview...' : 'Click Re-Render RDLC to inspect HTML.'}
                </div>
              )
            ) : rightMode === 'diff' ? (
              diffImgB64 ? (
                <div className="relative inline-block" style={imgWidthStyle}>
                  <img
                    src={`data:image/png;base64,${diffImgB64}`}
                    alt={`Pixel Diff Page ${pageIdx + 1}`}
                    className="w-full bg-white border border-slate-300 shadow-xs block"
                  />
                  {renderBoundsOverlay()}
                </div>
              ) : (
                <div className="py-24 text-xs text-slate-500">Pixel diff overlay unavailable.</div>
              )
            ) : renderedImgB64 ? (
              <div className="relative inline-block" style={imgWidthStyle}>
                <img
                  src={`data:image/png;base64,${renderedImgB64}`}
                  alt={`Rendered RDLC Page ${pageIdx + 1}`}
                  className="w-full bg-white border border-slate-300 shadow-xs block"
                />
                {renderBoundsOverlay()}
              </div>
            ) : (
              <div className="py-24 text-xs text-slate-500">Rendered RDLC raster unavailable.</div>
            )}
          </div>
        </div>
      </div>

      {/* Live RDLC Parameter Tester */}
      {result.reportDefinition.parameters.length > 0 && (
        <div className="border-t border-slate-200 pt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Live RDLC ReportParameters ({result.reportDefinition.parameters.length})
              </h3>
              <p className="text-xs text-slate-500">
                Modify any auto-bound parameter below and re-render directly from the generated .rdlc XML.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setParamValues(initialParamMap);
                  void handleRerender(initialParamMap);
                }}
                disabled={rendering}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-700 rounded-md hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset Defaults
              </button>
              <button
                onClick={() => handleRerender(paramValues)}
                disabled={rendering}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${rendering ? 'animate-spin' : ''}`} />
                {rendering ? 'Re-Rendering...' : 'Re-Render RDLC'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-72 overflow-y-auto pr-1">
            {result.reportDefinition.parameters.map((p) => (
              <div key={p.name} className="space-y-1">
                <label className="block text-[11px] font-mono font-medium text-slate-700 truncate" title={p.prompt}>
                  {p.name}
                  {p.matchedPattern ? (
                    <span className="text-slate-400"> · {p.matchedPattern}</span>
                  ) : null}
                </label>
                <input
                  type="text"
                  value={paramValues[p.name] ?? ''}
                  onChange={(e) =>
                    setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                  }
                  className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-md bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
