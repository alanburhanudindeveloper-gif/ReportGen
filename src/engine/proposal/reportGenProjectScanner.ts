import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { StructuredLogger } from '../core/types.ts';
import { ProjectStructureParser } from './projectStructureParser.ts';
import { TechnologyDetector } from './technologyDetector.ts';
import {
  DeterministicProductCatalog,
  DeterministicProductCatalogEntry,
  IReportGenProjectScanner,
  ParsedDotNetProject,
  ProductCatalogueEntry,
  ProjectScanResult,
  UnresolvedReference,
  VbAstFile,
} from './types.ts';
import { VbAstAnalyzer } from './vbAstAnalyzer.ts';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'bin',
  'obj',
  'dist',
  '.vs',
  '.reportgen-backup',
]);

function asArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function normalizePosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function walkFilesSorted(dir: string, collector: string[] = []): string[] {
  if (!fs.existsSync(dir)) return collector;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkFilesSorted(full, collector);
      }
    } else if (entry.isFile()) {
      collector.push(path.resolve(full));
    }
  }
  return collector;
}

function inferProductCodeFromBuilderAst(ast: VbAstFile, projectRoot: string): string {
  const builderClass = ast.types.find((t) => /ProposalBuilder$/i.test(t.name))?.name;
  if (builderClass) {
    return builderClass.replace(/ProposalBuilder$/i, '').toUpperCase();
  }
  const baseMatch = ast.fileName.match(/^([A-Za-z0-9]+?)(?:ProposalBuilder|ProposalElement|ProposalLayout)\./i);
  if (baseMatch?.[1]) return baseMatch[1].toUpperCase();

  const relDir = path.relative(projectRoot, path.dirname(ast.filePath));
  const parts = normalizePosix(relDir).split('/').filter(Boolean);
  const candidateFolder = parts[parts.length - 1];
  if (candidateFolder && !/^(proposal|reports|src)$/i.test(candidateFolder)) {
    return candidateFolder.toUpperCase();
  }
  return path.basename(ast.fileName, '.vb').toUpperCase();
}

function computeEntryCatalogHash(
  projectRoot: string,
  entry: ProductCatalogueEntry,
  builderClass: string,
  registeredInProjectFile: boolean
): string {
  const hash = crypto.createHash('sha256');
  hash.update(`code:${entry.productCode}|class:${builderClass}|reg:${registeredInProjectFile ? '1' : '0'}\n`);

  const files = Array.from(
    new Set([
      ...(entry.builderPath ? [entry.builderPath] : []),
      ...(entry.elementPaths ?? []),
      ...(entry.layoutPaths ?? []),
    ])
  ).sort((a, b) => normalizePosix(path.relative(projectRoot, a)).localeCompare(normalizePosix(path.relative(projectRoot, b))));

  for (const absPath of files) {
    const rel = normalizePosix(path.relative(projectRoot, absPath));
    hash.update(`file:${rel}\n`);
    if (fs.existsSync(absPath)) {
      hash.update(fs.readFileSync(absPath));
    }
  }
  return hash.digest('hex').slice(0, 20);
}

/**
 * ReportGen.Project.Scanner service
 * Parses VB.NET project structures (.vbproj/.csproj), identifies ProposalBuilder.vb
 * entry points, reconciles dependency graphs, and builds a deterministic product catalog.
 */
