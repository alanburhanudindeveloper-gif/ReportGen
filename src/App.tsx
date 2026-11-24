import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Code2,
  Download,
  Eye,
  FileDown,
  FileSpreadsheet,
  FileText,
  Layers,
  Play,
  Terminal,
  Upload,
  Wrench,
  XCircle,
} from 'lucide-react';
import { ArtifactsPanel, ArtifactTab } from './ui/ArtifactsPanel.tsx';
import { ConversionStudio } from './ui/ConversionStudio.tsx';
import { LayoutInspector } from './ui/LayoutInspector.tsx';
import { ProposalWorkspace } from './ui/ProposalWorkspace.tsx';
import { FrontendPipelineResult } from './ui/types.ts';
import { VerificationPanel } from './ui/VerificationPanel.tsx';

type NavSection = 'proposal' | 'workbench' | 'layout' | 'artifacts' | 'verification' | 'mcp';

interface SkillMeta {
  name: string;
  purpose: string;
  rules: string[];
  constraints: string[];
}

interface McpToolMeta {
  name: string;
  description: string;
  readOnly: boolean;
  category?: 'READ_ONLY' | 'VALIDATION' | 'PROPOSAL' | 'MUTATION';
  riskLevel?: 'low' | 'medium' | 'high';
  approvalRequired?: boolean;
  handlerName: string;
  command?: string;
}

