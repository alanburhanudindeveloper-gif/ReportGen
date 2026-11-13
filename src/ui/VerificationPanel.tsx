import { useState } from 'react';
import { Play } from 'lucide-react';
import { FrontendPipelineResult } from './types.ts';

interface VerificationPanelProps {
  result: FrontendPipelineResult;
  onVisualDiffUpdated?: (diff: FrontendPipelineResult['visualDiff']) => void;
}

export function VerificationPanel({ result, onVisualDiffUpdated }: VerificationPanelProps) {
  const [origPdf, setOrigPdf] = useState<File | null>(null);
  const [genPdf, setGenPdf] = useState<File | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [visualDiff, setVisualDiff] = useState(result.visualDiff);

  const handleRunCompare = async () => {
    if (!origPdf || !genPdf) {
      setCompareError('Select both Original PDF and Generated PDF to run pixel comparison.');
      return;
    }
    setComparing(true);
    setCompareError(null);
    try {
      const form = new FormData();
      form.append('originalPdf', origPdf);
      form.append('generatedPdf', genPdf);
      const resp = await fetch('/api/pipeline/compare', { method: 'POST', body: form });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? 'Compare failed');
      setVisualDiff(data);
      onVisualDiffUpdated?.(data);
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : String(err));
    } finally {
      setComparing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Logic Testing Results */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Independent VB.NET Business Logic Verification
            </h3>
            <p className="text-xs text-slate-500">
              Executes calculation scenarios from Excel oracle or JSON test definitions independently of ReportViewer.
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums">
            Status:{' '}
            <span className={result.logicTests.status === 'PASS' ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
              {result.logicTests.status}
            </span>{' '}
            ({result.logicTests.passed}/{result.logicTests.total} passed)
          </div>
        </div>

        {result.logicTests.ambiguousOracleWarnings.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-900 space-y-1">
            {result.logicTests.ambiguousOracleWarnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-4 font-medium">Scenario</th>
                <th className="py-2 pr-4 font-medium">VB Function</th>
                <th className="py-2 pr-4 font-medium">Inputs</th>
                <th className="py-2 pr-4 font-medium text-right">Expected</th>
                <th className="py-2 pr-4 font-medium text-right">Actual</th>
                <th className="py-2 font-medium text-right">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.logicTests.cases.map((tc, i) => (
                <tr key={i} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-4 text-slate-900 font-medium">{tc.scenario}</td>
                  <td className="py-2.5 pr-4 font-mono text-slate-600">{tc.functionName}</td>
                  <td className="py-2.5 pr-4 font-mono text-slate-600">{JSON.stringify(tc.inputs)}</td>
                  <td className="py-2.5 pr-4 font-mono text-right tabular-nums">{tc.expected.toLocaleString()}</td>
                  <td className="py-2.5 pr-4 font-mono text-right tabular-nums">{tc.actual.toLocaleString()}</td>
                  <td
                    className={`py-2.5 font-mono text-right font-semibold ${
                      tc.passed ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {tc.passed ? 'PASS' : 'FAIL'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ReportViewer Rendering Status */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">ReportViewer Rendering Status</h3>
            <p className="text-xs text-slate-600 mt-1">{result.renderStatus.message}</p>
          </div>
          <span className="text-xs font-mono text-slate-700">
            {result.renderStatus.status}
          </span>
        </div>
      </div>

      {/* PDF Visual Regression Tool */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            PDF Visual Regression (Ghostscript + Pixelmatch)
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Compare Original.pdf against a ReportViewer-rendered PDF to compute real per-page pixel similarity.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Original PDF</label>
            <input
              type="file"
              accept=".pdf"
              onChange={(e) => setOrigPdf(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium hover:file:bg-slate-50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Rendered / Target PDF</label>
            <input
              type="file"
              accept=".pdf"
              onChange={(e) => setGenPdf(e.target.files?.[0] ?? null)}
              className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium hover:file:bg-slate-50"
            />
          </div>
          <div>
            <button
              onClick={handleRunCompare}
              disabled={comparing}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              {comparing ? 'Comparing Pages...' : 'Run Visual Comparison'}
            </button>
          </div>
        </div>

        {compareError && <p className="text-xs text-red-700">{compareError}</p>}

        {visualDiff && visualDiff.available && (
          <div className="space-y-4 border-t border-slate-200 pt-4">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-900">
                Overall Similarity:{' '}
                <span className="font-mono tabular-nums font-semibold">
                  {(visualDiff.overallSimilarity * 100).toFixed(2)}%
                </span>{' '}
                (Target: {(visualDiff.targetSimilarity * 100).toFixed(0)}%)
              </span>
              <span className="text-slate-500">{visualDiff.note}</span>
            </div>

            <div className="space-y-4">
              {visualDiff.pages.map((p) => (
                <div key={p.page} className="border border-slate-200 rounded-md p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                    <span className="font-semibold text-slate-900">Page {p.page}</span>
                    <span className="text-slate-600">
                      Similarity: {(p.similarity * 100).toFixed(2)}% · Mismatched pixels: {p.mismatchPixels.toLocaleString()} / {p.totalPixels.toLocaleString()}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {p.originalImageBase64 && (
                      <div>
                        <p className="text-[11px] text-slate-500 mb-1">Original</p>
                        <img
                          src={`data:image/png;base64,${p.originalImageBase64}`}
                          alt={`Original Page ${p.page}`}
                          className="w-full border border-slate-200"
                        />
                      </div>
                    )}
                    {p.comparedImageBase64 && (
                      <div>
                        <p className="text-[11px] text-slate-500 mb-1">Compared</p>
                        <img
                          src={`data:image/png;base64,${p.comparedImageBase64}`}
                          alt={`Compared Page ${p.page}`}
                          className="w-full border border-slate-200"
                        />
                      </div>
                    )}
                    {p.diffImageBase64 && (
                      <div>
                        <p className="text-[11px] text-slate-500 mb-1">Pixel Diff</p>
                        <img
                          src={`data:image/png;base64,${p.diffImageBase64}`}
                          alt={`Diff Page ${p.page}`}
                          className="w-full border border-slate-200"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
