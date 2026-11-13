import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { StructuredLogger } from '../core/types.ts';
import { computeProductFilesHash } from './projectScanner.ts';
import {
  BenchmarkAnalysis,
  BenchmarkElementMeta,
  IBenchmarkInspector,
  ProductCatalogueEntry,
  VbAstFile,
} from './types.ts';
import { VbAstAnalyzer } from './vbAstAnalyzer.ts';

function asArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function parseInches(val: unknown, fallback: number): number {
  if (typeof val !== 'string') return fallback;
  const m = val.trim().match(/^(-?\d+(?:\.\d+)?)\s*in$/i);
  return m ? Number(m[1]) : fallback;
}

function detectRdlcSchemaVersion(xml: string): '2008' | '2016' | 'unknown' {
  if (/2008\/01\/reportdefinition/i.test(xml)) return '2008';
  if (/2016\/01\/reportdefinition|<ReportSections>/i.test(xml)) return '2016';
  return 'unknown';
}

export class BenchmarkInspector implements IBenchmarkInspector {
  private readonly logger: StructuredLogger;
  private readonly vbAstAnalyzer = new VbAstAnalyzer();

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public inspect(entry: ProductCatalogueEntry, cacheDir?: string): BenchmarkAnalysis {
    const cacheKey = `${entry.productCode}_${computeProductFilesHash(entry)}`;
    if (cacheDir) {
      const cachedPath = path.join(cacheDir, `${cacheKey}.json`);
      if (fs.existsSync(cachedPath)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cachedPath, 'utf-8')) as BenchmarkAnalysis;
          if (cached.cacheKey === cacheKey) {
            this.logger.info('BenchmarkInspector', `Loaded cached benchmark analysis for ${entry.productCode}`, {
              cacheKey,
            });
            return cached;
          }
        } catch {
          // Ignore corrupt cache and recompute
        }
      }
    }

    const rawBuilderSource =
      entry.builderPath && fs.existsSync(entry.builderPath)
        ? fs.readFileSync(entry.builderPath, 'utf-8')
        : '';

    const elementFiles = entry.elementPaths?.length
      ? entry.elementPaths
      : entry.elementPath
      ? [entry.elementPath]
      : [];
    const rawElementSources = elementFiles
      .filter((f) => fs.existsSync(f))
      .map((f) => ({
        fileName: path.basename(f),
        filePath: f,
        source: fs.readFileSync(f, 'utf-8'),
      }));
    const rawElementSource = rawElementSources[0]?.source ?? '';

    const rdlcFiles = entry.layoutPaths?.length
      ? entry.layoutPaths
      : entry.layoutPath
      ? [entry.layoutPath]
      : [];
    const rawLayoutXmls = rdlcFiles
      .filter((f) => fs.existsSync(f))
      .map((f) => {
        const xml = fs.readFileSync(f, 'utf-8');
        return {
          fileName: path.basename(f),
          filePath: f,
          xml,
          rdlcSchemaVersion: detectRdlcSchemaVersion(xml),
        };
      });
    const rawLayoutXml = rawLayoutXmls[0]?.xml ?? '';

    const builderAst: VbAstFile | undefined =
      entry.builderPath && rawBuilderSource
        ? this.vbAstAnalyzer.parseFile(entry.builderPath, rawBuilderSource)
        : undefined;
    const elementAsts: VbAstFile[] = rawElementSources.map((s) =>
      this.vbAstAnalyzer.parseFile(s.filePath, s.source)
    );

    const methods: BenchmarkAnalysis['methods'] = [];
    const elements: BenchmarkElementMeta[] = [];
    const productEngineBindings: BenchmarkAnalysis['productEngineBindings'] = [];
    const mockCommentMarkers: string[] = [];

    const collectAstMeta = (ast: VbAstFile) => {
      for (const t of ast.types) {
        for (const m of t.methods) {
          methods.push({
            name: m.name,
            signature: m.signature,
            sourceFile: ast.fileName,
            lineNumber: m.startLine,
          });
          if (/^Build.*Element$/i.test(m.name)) {
            elements.push({
              symbolName: m.name,
              className: t.name,
              labelHint: m.name
                .replace(/^Build/i, '')
                .replace(/Element$/i, '')
                .replace(/([A-Z])/g, ' $1')
                .trim(),
              referencedFields: m.referencedFields,
              usesProductEngine: m.productEngineCalls.length > 0,
              sourceFile: ast.fileName,
              lineNumber: m.startLine,
              startLine: m.startLine,
              endLine: m.endLine,
            });
          }
          for (const peCall of m.productEngineCalls) {
            productEngineBindings.push({
              field: m.referencedFields[0] ?? m.name,
              expression: peCall,
              lineNumber: m.startLine,
            });
          }
        }
      }
    };

    if (builderAst) collectAstMeta(builderAst);
    for (const eAst of elementAsts) collectAstMeta(eAst);

    for (const [src, name] of [
      [rawBuilderSource, path.basename(entry.builderPath ?? 'Builder.vb')],
      ...rawElementSources.map((e) => [e.source, e.fileName] as [string, string]),
    ]) {
      src.split(/\r?\n/).forEach((line, idx) => {
        if (/REPORTGEN_MOCK|REPORTGEN_REQUIRES_REVIEW|TODO:\s*MOCK|DUMMY/i.test(line)) {
          mockCommentMarkers.push(`${name}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    let dataSourceName = `${entry.productCode}DataSource`;
    let dataSetName = `${entry.productCode}ProposalDataSet`;
    const fieldsMap = new Map<string, { name: string; dataType: string }>();
    const parameters = new Set<string>();
    const expressions = new Set<string>();
    const visibilityRules = new Set<string>();
    const tablixNames = new Set<string>();
    const pageSettings: BenchmarkAnalysis['pageSettings'] = {
      pageWidthIn: 8.5,
      pageHeightIn: 11,
      marginsIn: { top: 0.4, right: 0.4, bottom: 0.4, left: 0.4 },
    };

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
    });

    rawLayoutXmls.forEach((rdlcEntry, idx) => {
      const xml = rdlcEntry.xml;
      try {
        const parsed = parser.parse(xml);
        const report = parsed?.Report;

        if (idx === 0) {
          const firstDs = asArray(report?.DataSources?.DataSource)[0];
          if (firstDs?.['@_Name']) dataSourceName = String(firstDs['@_Name']);
        }

        for (const ds of asArray(report?.DataSets?.DataSet)) {
          if (idx === 0 && ds?.['@_Name']) dataSetName = String(ds['@_Name']);
          for (const f of asArray(ds?.Fields?.Field)) {
            if (f?.['@_Name']) {
              const fName = String(f['@_Name']);
              fieldsMap.set(fName, {
                name: fName,
                dataType: String(f['rd:TypeName'] ?? f.TypeName ?? 'System.String'),
              });
            }
          }
        }

        for (const p of asArray(report?.ReportParameters?.ReportParameter)) {
          if (p?.['@_Name']) parameters.add(String(p['@_Name']));
        }

        // Supports BOTH RDLC 2008 (Report/Body & Report/Page) and RDLC 2016 (ReportSections)
        const section = asArray(report?.ReportSections?.ReportSection)[0];
        const body = section?.Body ?? report?.Body;
        const page = section?.Page ?? report?.Page;

        if (idx === 0 && page) {
          pageSettings.pageWidthIn = parseInches(page.PageWidth, 8.5);
          pageSettings.pageHeightIn = parseInches(page.PageHeight, 11);
          pageSettings.marginsIn = {
            top: parseInches(page.TopMargin, 0.4),
            right: parseInches(page.RightMargin, 0.4),
            bottom: parseInches(page.BottomMargin, 0.4),
            left: parseInches(page.LeftMargin, 0.4),
          };
        }

        for (const t of asArray(body?.ReportItems?.Tablix)) {
          if (t?.['@_Name']) tablixNames.add(String(t['@_Name']));
        }
      } catch (err) {
        this.logger.warn('BenchmarkInspector', `Partial XML inspection fallback for ${rdlcEntry.fileName}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      for (const m of xml.matchAll(/<Value>(=[^<]+)<\/Value>/g)) {
        expressions.add(m[1]);
      }
      for (const m of xml.matchAll(/<Hidden>([^<]+)<\/Hidden>/g)) {
        visibilityRules.add(m[1]);
      }
    });

    const firstType = builderAst?.types[0];
    const namespaceName = firstType?.namespaceName || 'Insurance.Proposal.Reports';
    const builderClassName = firstType?.name || `${entry.productCode}ProposalBuilder`;
    const elementClassName =
      elementAsts[0]?.types[0]?.name || `${entry.productCode}ProposalElement`;

    const analysis: BenchmarkAnalysis = {
      productCode: entry.productCode,
      planCodes: entry.planCodes,
      cacheKey,
      analyzedAt: new Date().toISOString(),
      builderClassName,
      elementClassName,
      namespaceName,
      dataSourceName,
      dataSetName,
      fields: Array.from(fieldsMap.values()),
      parameters: Array.from(parameters),
      methods,
      elements,
      expressions: Array.from(expressions),
      visibilityRules: Array.from(visibilityRules),
      tablixNames: Array.from(tablixNames),
      pageSettings,
      productEngineBindings,
      mockCommentMarkers,
      rawBuilderSource,
      rawElementSource,
      rawElementSources,
      rawLayoutXml,
      rawLayoutXmls,
      dependencyGraph: entry.dependencyGraph,
      builderAst,
      elementAsts,
    };

    if (cacheDir) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, `${cacheKey}.json`), JSON.stringify(analysis, null, 2), 'utf-8');
    }

    this.logger.info('BenchmarkInspector', `AST inspected benchmark ${entry.productCode}`, {
      methods: methods.length,
      elements: elements.length,
      fields: analysis.fields.length,
      rdlcFiles: rawLayoutXmls.length,
    });

    return analysis;
  }
}