export default function App() {
  const [section, setSection] = useState<NavSection>('workbench');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [originalPdfBase64, setOriginalPdfBase64] = useState<string | undefined>(undefined);
  const [rdlcFile, setRdlcFile] = useState<File | null>(null);
  const [vbFile, setVbFile] = useState<File | null>(null);
  const [excelFile, setExcelFile] = useState<File | null>(null);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FrontendPipelineResult | null>(null);

  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolMeta[]>([]);
  const [configData, setConfigData] = useState<Record<string, unknown> | null>(null);

  const [stagedOutputs, setStagedOutputs] = useState<
    Array<{ folder: string; rdlcFile: string; rdlcBytes: number; hasPreviewHtml: boolean }>
  >([]);
  const [selectedStagedPreview, setSelectedStagedPreview] = useState<{
    folder: string;
    rdlcFile: string;
    rdlcBytes: number;
    validation: { valid: boolean; checkedRules: number; errors: Array<{ ruleId: string; message: string }>; warnings: Array<{ ruleId: string; message: string }> };
    preview: {
      html: string;
      pageCount: number;
      pageWidth: string;
      pageHeight: string;
      stats: { tablixes: number; mergedCells: number; textboxes: number; embeddedImages: number; parameters: number };
      collisions: Array<{ page: number; container: string; itemA: string; itemB: string; overlapCm: string }>;
    };
  } | null>(null);
  const [loadingStagedPreview, setLoadingStagedPreview] = useState(false);
  const [downloadingStagedPdf, setDownloadingStagedPdf] = useState(false);
  const [artifactsInitialTab, setArtifactsInitialTab] = useState<ArtifactTab>('rdlc');

  useEffect(() => {
    Promise.all([
      fetch('/api/skills').then((r) => r.json()).catch(() => ({ skills: [] })),
      fetch('/api/mcp/tools').then((r) => r.json()).catch(() => ({ tools: [] })),
      fetch('/api/config').then((r) => r.json()).catch(() => null),
      fetch('/api/outputs').then((r) => r.json()).catch(() => ({ outputs: [] })),
    ]).then(([s, m, c, o]) => {
      setSkills(s.skills ?? []);
      setMcpTools(m.tools ?? []);
      setConfigData(c);
      setStagedOutputs(o?.outputs ?? []);
    });
  }, []);

  const parseJsonSafe = async (resp: Response) => {
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(raw.slice(0, 200) || `HTTP ${resp.status}`);
    }
  };

  const loadStagedOutputPreview = async (folder: string) => {
    setLoadingStagedPreview(true);
    setError(null);
    try {
      const resp = await fetch(`/api/outputs/${encodeURIComponent(folder)}/preview`);
      const data = await parseJsonSafe(resp);
      if (!resp.ok) throw new Error(data.error ?? 'Failed to load staged RDLC preview');
      setSelectedStagedPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingStagedPreview(false);
    }
  };

  const downloadStagedPdf = async (folder: string, rdlcFile: string) => {
    setDownloadingStagedPdf(true);
    setError(null);
    try {
      const resp = await fetch(`/api/outputs/${encodeURIComponent(folder)}/pdf`);
      if (!resp.ok) {
        const data = await parseJsonSafe(resp);
        throw new Error(data.error ?? 'Failed to render staged RDLC to PDF');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${rdlcFile.replace(/\.rdlc$/i, '')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingStagedPdf(false);
    }
  };

  const executePipeline = async (useFixture: boolean) => {
    if (!useFixture && !pdfFile) {
      setError('Upload a target PDF report template or run the multi-layout verification fixture.');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('useFixture', String(useFixture));
      if (!useFixture && pdfFile) {
        form.append('pdf', pdfFile);
        const buf = await pdfFile.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        setOriginalPdfBase64(btoa(bin));
      } else {
        setOriginalPdfBase64(undefined);
      }
      if (rdlcFile) form.append('existingRdlc', rdlcFile);
      if (vbFile) form.append('existingVb', vbFile);
      if (excelFile) form.append('excel', excelFile);

      const resp = await fetch('/api/pipeline/run', { method: 'POST', body: form });
      const data = await parseJsonSafe(resp);
      if (!resp.ok) {
        throw new Error(data.error ?? 'Pipeline execution failed');
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const navItems: Array<{ id: NavSection; label: string; icon: typeof Layers; disabled?: boolean }> = [
    { id: 'proposal', label: 'Proposal Adaptation', icon: Layers },
    { id: 'workbench', label: 'Verification Studio', icon: Upload },
    { id: 'layout', label: 'Layout & Tablix', icon: Layers, disabled: !result },
    { id: 'artifacts', label: 'RDLC & VB.NET', icon: Code2, disabled: !result },
    { id: 'verification', label: 'Tests & Diff', icon: FileSpreadsheet, disabled: !result },
    { id: 'mcp', label: 'MCP & Config', icon: Wrench },
  ];

  const totalRegions = result
    ? result.layoutModel.pages.reduce((s, p) => s + p.regions.length, 0)
    : 0;
  const totalTablixes = result
    ? result.conversionMetrics?.tablixes ??
      result.reportDefinition.bodyTablixes?.length ??
      result.reportDefinition.tablixRegions.length
    : 0;

  const handleDownloadReportSummary = () => {
    if (!result) return;
    const summaryPayload = {
      runId: result.runId,
      documentName: result.documentName,
      generatedAt: new Date().toISOString(),
      finalized: result.finalized,
      rdlcValidation: {
        valid: result.rdlcValidation.valid,
        checkedRules: result.rdlcValidation.checkedRules,
        errors: result.rdlcValidation.errors.length,
        warnings: result.rdlcValidation.warnings.length,
      },
      logicTests: {
        status: result.logicTests.status,
        total: result.logicTests.total,
        passed: result.logicTests.passed,
        failed: result.logicTests.failed,
      },
      renderStatus: result.renderStatus,
      overallSimilarity: result.visualDiff?.available ? result.visualDiff.overallSimilarity : null,
      visualSimilarity: result.visualDiff
        ? {
            available: result.visualDiff.available,
            overallSimilarity: result.visualDiff.overallSimilarity,
            targetSimilarity: result.visualDiff.targetSimilarity,
            note: result.visualDiff.note,
            pages: result.visualDiff.pages.map((p) => ({
              page: p.page,
              similarity: p.similarity,
              mismatchPixels: p.mismatchPixels,
              totalPixels: p.totalPixels,
            })),
          }
        : {
            available: false,
            overallSimilarity: null,
            targetSimilarity: null,
            note: 'Visual comparison has not been executed yet.',
            pages: [],
          },
      logs: result.logs,
    };

    const blob = new Blob([JSON.stringify(summaryPayload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'report-summary.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-slate-900">
      {/* Strict 3-zone Top Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8">
        <a
          href="/"
          className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          ReportGen
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <button
            onClick={() => setSection('proposal')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              section === 'proposal' ? 'text-slate-900 underline underline-offset-8' : ''
            }`}
          >
            Proposal Adaptation
          </button>
          <button
            onClick={() => setSection('workbench')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              section === 'workbench' ? 'text-slate-900 underline underline-offset-8' : ''
            }`}
          >
            Workbench
          </button>
          <button
            onClick={() => result && setSection('layout')}
            disabled={!result}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              !result
                ? 'text-slate-300 cursor-not-allowed'
                : section === 'layout'
                ? 'text-slate-900 underline underline-offset-8'
                : 'hover:text-slate-900'
            }`}
          >
            Hierarchy &amp; Tablix
          </button>
          <button
            onClick={() => result && setSection('artifacts')}
            disabled={!result}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              !result
                ? 'text-slate-300 cursor-not-allowed'
                : section === 'artifacts'
                ? 'text-slate-900 underline underline-offset-8'
                : 'hover:text-slate-900'
            }`}
          >
            RDLC &amp; VB
          </button>
          <button
            onClick={() => result && setSection('verification')}
            disabled={!result}
            className={`transition-colors whitespace-nowrap shrink-0 ${
              !result
                ? 'text-slate-300 cursor-not-allowed'
                : section === 'verification'
                ? 'text-slate-900 underline underline-offset-8'
                : 'hover:text-slate-900'
            }`}
          >
            Verification
          </button>
          <button
            onClick={() => setSection('mcp')}
            className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
              section === 'mcp' ? 'text-slate-900 underline underline-offset-8' : ''
            }`}
          >
            MCP &amp; Config
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => executePipeline(!pdfFile)}
            disabled={running}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            <Play className="w-3.5 h-3.5" />
            {running ? 'Converting...' : pdfFile ? 'Convert PDF to RDLC' : 'Run Verification Fixture'}
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row">
        {/* Left Navigation Sidebar */}
        <aside className="w-full lg:w-64 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 p-4 flex flex-col justify-between">
          <div className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => !item.disabled && setSection(item.id)}
                  disabled={item.disabled}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-slate-900 text-white'
                      : item.disabled
                      ? 'text-slate-300 cursor-not-allowed'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          {result && (
            <div className="mt-6 pt-4 border-t border-slate-200 space-y-2 text-xs">
              <div className="font-semibold text-slate-900 truncate" title={result.documentName}>
                {result.documentName}
              </div>
              <div className="text-slate-500 tabular-nums space-y-1">
                <div>Pages: {result.layoutModel.document.pageCount}</div>
                <div>Regions: {totalRegions}</div>
                <div>Tablix Bands: {totalTablixes}</div>
                <div>
                  RDLC Gate:{' '}
                  <span className={result.rdlcValidation.valid ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                    {result.rdlcValidation.valid ? 'PASS' : 'FAIL'}
                  </span>
                </div>
                <div>
                  Logic Gate:{' '}
                  <span className={result.logicTests.status === 'PASS' ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                    {result.logicTests.passed}/{result.logicTests.total} {result.logicTests.status}
                  </span>
                </div>
              </div>
            </div>
          )}
        </aside>

        {/* Main Viewport */}
        <main className="flex-1 p-6 lg:p-8 max-w-[1280px] w-full">
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3 text-xs text-red-800">
              <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">Pipeline Execution Error</p>
                <p className="mt-0.5 font-mono">{error}</p>
              </div>
            </div>
          )}

          {section === 'proposal' && <ProposalWorkspace />}

          {section === 'workbench' && (
            <div className="space-y-6">
              <div className="border-b border-slate-200 pb-4">
                <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 text-balance">
                  Deterministic PDF to RDLC 2016 Verification Studio
                </h1>
                <p className="text-sm text-slate-600 mt-1 max-w-3xl">
                  Zero-AI forensic PDF geometry extraction, v3 100% Full-Tablix RDLC 2016 synthesis, deduplicated native PageHeader/PageFooter, VB.NET logic verification, and live pixel-parity inspection.
                </p>
              </div>

              {/* Input Upload Form */}
              <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1.5">
                      1. Target PDF Report Template (Required)
                    </label>
                    <input
                      type="file"
                      accept=".pdf"
                      onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-xs text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium hover:file:bg-slate-50"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      Multi-page PDFs with tables, cards, timelines, headers/footers, and vector graphics are supported.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1.5">
                      2. Finance Excel Calculation Oracle (.xlsx, Optional)
                    </label>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={(e) => setExcelFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-xs text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium hover:file:bg-slate-50"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      Used strictly as a deterministic verification test oracle against generated VB logic.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1.5">
                      3. Existing Pattern RDLC (.rdlc, Optional)
                    </label>
                    <input
                      type="file"
                      accept=".rdlc,.xml"
                      onChange={(e) => setRdlcFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-xs text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium hover:file:bg-slate-50"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1.5">
                      4. Existing Pattern VB.NET (.vb, Optional)
                    </label>
                    <input
                      type="file"
                      accept=".vb"
                      onChange={(e) => setVbFile(e.target.files?.[0] ?? null)}
                      className="block w-full text-xs text-slate-600 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:text-xs file:font-medium hover:file:bg-slate-50"
                    />
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4">
                  <div className="text-xs text-slate-600">
                    100% deterministic offline conversion · v3 Full-Tablix RDLC 2016 body + native PageHeader/PageFooter
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => executePipeline(true)}
                      disabled={running}
                      className="px-4 py-2 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50 whitespace-nowrap"
                    >
                      Run Verification Fixture (PDF + Excel + RDLC/VB)
                    </button>
                    <button
                      onClick={() => executePipeline(false)}
                      disabled={running || !pdfFile}
                      className="px-4 py-2 text-xs font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      {running ? 'Converting...' : 'Convert & Verify Uploaded PDF'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Execution Summary, Side-by-Side Studio & Logs */}
              {result && (
                <div className="space-y-6">
                  <ConversionStudio result={result} originalPdfBase64={originalPdfBase64} />

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-white border border-slate-200 rounded-lg p-4">
                      <div className="text-xs text-slate-500">Extracted Regions</div>
                      <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
                        {totalRegions}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                        Across {result.layoutModel.document.pageCount} page(s)
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-lg p-4">
                      <div className="text-xs text-slate-500">RDLC Tablix Bands</div>
                      <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
                        {totalTablixes}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {result.rdlcValidation.checkedRules || 15}-Point Gate: {result.rdlcValidation.valid ? 'PASS' : 'FAIL'}
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-lg p-4">
                      <div className="text-xs text-slate-500">Visual Parity</div>
                      <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
                        {result.visualDiff?.available
                          ? `${(result.visualDiff.overallParityPercent ?? result.visualDiff.overallSimilarity * 100).toFixed(2)}%`
                          : 'N/A'}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500 tabular-nums">
                        MAE {(result.visualDiff?.meanAbsoluteError ?? 0).toFixed(2)} · Deterministic SHA-256
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-lg p-4">
                      <div className="text-xs text-slate-500">VB Logic Tests</div>
                      <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900">
                        {result.logicTests.passed}/{result.logicTests.total}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {result.logicTests.status} · {result.renderStatus.status}
                      </div>
                    </div>
                  </div>

                  {/* Finalization & Render Notice */}
                  <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-2.5 text-xs">
                      {result.finalized ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-700 shrink-0" />
                      )}
                      <span className="font-medium text-slate-900">
                        {result.finalized
                          ? `Artifacts finalized (RDLC ${result.rdlcValidation.checkedRules || 15}-point validation & VB logic tests passed).`
                          : 'Finalization blocked by validation or logic test gate.'}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600">{result.renderStatus.message}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        onClick={handleDownloadReportSummary}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download report-summary.json
                      </button>
                      <button
                        onClick={() => setSection('layout')}
                        className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
                      >
                        Inspect Tablix Grid →
                      </button>
                      <button
                        onClick={() => {
                          setArtifactsInitialTab('preview');
                          setSection('artifacts');
                        }}
                        className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
                      >
                        Visual Preview &amp; PDF →
                      </button>
                      <button
                        onClick={() => {
                          setArtifactsInitialTab('rdlc');
                          setSection('artifacts');
                        }}
                        className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap"
                      >
                        View RDLC &amp; VB →
                      </button>
                    </div>
                  </div>

                  {/* Structured Pipeline Log */}
                  <div className="bg-white border border-slate-200 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Terminal className="w-4 h-4 text-slate-600" />
                      <h3 className="text-sm font-semibold text-slate-900">Structured Execution Log</h3>
                    </div>
                    <div className="bg-slate-950 text-slate-200 rounded-md p-3 font-mono text-[11px] space-y-1 max-h-60 overflow-y-auto">
                      {result.logs.map((entry, idx) => (
                        <div key={idx}>
                          <span className="text-slate-400">[{entry.level}]</span>{' '}
                          <span className="text-blue-300">[{entry.stage}]</span> {entry.message}
                          {entry.data ? (
                            <span className="text-slate-400"> {JSON.stringify(entry.data)}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {/* Staged Output RDLC Previews */}
              {stagedOutputs.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-900">Staged Output RDLC Visual Previews</h2>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Inspect generated RDLC packages from <span className="font-mono">output/</span> with 15-point validation and programmatic 1:1 coordinate rendering.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {stagedOutputs.map((item) => (
                        <button
                          key={item.folder}
                          onClick={() => loadStagedOutputPreview(item.folder)}
                          disabled={loadingStagedPreview}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50 disabled:opacity-50"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          {loadingStagedPreview && selectedStagedPreview?.folder === item.folder
                            ? 'Rendering...'
                            : `${item.folder} (${Math.round(item.rdlcBytes / 1024)} KB)`}
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedStagedPreview && (
                    <div className="space-y-3 border-t border-slate-200 pt-4">
                      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                        <div className="font-mono text-slate-700">
                          <span className="font-semibold text-slate-900">{selectedStagedPreview.rdlcFile}</span> ·{' '}
                          <span className={selectedStagedPreview.validation.valid ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
                            RDLC {selectedStagedPreview.validation.valid ? 'PASS' : 'FAIL'}
                          </span>{' '}
                          · {selectedStagedPreview.preview.pageCount} pages ({selectedStagedPreview.preview.pageWidth} ×{' '}
                          {selectedStagedPreview.preview.pageHeight}) · {selectedStagedPreview.preview.stats.tablixes} Tablixes (
                          {selectedStagedPreview.preview.stats.mergedCells} merged) ·{' '}
                          {selectedStagedPreview.preview.stats.embeddedImages} Embedded PNGs ·{' '}
                          {selectedStagedPreview.preview.stats.parameters} Parameters ·{' '}
                          {selectedStagedPreview.preview.collisions.length} overlaps
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => downloadStagedPdf(selectedStagedPreview.folder, selectedStagedPreview.rdlcFile)}
                            disabled={downloadingStagedPdf}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                          >
                            <FileDown className="w-3.5 h-3.5" />
                            {downloadingStagedPdf ? 'Rendering PDF...' : 'Download PDF'}
                          </button>
                          <button
                            onClick={() => {
                              const blob = new Blob([selectedStagedPreview.preview.html], { type: 'text/html;charset=utf-8' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `${selectedStagedPreview.folder}-preview.html`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Download preview.html
                          </button>
                        </div>
                      </div>
                      <iframe
                        title={`${selectedStagedPreview.folder} RDLC Preview`}
                        srcDoc={selectedStagedPreview.preview.html}
                        sandbox=""
                        className="w-full h-[640px] rounded-lg border border-slate-300 bg-slate-900"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {section === 'layout' && result && <LayoutInspector result={result} />}

          {section === 'artifacts' && result && <ArtifactsPanel result={result} initialTab={artifactsInitialTab} />}

          {section === 'verification' && result && (
            <VerificationPanel
              result={result}
              onVisualDiffUpdated={(diff) =>
                setResult((prev) => (prev ? { ...prev, visualDiff: diff } : prev))
              }
            />
          )}

          {section === 'mcp' && (
            <div className="space-y-6">
              <div className="border-b border-slate-200 pb-4">
                <h2 className="font-display text-xl font-bold text-slate-900">
                  MCP Tool Contracts, Skills Registry &amp; Configuration
                </h2>
                <p className="text-xs text-slate-600 mt-1">
                  All internal application services expose structured contracts ready for MCP exposure without rewriting business logic.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-5">
                <h3 className="text-sm font-semibold text-slate-900 mb-3">
                  MCP-Ready Application Service Operations
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-2 pr-4 font-medium">Tool Name</th>
                        <th className="py-2 pr-4 font-medium">Category</th>
                        <th className="py-2 pr-4 font-medium">Approval</th>
                        <th className="py-2 pr-4 font-medium">Service Handler</th>
                        <th className="py-2 font-medium">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mcpTools.map((t) => (
                        <tr key={t.name}>
                          <td className="py-2 pr-4 font-mono font-semibold text-slate-900">{t.name}</td>
                          <td className="py-2 pr-4 font-mono text-slate-700">
                            {t.category ?? (t.readOnly ? 'READ_ONLY' : 'MUTATION')}
                          </td>
                          <td className="py-2 pr-4 font-mono text-slate-600">
                            {t.approvalRequired ? 'explicit required' : 'not required'}
                          </td>
                          <td className="py-2 pr-4 font-mono text-blue-700">{t.handlerName}</td>
                          <td className="py-2 text-slate-600">{t.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-700" />
                    <h3 className="text-sm font-semibold text-slate-900">Skill Registry (skills/*.md)</h3>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {skills.map((sk) => (
                      <div key={sk.name} className="py-2.5">
                        <div className="font-mono text-xs font-semibold text-slate-900">{sk.name}</div>
                        <div className="text-xs text-slate-600 mt-0.5">{sk.purpose}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-900">Active Configuration (reportgen.config.yaml)</h3>
                  <pre className="text-[11px] font-mono bg-slate-950 text-slate-100 p-3 rounded-md overflow-auto max-h-80">
                    {JSON.stringify(configData, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
