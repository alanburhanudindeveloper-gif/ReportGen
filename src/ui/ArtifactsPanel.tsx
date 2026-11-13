import { useState } from 'react';
import { Download, FolderOutput, ShieldCheck } from 'lucide-react';
import { FrontendPipelineResult } from './types.ts';

interface ArtifactsPanelProps {
  result: FrontendPipelineResult;
}

type ArtifactTab = 'rdlc' | 'vb' | 'dummy' | 'definition';

export function ArtifactsPanel({ result }: ArtifactsPanelProps) {
  const [activeTab, setActiveTab] = useState<ArtifactTab>('rdlc');
  const [rdlcText, setRdlcText] = useState(result.rdlcXml);
  const [validationState, setValidationState] = useState(result.rdlcValidation);
  const [validating, setValidating] = useState(false);

  const [outputSubdir, setOutputSubdir] = useState(`Generated/${result.reportDefinition.reportName}`);
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [integrateStatus, setIntegrateStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const activeContent =
    activeTab === 'rdlc'
      ? rdlcText
      : activeTab === 'vb'
      ? result.vbCode
      : activeTab === 'dummy'
      ? JSON.stringify(result.dummyJson, null, 2)
      : JSON.stringify(result.reportDefinition, null, 2);

  const activeFilename =
    activeTab === 'rdlc'
      ? `${result.reportDefinition.reportName}.rdlc`
      : activeTab === 'vb'
      ? `${result.reportDefinition.reportName}.vb`
      : activeTab === 'dummy'
      ? 'dummy.json'
      : 'report-definition.json';

  const handleDownload = () => {
    const blob = new Blob([activeContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeFilename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRevalidate = async () => {
    setValidating(true);
    try {
      const resp = await fetch('/api/pipeline/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rdlcXml: rdlcText }),
      });
      const data = await resp.json();
      if (resp.ok) setValidationState(data);
    } finally {
      setValidating(false);
    }
  };

  const handleIntegrate = async () => {
    setIntegrateStatus(null);
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
    const data = await resp.json();
    if (!resp.ok) {
      setIntegrateStatus({ ok: false, message: data.error ?? 'Project write blocked' });
    } else {
      setIntegrateStatus({
        ok: true,
        message: `Written ${data.writtenFiles.length} file(s) to ${data.targetDirectory}`,
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
          {(
            [
              ['rdlc', `${result.reportDefinition.reportName}.rdlc`],
              ['vb', `${result.reportDefinition.reportName}.vb`],
              ['dummy', 'dummy.json'],
              ['definition', 'report-definition.json'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                activeTab === id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {activeTab === 'rdlc' && (
            <button
              onClick={handleRevalidate}
              disabled={validating}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {validating ? 'Validating...' : 'Validate RDLC (10-Point)'}
            </button>
          )}
          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
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
            10-Point RDLC Validation Gate:{' '}
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
