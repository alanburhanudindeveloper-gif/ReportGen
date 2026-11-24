import { useEffect, useState } from 'react';
import { Download, Eye, FileDown, FolderOutput, ShieldCheck } from 'lucide-react';
import { FrontendPipelineResult } from './types.ts';

interface ArtifactsPanelProps {
  result: FrontendPipelineResult;
  initialTab?: ArtifactTab;
}

export type ArtifactTab = 'rdlc' | 'preview' | 'vb' | 'dummy' | 'definition';

interface RdlcPreviewState {
  html: string;
  pageCount: number;
  pageWidth: string;
  pageHeight: string;
  stats: {
    rectangles: number;
    tablixes: number;
    mergedCells: number;
    textboxes: number;
    images: number;
    embeddedImages: number;
    parameters: number;
  };
  collisions: Array<{ page: number; container: string; itemA: string; itemB: string; overlapCm: string }>;
}

async function readJsonSafe(resp: Response): Promise<Record<string, unknown>> {
  const txt = await resp.text();
  try {
    return JSON.parse(txt) as Record<string, unknown>;
  } catch {
    throw new Error(txt.slice(0, 200) || `HTTP ${resp.status}`);
  }
}

export function ArtifactsPanel({ result, initialTab }: ArtifactsPanelProps) {
  const [activeTab, setActiveTab] = useState<ArtifactTab>(initialTab ?? 'rdlc');
  const [rdlcText, setRdlcText] = useState(result.rdlcXml);
  const [validationState, setValidationState] = useState(result.rdlcValidation);
  const [validating, setValidating] = useState(false);

  const [previewData, setPreviewData] = useState<RdlcPreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const [outputSubdir, setOutputSubdir] = useState(`Generated/${result.reportDefinition.reportName}`);
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [integrateStatus, setIntegrateStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const loadVisualPreview = async (xmlOverride?: string) => {
    const xml = xmlOverride ?? rdlcText;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const resp = await fetch('/api/pipeline/preview-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rdlcXml: xml,
          title: `${result.reportDefinition.reportName} — RDLC Visual Preview`,
          sampleFields: result.dummyJson,
        }),
      });
      const data = await readJsonSafe(resp);
      if (!resp.ok) throw new Error(String(data.error ?? 'Failed to render RDLC preview'));
      setPreviewData(data as unknown as RdlcPreviewState);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    setRdlcText(result.rdlcXml);
    setValidationState(result.rdlcValidation);
    setOutputSubdir(`Generated/${result.reportDefinition.reportName}`);
    setPreviewData(null);
    setPreviewError(null);
    setIntegrateStatus(null);
    if (activeTab === 'preview') {
      void loadVisualPreview(result.rdlcXml);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
      if (initialTab === 'preview') {
        void loadVisualPreview(result.rdlcXml);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  const activeContent =
    activeTab === 'rdlc'
      ? rdlcText
      : activeTab === 'preview'
      ? previewData?.html ?? ''
      : activeTab === 'vb'
      ? result.vbCode
      : activeTab === 'dummy'
      ? JSON.stringify(result.dummyJson, null, 2)
      : JSON.stringify(result.reportDefinition, null, 2);

  const activeFilename =
    activeTab === 'rdlc'
      ? `${result.reportDefinition.reportName}.rdlc`
      : activeTab === 'preview'
      ? `${result.reportDefinition.reportName}-preview.html`
      : activeTab === 'vb'
      ? `${result.reportDefinition.reportName}.vb`
      : activeTab === 'dummy'
      ? 'dummy.json'
      : 'report-definition.json';

  const handleDownload = () => {
    const mime = activeTab === 'preview' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
    const blob = new Blob([activeContent], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFilename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadPdf = async () => {
    setDownloadingPdf(true);
    setPreviewError(null);
    try {
      const resp = await fetch('/api/pipeline/preview-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rdlcXml: rdlcText,
          title: result.reportDefinition.reportName,
          filename: result.reportDefinition.reportName,
          sampleFields: result.dummyJson,
        }),
      });
      if (!resp.ok) {
        const errData = await readJsonSafe(resp);
        throw new Error(String(errData.error ?? 'Failed to render RDLC to PDF'));
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${result.reportDefinition.reportName}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleTabSelect = (id: ArtifactTab) => {
    setActiveTab(id);
    if (id === 'preview') {
      void loadVisualPreview();
    }
  };

  const handleRevalidate = async () => {
    setValidating(true);
    try {
      const resp = await fetch('/api/pipeline/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rdlcXml: rdlcText }),
      });
      const data = await readJsonSafe(resp);
      if (resp.ok) setValidationState(data as unknown as FrontendPipelineResult['rdlcValidation']);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  };

  const handleIntegrate = async () => {
    setIntegrateStatus(null);
    try {
      const resp = await fetch('/api/pipeline/integrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relativeOutputDir: outputSubdir,
          reportName: result.reportDefinition.reportName,
          force: forceOverwrite,
          rdlcXml: rdlcText,
          vbCode: result.vbCode,
          dummyJson: JSON.stringify(result.dummyJson, null, 2),
          reportDefinitionJson: JSON.stringify(result.reportDefinition, null, 2),
        }),
      });
      const data = await readJsonSafe(resp);
      if (!resp.ok) {
        setIntegrateStatus({ ok: false, message: String(data.error ?? 'Project write blocked') });
      } else {
        const written = Array.isArray(data.writtenFiles) ? data.writtenFiles.length : 0;
        setIntegrateStatus({
          ok: true,
          message: `Written ${written} file(s) to ${String(data.targetDirectory ?? outputSubdir)}`,
        });
      }
    } catch (err) {
      setIntegrateStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md">
          {(
            [
              ['rdlc', `${result.reportDefinition.reportName}.rdlc`],
              ['preview', 'Visual Preview'],
              ['vb', `${result.reportDefinition.reportName}.vb`],
              ['dummy', 'dummy.json'],
              ['definition', 'report-definition.json'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => handleTabSelect(id)}
              className={`px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                activeTab === id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeTab === 'rdlc' && (
            <button
              onClick={handleRevalidate}
              disabled={validating}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {validating ? 'Validating...' : `Validate RDLC (${validationState.checkedRules || 15}-Point)`}
            </button>
          )}
          {activeTab === 'preview' && (
            <button
              onClick={() => loadVisualPreview()}
              disabled={previewLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <Eye className="w-3.5 h-3.5" />
              {previewLoading ? 'Rendering...' : 'Refresh Preview'}
            </button>
          )}
          <button
            onClick={handleDownloadPdf}
            disabled={downloadingPdf || !rdlcText}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <FileDown className="w-3.5 h-3.5" />
            {downloadingPdf ? 'Rendering PDF...' : 'Download PDF'}
          </button>
          <button
            onClick={handleDownload}
            disabled={activeTab === 'preview' && !previewData?.html}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Download {activeFilename}
          </button>
        </div>
      </div>

      {/* Validation Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-slate-900">
            {validationState.checkedRules || 15}-Point RDLC Validation Gate:{' '}
            <span className={validationState.valid ? 'text-emerald-700' : 'text-red-700'}>
              {validationState.valid ? 'PASS' : 'FAIL'}
            </span>
          </p>
          <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
            {validationState.checkedRules} rules checked · {validationState.errors.length} error(s) ·{' '}
            {validationState.warnings.length} warning(s)
          </p>
        </div>
        {validationState.errors.length > 0 && (
          <ul className="w-full text-xs text-red-700 space-y-1 border-t border-slate-100 pt-2">
            {validationState.errors.map((e, i) => (
              <li key={i} className="font-mono">
                [{e.ruleId}] {e.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Editor / Viewer */}
      {activeTab === 'rdlc' ? (
        <textarea
          value={rdlcText}
          onChange={(e) => setRdlcText(e.target.value)}
          spellCheck={false}
          className="w-full h-[460px] font-mono text-xs bg-slate-950 text-slate-100 p-4 rounded-lg border border-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
        />
      ) : activeTab === 'preview' ? (
        <div className="space-y-3">
          {previewError && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3 text-xs text-red-700 font-mono">
              {previewError}
            </div>
          )}
          {previewData && (
            <div className="bg-white border border-slate-200 rounded-lg px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-slate-600">
              <span>
                Pages: <strong className="text-slate-900">{previewData.pageCount}</strong> ({previewData.pageWidth} ×{' '}
                {previewData.pageHeight}) · Tablixes: <strong className="text-slate-900">{previewData.stats.tablixes}</strong> ·
                Embedded PNGs: <strong className="text-slate-900">{previewData.stats.embeddedImages}</strong> · Params:{' '}
                <strong className="text-slate-900">{previewData.stats.parameters}</strong>
              </span>
              <span className={previewData.collisions.length === 0 ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                {previewData.collisions.length === 0
                  ? '0 layout collisions'
                  : `${previewData.collisions.length} overlap warning(s)`}
              </span>
            </div>
          )}
          {previewLoading ? (
            <div className="h-[520px] flex items-center justify-center bg-slate-900 text-slate-300 text-xs font-mono rounded-lg border border-slate-800">
              Rendering coordinate-locked RDLC visual preview...
            </div>
          ) : previewData?.html ? (
            <iframe
              title="RDLC Visual Render Preview"
              srcDoc={previewData.html}
              sandbox=""
              className="w-full h-[640px] rounded-lg border border-slate-300 bg-slate-900"
            />
          ) : null}
        </div>
      ) : (
        <pre className="w-full h-[460px] overflow-auto font-mono text-xs bg-slate-950 text-slate-100 p-4 rounded-lg border border-slate-800">
          {activeContent}
        </pre>
      )}

      {/* Safe Project Integration Panel */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-slate-900">Project Integration Writer</h4>
            <p className="text-xs text-slate-500">
              Writes all 4 artifacts into configured workspace output directory. Refuses silent overwrites unless Force is enabled.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={outputSubdir}
            onChange={(e) => setOutputSubdir(e.target.value)}
            aria-label="Target relative output path"
            className="flex-1 min-w-[240px] px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={forceOverwrite}
              onChange={(e) => setForceOverwrite(e.target.checked)}
              className="rounded border-slate-300"
            />
            --force overwrite
          </label>
          <button
            onClick={handleIntegrate}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 whitespace-nowrap shrink-0"
          >
            <FolderOutput className="w-3.5 h-3.5" />
            Write Artifacts to Project
          </button>
        </div>
        {integrateStatus && (
          <p className={`text-xs font-mono ${integrateStatus.ok ? 'text-emerald-700' : 'text-red-700'}`}>
            {integrateStatus.message}
          </p>
        )}
      </div>
    </div>
  );
}