export class ReportGenProjectScanner implements IReportGenProjectScanner {
  private readonly logger: StructuredLogger;
  private readonly structureParser: ProjectStructureParser;
  private readonly vbAstAnalyzer = new VbAstAnalyzer();
  private readonly techDetector: TechnologyDetector;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
    this.structureParser = new ProjectStructureParser(logger);
    this.techDetector = new TechnologyDetector(logger);
  }

  public parseProjectStructures(projectRoot: string): ParsedDotNetProject[] {
    return this.structureParser.parseAllProjects(projectRoot);
  }

  public buildCatalog(projectRoot: string): DeterministicProductCatalog {
    return this.scanProject(projectRoot).deterministicCatalog!;
  }

  public scanProject(projectRoot: string): ProjectScanResult {
    const resolvedRoot = path.resolve(projectRoot);
    const technologyProfile = this.techDetector.detect(resolvedRoot);
    const parsedProjects = this.structureParser.parseAllProjects(resolvedRoot);

    const diskFiles = walkFilesSorted(resolvedRoot);
    const diskVbFiles = diskFiles.filter((f) => f.toLowerCase().endsWith('.vb'));
    const diskRdlcFiles = diskFiles.filter((f) => f.toLowerCase().endsWith('.rdlc'));

    // Build authoritative file sets from parsed .vbproj/.csproj structures
    const registeredVbSet = new Set<string>();
    const vbToProjectMap = new Map<string, string>();
    const projectRdlcSet = new Set<string>();

    for (const proj of parsedProjects) {
      for (const item of proj.compileItems) {
        if (item.existsOnDisk && item.absolutePath.toLowerCase().endsWith('.vb')) {
          const abs = path.resolve(item.absolutePath);
          registeredVbSet.add(abs);
          if (!vbToProjectMap.has(abs)) {
            vbToProjectMap.set(abs, proj.projectFilePath);
          }
        }
      }
      for (const res of [...proj.embeddedResources, ...proj.rdlcResources]) {
        if (res.existsOnDisk && res.absolutePath.toLowerCase().endsWith('.rdlc')) {
          projectRdlcSet.add(path.resolve(res.absolutePath));
        }
      }
    }

    const unregisteredVbFiles =
      parsedProjects.length > 0
        ? diskVbFiles.filter((f) => !registeredVbSet.has(path.resolve(f))).sort((a, b) => a.localeCompare(b))
        : [];

    // Prefer VB files registered in parsed projects; also inspect unregistered VB files so
    // orphan ProposalBuilder.vb files are explicitly flagged with registeredInProjectFile: false.
    const allVbFiles = Array.from(
      new Set([...Array.from(registeredVbSet), ...diskVbFiles])
    ).sort((a, b) => a.localeCompare(b));

    const allRdlcFiles = Array.from(
      new Set([...Array.from(projectRdlcSet), ...diskRdlcFiles])
    ).sort((a, b) => a.localeCompare(b));

    const allVbAsts = allVbFiles.map((f) => this.vbAstAnalyzer.parseFile(f));

    // Identify ProposalBuilder.vb entry points deterministically
    const builderAsts = allVbAsts.filter(
      (ast) =>
        /ProposalBuilder\.vb$/i.test(ast.fileName) ||
        /ProposalBuilder/i.test(ast.fileName) ||
        ast.types.some((t) => /ProposalBuilder$/i.test(t.name))
    );

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
    });

    const primaryProjectFile = parsedProjects[0]?.projectFilePath;
    const products: ProductCatalogueEntry[] = [];

    for (const bAst of builderAsts) {
      const productCode = inferProductCodeFromBuilderAst(bAst, resolvedRoot);
      const declaringProjectFile = vbToProjectMap.get(path.resolve(bAst.filePath));
      const registeredInProject =
        parsedProjects.length === 0 ? false : Boolean(declaringProjectFile);

      const depGraph = this.vbAstAnalyzer.buildDependencyGraph({
        productCode,
        builderAst: bAst,
        allVbAsts,
        allRdlcFiles,
      });

      const elementPaths = Array.from(new Set(depGraph.elements.map((e) => path.resolve(e.filePath)))).sort((a, b) =>
        a.localeCompare(b)
      );
      const layoutPaths = Array.from(
        new Set(
          depGraph.rdlcFiles
            .map((r) => r.resolvedPath)
            .filter((p): p is string => Boolean(p))
            .map((p) => path.resolve(p))
        )
      ).sort((a, b) => a.localeCompare(b));

      const primaryLayoutPath =
        layoutPaths.find((p) => /ProposalLayout\.rdlc$/i.test(p)) ?? layoutPaths[0];
      const primaryElementPath =
        elementPaths.find((p) => /ProposalElement\.vb$/i.test(p)) ?? elementPaths[0];

      const datasets = new Set<string>(depGraph.datasets);
      const parameters = new Set<string>();
      const expressions = new Set<string>();
      const elementSymbols = new Set<string>(depGraph.elements.flatMap((e) => e.methods));
      const dependencies = new Set<string>([
        ...bAst.imports,
        ...depGraph.productEngineCalls,
      ]);

      for (const rPath of layoutPaths) {
        if (!fs.existsSync(rPath)) continue;
        const xml = fs.readFileSync(rPath, 'utf-8');
        try {
          const parsed = parser.parse(xml);
          const report = parsed?.Report;
          const dsList: string[] = [];
          for (const ds of asArray(report?.DataSets?.DataSet)) {
            if (ds?.['@_Name']) {
              const name = String(ds['@_Name']);
              datasets.add(name);
              dsList.push(name);
            }
          }
          const matchingNode = depGraph.rdlcFiles.find(
            (r) => r.resolvedPath && path.resolve(r.resolvedPath) === rPath
          );
          if (matchingNode) matchingNode.datasets = dsList.sort((a, b) => a.localeCompare(b));

          for (const rp of asArray(report?.ReportParameters?.ReportParameter)) {
            if (rp?.['@_Name']) parameters.add(String(rp['@_Name']));
          }
        } catch {
          // Non-fatal fallback
        }
        for (const m of xml.matchAll(/=(?:Fields!|Parameters!|Code\.|IIf\()[^<"\n]{1,80}/g)) {
          if (expressions.size < 30) expressions.add(m[0]);
        }
      }

      depGraph.datasets = Array.from(datasets).sort((a, b) => a.localeCompare(b));
      depGraph.parameters = Array.from(parameters).sort((a, b) => a.localeCompare(b));

      const planCodes = Array.from(
        new Set(bAst.planCodes.length > 0 ? bAst.planCodes : [`${productCode}-STD`])
      ).sort((a, b) => a.localeCompare(b));

      const relatedFiles = Array.from(
        new Set([path.resolve(bAst.filePath), ...elementPaths, ...layoutPaths])
      ).sort((a, b) => a.localeCompare(b));

      const regNote = registeredInProject
        ? `registered in ${path.basename(declaringProjectFile!)}`
        : parsedProjects.length > 0
        ? 'unregistered in .vbproj/.csproj'
        : 'directory discovery';

      const discoveryReason = `Project.Scanner (${regNote}): ${bAst.fileName} -> ${elementPaths.length} Element file(s), ${layoutPaths.length} RDLC file(s), ${depGraph.productEngineCalls.length} ProductEngine call(s).`;

      products.push({
        productCode,
        planCodes,
        rootDirectory: path.dirname(bAst.filePath),
        builderPath: bAst.filePath,
        elementPath: primaryElementPath,
        elementPaths,
        layoutPath: primaryLayoutPath,
        layoutPaths,
        relatedFiles,
        projectFilePath: declaringProjectFile ?? primaryProjectFile,
        datasets: depGraph.datasets,
        parameters: depGraph.parameters,
        elementSymbols: Array.from(elementSymbols).sort((a, b) => a.localeCompare(b)),
        expressions: Array.from(expressions).sort((a, b) => a.localeCompare(b)),
        dependencies: Array.from(dependencies).sort((a, b) => a.localeCompare(b)),
        hasProductEngineDependency: depGraph.productEngineCalls.length > 0,
        discoveryReason,
        dependencyGraph: depGraph,
      });
    }

    products.sort(
      (a, b) =>
        a.productCode.localeCompare(b.productCode) ||
        (a.builderPath ?? '').localeCompare(b.builderPath ?? '')
    );

    // Cross-product RDLC reconciliation: shared, unused candidates, unresolved refs
    const rdlcUsageMap = new Map<
      string,
      { name: string; resolvedPath?: string; products: Set<string> }
    >();
    const usedRdlcPaths = new Set<string>();
    const allUnresolved: UnresolvedReference[] = [];

    for (const p of products) {
      for (const rPath of p.layoutPaths ?? []) {
        usedRdlcPaths.add(path.resolve(rPath));
      }
      for (const rNode of p.dependencyGraph?.rdlcFiles ?? []) {
        const key = (rNode.resolvedPath ? path.resolve(rNode.resolvedPath) : rNode.name).toLowerCase();
        const entry = rdlcUsageMap.get(key) ?? {
          name: rNode.name,
          resolvedPath: rNode.resolvedPath,
          products: new Set<string>(),
        };
        entry.products.add(p.productCode);
        rdlcUsageMap.set(key, entry);
      }
      allUnresolved.push(...(p.dependencyGraph?.unresolvedReferences ?? []));
    }

    const sharedRdlcs = Array.from(rdlcUsageMap.values())
      .filter((v) => v.products.size > 1)
      .map((v) => ({
        name: v.name,
        resolvedPath: v.resolvedPath,
        usedByProducts: Array.from(v.products).sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const sharedSet = new Set(sharedRdlcs.map((s) => s.name.toLowerCase()));
    for (const p of products) {
      for (const rNode of p.dependencyGraph?.rdlcFiles ?? []) {
        if (sharedSet.has(rNode.name.toLowerCase())) {
          rNode.classification = 'shared';
        }
      }
    }

    const unusedRdlcCandidates = allRdlcFiles
      .filter((f) => !usedRdlcPaths.has(path.resolve(f)))
      .sort((a, b) => a.localeCompare(b));

    // Build Deterministic Product Catalog (sorted & content-hashed without volatile timestamps)
    const catalogEntries: DeterministicProductCatalogEntry[] = products.map((prod) => {
      const builderClass = prod.dependencyGraph?.builderClass ?? `${prod.productCode}ProposalBuilder`;
      const registeredInProjectFile = Boolean(
        prod.builderPath && registeredVbSet.has(path.resolve(prod.builderPath))
      );
      return {
        productCode: prod.productCode,
        planCodes: [...prod.planCodes],
        entryPointClass: builderClass,
        entryPointFile: prod.builderPath ?? '',
        entryPointRelativePath: prod.builderPath
          ? normalizePosix(path.relative(resolvedRoot, prod.builderPath))
          : '',
        projectFilePath: prod.projectFilePath,
        registeredInProjectFile,
        elementClasses: (prod.dependencyGraph?.elements ?? [])
          .map((e) => e.className)
          .sort((a, b) => a.localeCompare(b)),
        elementFiles: (prod.elementPaths ?? [])
          .map((f) => normalizePosix(path.relative(resolvedRoot, f)))
          .sort((a, b) => a.localeCompare(b)),
        rdlcFiles: (prod.layoutPaths ?? [])
          .map((f) => normalizePosix(path.relative(resolvedRoot, f)))
          .sort((a, b) => a.localeCompare(b)),
        datasets: [...prod.datasets],
        parameters: [...prod.parameters],
        hasProductEngineDependency: prod.hasProductEngineDependency,
        catalogHash: computeEntryCatalogHash(
          resolvedRoot,
          prod,
          builderClass,
          registeredInProjectFile
        ),
      };
    });

    const digestHash = crypto.createHash('sha256');
    for (const proj of parsedProjects) {
      const relProj = normalizePosix(path.relative(resolvedRoot, proj.projectFilePath));
      digestHash.update(`proj:${relProj}\n`);
      digestHash.update(fs.readFileSync(proj.projectFilePath));
    }
    for (const ce of catalogEntries) {
      digestHash.update(`${ce.productCode}:${ce.entryPointRelativePath}:${ce.catalogHash}\n`);
    }

    const deterministicCatalog: DeterministicProductCatalog = {
      service: 'ReportGen.Project.Scanner',
      projectRoot: resolvedRoot,
      projectFiles: parsedProjects.map((p) =>
        normalizePosix(path.relative(resolvedRoot, p.projectFilePath))
      ),
      catalogDigest: digestHash.digest('hex').slice(0, 24),
      entryPointCount: catalogEntries.length,
      entries: catalogEntries,
    };

    this.logger.info('ReportGen.Project.Scanner', 'Parsed project structures and built deterministic catalog', {
      projectRoot: resolvedRoot,
      parsedProjects: parsedProjects.map((p) => p.projectFileName),
      catalogDigest: deterministicCatalog.catalogDigest,
      entryPointCount: deterministicCatalog.entryPointCount,
      unregisteredVbCount: unregisteredVbFiles.length,
      unresolvedCount: allUnresolved.length,
    });

    return {
      projectRoot: resolvedRoot,
      projectFilePath: primaryProjectFile,
      scannedAt: new Date().toISOString(),
      totalFilesScanned: diskFiles.length,
      technologyProfile,
      parsedProjects,
      deterministicCatalog,
      unregisteredVbFiles,
      products,
      sharedRdlcs,
      unusedRdlcCandidates,
      unresolvedReferences: allUnresolved,
    };
  }
}
