import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  FolderSearch,
  Play,
  ShieldCheck,
  Terminal,
  XCircle,
} from 'lucide-react';
import type {
  InsertDryRunPlan,
  InsertManifest,
  ProjectScanResult,
  ProposalAdaptationRunResult,
  StagingApprovalState,
} from '../engine/proposal/types.ts';

type StagingTab = 'builder' | 'element' | 'rdlc' | 'extraRdlc' | 'scenarios' | 'definition' | 'dummy';

export function ProposalWorkspace() {
  const [projectRoot, setProjectRoot] = useState('samples/SampleProposalProject');
  const [scanResult, setScanResult] = useState<ProjectScanResult | null>(null);
  const [selectedBenchmark, setSelectedBenchmark] = useState('MFA');
  const [productCode, setProductCode] = useState('EGA');
  const [planCode, setPlanCode] = useState('EGA-EXEC-2026');
  const [pdfAFile, setPdfAFile] = useState<File | null>(null);
  const [pdfBFile, setPdfBFile] = useState<File | null>(null);
  const [useAi, setUseAi] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<ProposalAdaptationRunResult | null>(null);

  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [stagingTab, setStagingTab] = useState<StagingTab>('builder');
  const [reviewer, setReviewer] = useState('lead-actuary-reviewer');
  const [approvalNotes, setApprovalNotes] = useState('Verified layout fidelity and mock markers.');
  const [approvalState, setApprovalState] = useState<StagingApprovalState | null>(null);
  const [dryRunPlan, setDryRunPlan] = useState<InsertDryRunPlan | null>(null);
  const [insertManifest, setInsertManifest] = useState<InsertManifest | null>(null);
  const [allowOverwrite, setAllowOverwrite] = useState(false);

  const handleScanProject = async () => {
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch('/api/proposal/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Project scan failed');
      setScanResult(data);
      if (data.products?.length > 0 && !data.products.some((p: { productCode: string }) => p.productCode === selectedBenchmark)) {
        setSelectedBenchmark(data.products[0].productCode);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRunAdaptation = async (useFixture: boolean) => {
    if (!useFixture && !pdfAFile) {
      setError('Upload PDF A (New Product Template) or run the Two-PDF Sample Fixture.');
      return;
    }
    setBusy(true);
    setError(null);
    setDryRunPlan(null);
    setInsertManifest(null);
    try {
      const form = new FormData();
      form.append('useFixture', String(useFixture));
      form.append('useAi', String(useAi));
      form.append('projectRoot', projectRoot);
      form.append('productCode', productCode);
      form.append('planCode', planCode);
      form.append('benchmarkProductCode', selectedBenchmark);
      if (pdfAFile && !useFixture) form.append('pdfA', pdfAFile);
      if (pdfBFile && !useFixture) form.append('pdfB', pdfBFile);

      const resp = await fetch('/api/proposal/run', { method: 'POST', body: form });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Proposal adaptation failed');
      setRunResult(data);
      setApprovalState(data.staging.approval);
      setEditedValues({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmField = async (fieldName: string, currentVal: string | number) => {
    if (!runResult) return;
    setBusy(true);
    setError(null);
    try {
      const val = editedValues[fieldName] ?? String(currentVal);
      const resp = await fetch('/api/proposal/confirm-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productCode: runResult.productCode,
          confirmations: [{ field: fieldName, value: val, status: 'CONFIRMED' }],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Field confirmation failed');
      setRunResult(data);
      setApprovalState(data.staging.approval);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleApproval = async (decision: 'APPROVED' | 'REJECTED') => {
    if (!runResult) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch('/api/proposal/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productCode: runResult.productCode,
          approvedBy: reviewer,
          decision,
          policyOverrideWarnings: runResult.testHarness.warnings.length > 0,
          notes: approvalNotes,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Approval action failed');
      setApprovalState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDryRun = async () => {
    if (!runResult) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch('/api/proposal/insert-dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productCode: runResult.productCode,
          projectRoot,
          allowOverwrite,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Dry run failed');
      setDryRunPlan(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmInsert = async () => {
    if (!runResult) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch('/api/proposal/insert-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productCode: runResult.productCode,
          projectRoot,
          allowOverwrite,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Insert failed');
      setInsertManifest(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const [selectedExtraRdlcIdx, setSelectedExtraRdlcIdx] = useState(0);
  const [section4View, setSection4View] = useState<'plan' | 'diff'>('plan');

  const stagedCodePreview = (() => {
    if (!runResult) return '';
    if (stagingTab === 'builder') return runResult.builderVbCode;
    if (stagingTab === 'element') return runResult.elementVbCode;
    if (stagingTab === 'rdlc') return runResult.layoutRdlcXml;
    if (stagingTab === 'extraRdlc') {
      const extras = runResult.additionalRdlcFiles ?? [];
      if (extras.length === 0) return 'No additional RDLC files generated for this product.';
      const target = extras[selectedExtraRdlcIdx] ?? extras[0];
      return `' File: ${target.fileName}\n${target.xml}`;
    }
    if (stagingTab === 'scenarios') {
      return JSON.stringify(runResult.sampleScenarios ?? [], null, 2);
    }
    if (stagingTab === 'definition') return JSON.stringify(runResult.proposalDefinition, null, 2);
    return JSON.stringify(runResult.dummyDataJson, null, 2);
  })();

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-200 pb-4">
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900">
          Proposal Report Adaptation Engine
        </h1>
        <p className="text-sm text-slate-600 mt-1 max-w-3xl">
          Discover benchmark product patterns inside an existing VB.NET/RDLC solution, adapt from PDF A (template) and PDF B (reference output) into an isolated staging workspace, verify in the Report Test Harness, and insert only after explicit human approval.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3 text-xs text-red-800">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Proposal Adaptation Error</div>
            <div className="font-mono mt-0.5">{error}</div>
          </div>
        </div>
      )}

      {/* Stage 1 & 2: Project Scan + Two-PDF Input */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">
              1. Scan Existing .NET Project &amp; Select Benchmark
            </h2>
            <button
              onClick={handleScanProject}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
            >
              <FolderSearch className="w-3.5 h-3.5" />
              Scan Project
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Workspace Relative Project Root
            </label>
            <input
              type="text"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md bg-white text-slate-900"
            />
          </div>

          {scanResult && (
            <div className="space-y-3 border-t border-slate-200 pt-3">
              <div className="text-xs text-slate-600 tabular-nums">
                Scanned {scanResult.totalFilesScanned} file(s) · Discovered{' '}
                <span className="font-semibold text-slate-900">{scanResult.products.length}</span> product(s)
              </div>
              {scanResult.technologyProfile && (
                <div className="border border-slate-200 rounded-md p-2.5 bg-slate-50 text-[11px] font-mono text-slate-700 space-y-1">
                  <div>
                    Profile: <span className="font-semibold text-slate-900">{scanResult.technologyProfile.language}</span>
                    {' · '}
                    {scanResult.technologyProfile.targetFramework}
                    {' · '}
                    {scanResult.technologyProfile.projectFormat}
                    {' · '}
                    RDLC {scanResult.technologyProfile.rdlcVersion}
                  </div>
                  <div className="text-slate-600">
                    Runtime: {scanResult.technologyProfile.reportRuntime} · Compiler on host:{' '}
                    {scanResult.technologyProfile.compilerAvailableInEnvironment ? 'Available' : 'Unavailable (Linux)'}
                  </div>
                  {scanResult.deterministicCatalog && (
                    <div className="text-slate-600 pt-1 border-t border-slate-200 tabular-nums">
                      Catalog ({scanResult.deterministicCatalog.service}):{' '}
                      <span className="font-semibold text-slate-900">
                        {scanResult.deterministicCatalog.entryPointCount} ProposalBuilder.vb
                      </span>
                      {' · '}
                      Digest <span className="text-slate-900">{scanResult.deterministicCatalog.catalogDigest}</span>
                    </div>
                  )}
                  {scanResult.parsedProjects && scanResult.parsedProjects.length > 0 && (
                    <div className="text-slate-600 tabular-nums">
                      Projects:{' '}
                      {scanResult.parsedProjects
                        .map(
                          (pj) =>
                            `${pj.projectFileName} (${pj.compileItems.length} Compile, ${pj.embeddedResources.length} Embedded)`
                        )
                        .join(', ')}
                    </div>
                  )}
                </div>
              )}
              {scanResult.unresolvedReferences?.length > 0 && (
                <div className="border border-amber-200 rounded-md p-2.5 bg-amber-50 text-[11px] text-amber-900 space-y-0.5">
                  <div className="font-semibold">
                    Unresolved References ({scanResult.unresolvedReferences.length})
                  </div>
                  {scanResult.unresolvedReferences.map((u, idx) => (
                    <div key={idx} className="font-mono">
                      • [{u.productCode}] {u.kind} {u.symbolOrName} ← {u.referencedFrom}
                    </div>
                  ))}
                </div>
              )}
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {scanResult.products.map((prod) => (
                  <label
                    key={prod.productCode}
                    className={`flex items-start gap-3 p-3 text-xs cursor-pointer ${
                      selectedBenchmark === prod.productCode ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="benchmarkProduct"
                      checked={selectedBenchmark === prod.productCode}
                      onChange={() => setSelectedBenchmark(prod.productCode)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono font-semibold text-slate-900">
                        {prod.productCode} ({prod.planCodes.join(', ')})
                      </div>
                      <div className="text-slate-600 mt-0.5">{prod.discoveryReason}</div>
                      <div className="text-[11px] font-mono text-slate-500 mt-1 truncate">
                        Elements: {prod.dependencyGraph?.elements.map((e) => e.className).join(', ') || prod.elementSymbols.join(', ') || 'None'}
                        {' · '}
                        RDLCs: {prod.dependencyGraph?.rdlcFiles.map((r) => `${r.name} [${r.classification}]`).join(', ') || 'None'}
                      </div>
                      {prod.dependencyGraph && prod.dependencyGraph.productEngineCalls.length > 0 && (
                        <div className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">
                          ProductEngine: {prod.dependencyGraph.productEngineCalls.join(', ')}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-900">
            2. New Product Target &amp; Two-PDF Input
          </h2>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">New Product Code</label>
              <input
                type="text"
                value={productCode}
                onChange={(e) => setProductCode(e.target.value.toUpperCase())}
                className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Plan Code</label>
              <input
                type="text"
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value.toUpperCase())}
                className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                PDF A: New Product Template
              </label>
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => setPdfAFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-slate-600 file:mr-2 file:py-1.5 file:px-2.5 file:rounded file:border file:border-slate-300 file:bg-white file:text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                PDF B: Reference Generated PDF
              </label>
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => setPdfBFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-slate-600 file:mr-2 file:py-1.5 file:px-2.5 file:rounded file:border file:border-slate-300 file:bg-white file:text-xs"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(e) => setUseAi(e.target.checked)}
              className="rounded border-slate-300"
            />
            Use configured AI provider for ambiguous layout diffs &amp; status field reasoning (falls back deterministically when disabled/offline)
          </label>

          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3 text-xs">
              <a
                href="/api/proposal/fixture/pdfA"
                className="text-blue-700 hover:underline font-medium"
              >
                Download Sample PDF A
              </a>
              <a
                href="/api/proposal/fixture/pdfB"
                className="text-blue-700 hover:underline font-medium"
              >
                Download Sample PDF B
              </a>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleRunAdaptation(true)}
                disabled={busy}
                className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-md bg-white hover:bg-slate-50 disabled:opacity-50"
              >
                Run Two-PDF Fixture
              </button>
              <button
                onClick={() => handleRunAdaptation(false)}
                disabled={busy || !pdfAFile}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                {busy ? 'Adapting...' : 'Adapt Uploaded PDFs'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {runResult && (
        <>
          {/* Summary Strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Target / Benchmark</div>
              <div className="mt-1 text-base font-mono font-semibold text-slate-900">
                {runResult.productCode} ← {runResult.benchmarkProductCode}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">{runResult.planCode}</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Benchmark Reused</div>
              <div className="mt-1 text-base font-mono font-semibold tabular-nums text-slate-900">
                {runResult.diffReport.preservationPercent.toFixed(1)}%
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                RDLC {runResult.proposalDefinition.rdlcSchemaVersion} · {runResult.proposalDefinition.changes.length} changes
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Extracted &amp; Scenarios</div>
              <div className="mt-1 text-base font-mono font-semibold tabular-nums text-slate-900">
                {runResult.referenceExtract?.fields.length ?? 0} fields · {runResult.sampleScenarios.length} sets
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Traceable PDF B + stress sets
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Test Harness</div>
              <div
                className={`mt-1 text-base font-mono font-semibold ${
                  runResult.testHarness.overallStatus === 'PASS'
                    ? 'text-emerald-700'
                    : runResult.testHarness.overallStatus === 'WARN'
                    ? 'text-amber-700'
                    : 'text-red-700'
                }`}
              >
                {runResult.testHarness.overallStatus}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {runResult.testHarness.renderStatus.status}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Staging Approval</div>
              <div
                className={`mt-1 text-base font-mono font-semibold ${
                  approvalState?.status === 'APPROVED'
                    ? 'text-emerald-700'
                    : approvalState?.status === 'REJECTED'
                    ? 'text-red-700'
                    : 'text-amber-700'
                }`}
              >
                {approvalState?.status ?? 'PENDING'}
              </div>
              <div className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">
                output/{runResult.productCode}/
              </div>
            </div>
          </div>

          {/* Stage 3: Extracted Reference Data & Manual Confirmation */}
          {runResult.referenceExtract && (
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 overflow-x-auto">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  3. PDF B Reference Data Extraction &amp; Field Confirmation
                </h3>
                <span className="text-xs font-mono text-slate-500">
                  Source: {runResult.referenceExtract.sourcePdfFile}
                </span>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3 font-medium">Field</th>
                    <th className="py-2 pr-3 font-medium">Type &amp; Provenance</th>
                    <th className="py-2 pr-3 font-medium">Traceability</th>
                    <th className="py-2 pr-3 font-medium">Confidence</th>
                    <th className="py-2 pr-3 font-medium">Value / Override</th>
                    <th className="py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runResult.referenceExtract.fields.map((f) => (
                    <tr key={f.id}>
                      <td className="py-2 pr-3 font-mono font-semibold text-slate-900">
                        {f.field}
                        {f.isStatusField && (
                          <div className="text-[11px] font-normal text-blue-700">
                            Status states: {(f.candidateStates ?? []).join(' / ')}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 font-mono text-slate-600">
                        <div>{f.inferredType}</div>
                        <div className="text-[11px] text-slate-500">
                          {f.provenance} · {f.extractionMethod}
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-[11px] text-slate-500">
                        p{f.traceability.page} ({f.traceability.bbox.x.toFixed(2)},{' '}
                        {f.traceability.bbox.y.toFixed(2)}) · {f.traceability.labelContext}
                      </td>
                      <td className="py-2 pr-3 font-mono tabular-nums">
                        <span
                          className={
                            f.status === 'CONFIRMED' ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'
                          }
                        >
                          {(f.confidence * 100).toFixed(0)}% {f.status}
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <input
                          type="text"
                          value={editedValues[f.field] ?? String(f.value)}
                          onChange={(e) =>
                            setEditedValues((prev) => ({ ...prev, [f.field]: e.target.value }))
                          }
                          className="w-44 px-2 py-1 text-xs font-mono border border-slate-300 rounded"
                        />
                      </td>
                      <td className="py-2">
                        <button
                          onClick={() => handleConfirmField(f.field, f.value)}
                          disabled={busy}
                          className="px-2.5 py-1 text-[11px] font-medium border border-slate-300 rounded bg-white hover:bg-slate-50"
                        >
                          Confirm &amp; Re-stage
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Stage 4: Differential Modification Plan & Minimal-Mutation Diff Report */}
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  4. Differential Modification Plan &amp; Minimal-Mutation Diff Report
                </h3>
                <div className="text-xs font-mono text-slate-500 mt-0.5 tabular-nums">
                  Reused: {runResult.diffReport.preservationPercent.toFixed(1)}% · Unchanged:{' '}
                  {runResult.diffReport.unchangedCount} · Renamed: {runResult.diffReport.renamedCount} · Modified:{' '}
                  {runResult.diffReport.modifiedCount} · Added: {runResult.diffReport.addedCount} · Review:{' '}
                  {runResult.diffReport.requiresReviewCount}
                </div>
              </div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
                <button
                  onClick={() => setSection4View('plan')}
                  className={`px-3 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                    section4View === 'plan'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Change Plan ({runResult.proposalDefinition.changes.length})
                </button>
                <button
                  onClick={() => setSection4View('diff')}
                  className={`px-3 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 ${
                    section4View === 'diff'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Symbol Diff ({runResult.diffReport.items.length})
                </button>
              </div>
            </div>

            {section4View === 'plan' ? (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3 font-medium">ID</th>
                    <th className="py-2 pr-3 font-medium">Action</th>
                    <th className="py-2 pr-3 font-medium">Target Element</th>
                    <th className="py-2 pr-3 font-medium">Benchmark Symbol</th>
                    <th className="py-2 pr-3 font-medium">Tier</th>
                    <th className="py-2 font-medium">Rationale &amp; Output</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runResult.proposalDefinition.changes.map((c) => (
                    <tr key={c.changeId}>
                      <td className="py-2 pr-3 font-mono font-semibold text-slate-900">{c.changeId}</td>
                      <td className="py-2 pr-3 font-mono text-blue-700 font-medium">{c.decision}</td>
                      <td className="py-2 pr-3 text-slate-800">{c.targetElement}</td>
                      <td className="py-2 pr-3 font-mono text-slate-600">{c.benchmarkElement ?? '—'}</td>
                      <td className="py-2 pr-3 font-mono tabular-nums">
                        <span
                          className={
                            c.tier === 'HIGH'
                              ? 'text-emerald-700 font-semibold'
                              : c.tier === 'MEDIUM'
                              ? 'text-amber-700 font-semibold'
                              : 'text-red-700 font-semibold'
                          }
                        >
                          {c.tier} ({(c.confidence * 100).toFixed(0)}%)
                        </span>
                      </td>
                      <td className="py-2 text-slate-600">
                        <div>{c.reason}</div>
                        <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                          → {c.generatedFile} :: {c.generatedSymbol}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3 font-medium">File</th>
                    <th className="py-2 pr-3 font-medium">Symbol</th>
                    <th className="py-2 pr-3 font-medium">Kind</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 font-medium">Minimal-Mutation Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runResult.diffReport.items.map((item, idx) => (
                    <tr key={`${item.fileName}-${item.symbolName}-${idx}`}>
                      <td className="py-2 pr-3 font-mono text-slate-700">{item.fileName}</td>
                      <td className="py-2 pr-3 font-mono font-semibold text-slate-900">{item.symbolName}</td>
                      <td className="py-2 pr-3 font-mono text-slate-600">{item.symbolKind}</td>
                      <td
                        className={`py-2 pr-3 font-mono font-semibold ${
                          item.status === 'UNCHANGED' || item.status === 'RENAMED'
                            ? 'text-emerald-700'
                            : item.status === 'REQUIRES_REVIEW'
                            ? 'text-red-700'
                            : 'text-blue-700'
                        }`}
                      >
                        {item.status}
                      </td>
                      <td className="py-2 text-slate-600">{item.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Stage 5: Test Harness + Staged Artifacts Viewer */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <h3 className="text-sm font-semibold text-slate-900">
                5. Report Test Harness &amp; Diagnosis Agent
              </h3>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {runResult.testHarness.checks.map((chk) => (
                  <div key={chk.category} className="p-3 flex items-start justify-between gap-3 text-xs">
                    <div>
                      <div className="font-semibold text-slate-900">{chk.label}</div>
                      <div className="text-slate-600 mt-0.5">{chk.details}</div>
                    </div>
                    <span
                      className={`font-mono font-semibold shrink-0 ${
                        chk.status === 'PASS'
                          ? 'text-emerald-700'
                          : chk.status === 'FAIL'
                          ? 'text-red-700'
                          : 'text-amber-700'
                      }`}
                    >
                      {chk.status}
                    </span>
                  </div>
                ))}
              </div>
              {runResult.testHarness.warnings.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-900 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Warnings
                  </div>
                  {runResult.testHarness.warnings.map((w, i) => (
                    <div key={i} className="font-mono text-[11px]">
                      • {w}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Code2 className="w-4 h-4 text-slate-700" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    Staged Artifacts (output/{runResult.productCode}/)
                  </h3>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      ['builder', 'Builder.vb'],
                      ['element', 'Element.vb'],
                      ['rdlc', 'Layout.rdlc (2008)'],
                      ...(runResult.additionalRdlcFiles && runResult.additionalRdlcFiles.length > 0
                        ? ([['extraRdlc', `Extra RDLC (${runResult.additionalRdlcFiles.length})`]] as Array<
                            [StagingTab, string]
                          >)
                        : []),
                      ['scenarios', `Scenarios (${runResult.sampleScenarios.length})`],
                      ['definition', 'definition.json'],
                      ['dummy', 'dummy-data.json'],
                    ] as Array<[StagingTab, string]>
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setStagingTab(id)}
                      className={`px-2 py-1 text-[11px] font-mono rounded border whitespace-nowrap shrink-0 ${
                        stagingTab === id
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {stagingTab === 'extraRdlc' && runResult.additionalRdlcFiles && runResult.additionalRdlcFiles.length > 1 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-600">Additional RDLC:</span>
                  {runResult.additionalRdlcFiles.map((f, idx) => (
                    <button
                      key={f.fileName}
                      onClick={() => setSelectedExtraRdlcIdx(idx)}
                      className={`px-2 py-0.5 font-mono text-[11px] rounded border whitespace-nowrap shrink-0 ${
                        selectedExtraRdlcIdx === idx
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-300'
                      }`}
                    >
                      {f.fileName}
                    </button>
                  ))}
                </div>
              )}
              <pre className="bg-slate-950 text-slate-100 rounded-md p-3 text-[11px] font-mono overflow-auto max-h-80">
                {stagedCodePreview}
              </pre>
            </div>
          </div>

          {/* Stage 6: Human Approval Gate & Controlled Project Insertion */}
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-slate-800" />
                <h3 className="text-sm font-semibold text-slate-900">
                  6. Explicit Human Approval Gate &amp; Controlled Project Insert
                </h3>
              </div>
              {approvalState && (
                <span className="font-mono text-xs text-slate-600">
                  Builder SHA-256: {approvalState.artifactHashes.builderSha256.slice(0, 12)}… · RDLC SHA-256:{' '}
                  {approvalState.artifactHashes.layoutSha256.slice(0, 12)}…
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Reviewer Name</label>
                <input
                  type="text"
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Approval Notes</label>
                <input
                  type="text"
                  value={approvalNotes}
                  onChange={(e) => setApprovalNotes(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => handleApproval('APPROVED')}
                  disabled={busy || runResult.testHarness.fatalErrors.length > 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-700 text-white rounded-md hover:bg-emerald-800 disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Approve Staged Artifacts
                </button>
                <button
                  onClick={() => handleApproval('REJECTED')}
                  disabled={busy}
                  className="px-3 py-1.5 text-xs font-medium border border-red-300 text-red-700 rounded-md hover:bg-red-50"
                >
                  Reject Staging
                </button>
                <label className="ml-2 inline-flex items-center gap-1.5 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={allowOverwrite}
                    onChange={(e) => setAllowOverwrite(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  Allow overwrite after backup (--allow-overwrite)
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleDryRun}
                  disabled={busy}
                  className="px-3 py-1.5 text-xs font-medium border border-slate-300 bg-white text-slate-800 rounded-md hover:bg-slate-50"
                >
                  Run CLI Dry-Run (--dry-run)
                </button>
                <button
                  onClick={handleConfirmInsert}
                  disabled={busy || approvalState?.status !== 'APPROVED'}
                  className="px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
                >
                  Confirm Insert into Project (--confirm)
                </button>
              </div>
            </div>

            <div className="bg-slate-950 text-slate-200 rounded-md p-3 font-mono text-[11px] flex items-center gap-2 overflow-x-auto">
              <Terminal className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span>
                npm run proposal-cli -- insert --project {projectRoot} --generated output/{runResult.productCode} --dry-run
              </span>
            </div>

            {dryRunPlan && (
              <div className="border border-slate-200 rounded-md p-4 bg-slate-50 space-y-2 text-xs">
                <div className="font-semibold text-slate-900">
                  Dry-Run Plan: {dryRunPlan.canInsert ? 'READY TO INSERT' : 'BLOCKED'}
                </div>
                {dryRunPlan.blockingReasons.length > 0 && (
                  <div className="text-red-700 font-mono">
                    Blocking: {dryRunPlan.blockingReasons.join(' | ')}
                  </div>
                )}
                <div className="font-mono text-[11px] text-slate-700 space-y-1">
                  {dryRunPlan.wouldAdd.map((w) => (
                    <div key={w.target}>+ ADD {w.target} (sha256: {w.sha256.slice(0, 12)}…)</div>
                  ))}
                  {dryRunPlan.wouldModify.map((m) => (
                    <div key={m.target}>~ MODIFY {m.target} ({m.reason})</div>
                  ))}
                </div>
              </div>
            )}

            {insertManifest && (
              <div className="border border-emerald-200 bg-emerald-50 rounded-md p-4 space-y-2 text-xs">
                <div className="font-semibold text-emerald-900">
                  Insert Manifest Recorded ({insertManifest.status})
                </div>
                <div className="font-mono text-[11px] text-emerald-800">
                  Backup directory: {insertManifest.backupDirectory}
                </div>
                <pre className="bg-slate-950 text-slate-100 rounded p-3 text-[11px] font-mono overflow-auto max-h-56">
                  {JSON.stringify(insertManifest, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
