import { useState } from 'react';
import { FrontendPipelineResult } from './types.ts';

interface LayoutInspectorProps {
  result: FrontendPipelineResult;
}

export function LayoutInspector({ result }: LayoutInspectorProps) {
  const [selectedPageIdx, setSelectedPageIdx] = useState(0);
  const [showGridOverlay, setShowGridOverlay] = useState(true);
  const [showAmbiguousOnly, setShowAmbiguousOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'tablix' | 'json'>('tablix');

  const page = result.layoutModel.pages[selectedPageIdx] ?? result.layoutModel.pages[0];
  if (!page) {
    return <div className="p-6 text-sm text-slate-600">No pages analyzed.</div>;
  }

  const pageTablixes = result.reportDefinition.tablixRegions.filter(
    (t) => t.pageNumber === page.pageNumber
  );

  const visibleRegions = showAmbiguousOnly
    ? page.regions.filter((r) => r.isAmbiguous)
    : page.regions;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-2">
          {result.layoutModel.pages.map((p, idx) => (
            <button
              key={p.pageNumber}
              onClick={() => setSelectedPageIdx(idx)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                idx === selectedPageIdx
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              Page {p.pageNumber}
            </button>
          ))}
          <span className="ml-2 text-xs text-slate-500 tabular-nums">
            {page.width}in × {page.height}in · {page.rawObjectCount} raw objects · {page.bands.length} Tablix bands
          </span>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={showGridOverlay}
              onChange={(e) => setShowGridOverlay(e.target.checked)}
              className="rounded border-slate-300"
            />
            Show Tablix Grid Overlay
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={showAmbiguousOnly}
              onChange={(e) => setShowAmbiguousOnly(e.target.checked)}
              className="rounded border-slate-300"
            />
            Ambiguous Only
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: PDF Page Preview + Deterministic Geometry Overlay */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Page {page.pageNumber} Geometry &amp; Band Reconstruction
            </h3>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              {visibleRegions.length} regions
            </span>
          </div>

          <div
            className="relative w-full bg-slate-100 border border-slate-200 overflow-hidden"
            style={{ aspectRatio: `${page.width} / ${page.height}` }}
          >
            {page.rasterPreviewBase64 ? (
              <img
                src={`data:image/png;base64,${page.rasterPreviewBase64}`}
                alt={`PDF Page ${page.pageNumber}`}
                className="w-full h-full object-contain block"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">
                Raster preview unavailable; rendering coordinate boxes
              </div>
            )}

            {showGridOverlay &&
              page.bands.map((band) => (
                <div
                  key={band.id}
                  title={`${band.name} (${band.bandKind})`}
                  className="absolute border border-blue-600/70 bg-blue-500/5 pointer-events-none"
                  style={{
                    left: `${(band.x / page.width) * 100}%`,
                    top: `${(band.y / page.height) * 100}%`,
                    width: `${(band.width / page.width) * 100}%`,
                    height: `${(band.height / page.height) * 100}%`,
                  }}
                >
                  <span className="absolute -top-4 left-0 text-[10px] font-mono bg-blue-600 text-white px-1 leading-4 whitespace-nowrap">
                    {band.bandKind} ({band.columnWidths.length}×{band.rowHeights.length})
                  </span>
                </div>
              ))}

            {visibleRegions.map((r) => (
              <div
                key={r.id}
                title={`${r.id} · ${r.semanticRole}${r.text ? `: ${r.text}` : ''}`}
                className={`absolute pointer-events-none border ${
                  r.isAmbiguous
                    ? 'border-amber-500 bg-amber-400/15'
                    : r.preferImageFallback
                    ? 'border-emerald-600 bg-emerald-500/10'
                    : 'border-slate-400/50'
                }`}
                style={{
                  left: `${(r.x / page.width) * 100}%`,
                  top: `${(r.y / page.height) * 100}%`,
                  width: `${(r.width / page.width) * 100}%`,
                  height: `${(r.height / page.height) * 100}%`,
                }}
              />
            ))}
          </div>

          <div className="mt-3 flex items-center gap-5 text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border border-blue-600 bg-blue-500/10" />
              Reconstructed Tablix Band
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border border-amber-500 bg-amber-400/20" />
              Ambiguous (Sent to AI)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 border border-emerald-600 bg-emerald-500/15" />
              Image Fallback
            </span>
          </div>
        </div>

        {/* Right: Reconstructed Tablix Structure or Intermediate Layout JSON */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
            <h3 className="text-sm font-semibold text-slate-900">
              {viewMode === 'tablix' ? 'RDLC Tablix Decomposition' : 'Intermediate Layout Model JSON'}
            </h3>
            <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
              <button
                onClick={() => setViewMode('tablix')}
                className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                  viewMode === 'tablix' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                Tablix Grid
              </button>
              <button
                onClick={() => setViewMode('json')}
                className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                  viewMode === 'json' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                Layout JSON
              </button>
            </div>
          </div>

          {viewMode === 'tablix' ? (
            <div className="space-y-5 max-h-[680px] overflow-y-auto pr-1">
              {pageTablixes.map((t) => (
                <div key={t.id} className="border border-slate-200 rounded-md p-3">
                  <div className="flex items-center justify-between text-xs mb-2">
                    <span className="font-mono font-semibold text-slate-900">{t.name}</span>
                    <span className="text-slate-500 tabular-nums">
                      {t.bandKind} · {t.columnWidthsIn.length} cols × {t.rows.length} rows
                      {t.isRepeatingDetail ? ' · Repeating Group' : ''}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-xs">
                      <tbody>
                        {t.rows.map((row, rIdx) => (
                          <tr key={rIdx} className={row.isDetailRow ? 'bg-blue-50/40' : ''}>
                            {row.cells
                              .filter((c) => !c.skipBecauseMerged)
                              .map((cell) => (
                                <td
                                  key={`${rIdx}-${cell.colIndex}`}
                                  colSpan={cell.colSpan}
                                  rowSpan={cell.rowSpan}
                                  className="border border-slate-200 px-2 py-1.5 align-top font-mono text-[11px] text-slate-800"
                                >
                                  {cell.content.kind === 'Image' ? (
                                    <span className="text-emerald-700 font-medium">
                                      [Image: {cell.content.name}]
                                    </span>
                                  ) : cell.content.isExpression ? (
                                    <span className="text-blue-700">{cell.content.value}</span>
                                  ) : (
                                    <span>{cell.content.value || '·'}</span>
                                  )}
                                  {(cell.colSpan > 1 || cell.rowSpan > 1) && (
                                    <span className="ml-1 text-[10px] text-slate-400">
                                      ({cell.colSpan}×{cell.rowSpan})
                                    </span>
                                  )}
                                </td>
                              ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <pre className="text-[11px] font-mono bg-slate-950 text-slate-100 p-3 rounded-md overflow-auto max-h-[680px]">
              {JSON.stringify(
                {
                  ...page,
                  rasterPreviewBase64: page.rasterPreviewBase64 ? '[base64 omitted]' : undefined,
                },
                null,
                2
              )}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
