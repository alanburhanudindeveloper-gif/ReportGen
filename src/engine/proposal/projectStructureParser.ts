import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { ReportGenError, ReportGenErrorCode, StructuredLogger } from '../core/types.ts';
import {
  ParsedDotNetProject,
  ParsedProjectMember,
  ProjectFileInclusion,
} from './types.ts';

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

function normalizePosixRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

function walkFilesDeterministic(dir: string, collector: string[] = []): string[] {
  if (!fs.existsSync(dir)) return collector;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkFilesDeterministic(full, collector);
      }
    } else if (entry.isFile()) {
      collector.push(full);
    }
  }
  return collector;
}

function globToRegExp(pattern: string): RegExp {
  const norm = normalizePosixRel(pattern);
  const escaped = norm
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '__GLOBSTAR_SLASH__')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/__GLOBSTAR_SLASH__/g, '(?:.*/)?')
    .replace(/__GLOBSTAR__/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function resolveMsBuildPattern(
  pattern: string,
  projectDir: string,
  diskFilesRel: string[]
): Array<{ rel: string; abs: string; exists: boolean }> {
  const cleanRel = normalizePosixRel(pattern);
  if (!/[*?]/.test(cleanRel)) {
    const abs = path.resolve(projectDir, cleanRel);
    return [{ rel: cleanRel, abs, exists: fs.existsSync(abs) }];
  }
  const re = globToRegExp(cleanRel);
  const matched = diskFilesRel.filter((rel) => re.test(rel));
  return matched.map((rel) => ({
    rel,
    abs: path.resolve(projectDir, rel),
    exists: true,
  }));
}

export class ProjectStructureParser {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public discoverProjectFiles(projectRoot: string): string[] {
    const resolvedRoot = path.resolve(projectRoot);
    if (!fs.existsSync(resolvedRoot)) {
      throw new ReportGenError(
        ReportGenErrorCode.TECHNOLOGY_DETECTION_FAILED,
        `Project root does not exist: ${resolvedRoot}`
      );
    }

    const allFiles = walkFilesDeterministic(resolvedRoot);
    const projectSet = new Set<string>(
      allFiles
        .filter((f) => /\.(vbproj|csproj)$/i.test(f))
        .map((f) => path.resolve(f))
    );

    // Also inspect .sln files to discover linked .vbproj/.csproj outside immediate root if valid inside root
    const slnFiles = allFiles.filter((f) => /\.sln$/i.test(f));
    for (const sln of slnFiles) {
      const content = fs.readFileSync(sln, 'utf-8');
      const slnDir = path.dirname(sln);
      for (const m of content.matchAll(/Project\([^)]+\)\s*=\s*"[^"]+",\s*"([^"]+\.(?:vbproj|csproj))"/gi)) {
        const candidate = path.resolve(slnDir, normalizePosixRel(m[1]));
        if (fs.existsSync(candidate)) {
          projectSet.add(candidate);
        }
      }
    }

    return Array.from(projectSet).sort((a, b) => a.localeCompare(b));
  }

  public parseProjectFile(projectFilePath: string): ParsedDotNetProject {
    const absProj = path.resolve(projectFilePath);
    const projDir = path.dirname(absProj);
    const ext = path.extname(absProj).toLowerCase();
    const projectKind: ParsedDotNetProject['projectKind'] =
      ext === '.csproj' ? 'csproj' : 'vbproj';

    const xml = fs.readFileSync(absProj, 'utf-8');
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
    });
    const parsed = parser.parse(xml);
    const projNode = parsed?.Project ?? {};

    const isSdkStyle = Boolean(projNode?.['@_Sdk']);
    let enableDefaultItems = isSdkStyle;
    let enableDefaultCompileItems = isSdkStyle;
    let targetFramework = 'Unknown';
    let assemblyName: string | undefined;
    let rootNamespace: string | undefined;
    let optionStrict: string | undefined;

    for (const pg of asArray(projNode.PropertyGroup)) {
      if (!pg || typeof pg !== 'object') continue;
      if (pg.TargetFramework) targetFramework = String(pg.TargetFramework);
      else if (pg.TargetFrameworks) targetFramework = String(pg.TargetFrameworks);
      else if (pg.TargetFrameworkVersion) targetFramework = String(pg.TargetFrameworkVersion);

      if (pg.AssemblyName) assemblyName = String(pg.AssemblyName);
      if (pg.RootNamespace) rootNamespace = String(pg.RootNamespace);
      if (pg.OptionStrict) optionStrict = String(pg.OptionStrict);

      if (pg.EnableDefaultItems !== undefined) {
        enableDefaultItems = String(pg.EnableDefaultItems).toLowerCase() !== 'false';
      }
      if (pg.EnableDefaultCompileItems !== undefined) {
        enableDefaultCompileItems = String(pg.EnableDefaultCompileItems).toLowerCase() !== 'false';
      }
    }

    const diskFilesRel = walkFilesDeterministic(projDir)
      .map((f) => normalizePosixRel(path.relative(projDir, f)))
      .sort((a, b) => a.localeCompare(b));

    const excludedPatterns = new Set<string>();
    const compileMap = new Map<string, ParsedProjectMember>();
    const embeddedMap = new Map<string, ParsedProjectMember>();
    const rdlcMap = new Map<string, ParsedProjectMember>();
    const projectRefs = new Set<string>();

    const registerMember = (
      targetMap: Map<string, ParsedProjectMember>,
      rel: string,
      abs: string,
      exists: boolean,
      itemType: ParsedProjectMember['itemType'],
      inclusionSource: ProjectFileInclusion
    ) => {
      const key = rel.toLowerCase();
      if (!targetMap.has(key)) {
        targetMap.set(key, {
          relativePath: rel,
          absolutePath: abs,
          itemType,
          inclusionSource,
          existsOnDisk: exists,
        });
      }
      if (rel.toLowerCase().endsWith('.rdlc') && !rdlcMap.has(key)) {
        rdlcMap.set(key, {
          relativePath: rel,
          absolutePath: abs,
          itemType,
          inclusionSource,
          existsOnDisk: exists,
        });
      }
    };

    for (const ig of asArray(projNode.ItemGroup)) {
      if (!ig || typeof ig !== 'object') continue;

      for (const c of asArray(ig.Compile)) {
        if (typeof c === 'string') {
          for (const item of resolveMsBuildPattern(c, projDir, diskFilesRel)) {
            registerMember(compileMap, item.rel, item.abs, item.exists, 'Compile', 'explicit_compile');
          }
          continue;
        }
        if (c?.['@_Remove']) excludedPatterns.add(normalizePosixRel(String(c['@_Remove'])));
        const inc = c?.['@_Include'];
        if (inc) {
          for (const item of resolveMsBuildPattern(String(inc), projDir, diskFilesRel)) {
            registerMember(compileMap, item.rel, item.abs, item.exists, 'Compile', 'explicit_compile');
          }
        }
      }

      for (const emb of asArray(ig.EmbeddedResource)) {
        if (typeof emb === 'string') {
          for (const item of resolveMsBuildPattern(emb, projDir, diskFilesRel)) {
            registerMember(
              embeddedMap,
              item.rel,
              item.abs,
              item.exists,
              'EmbeddedResource',
              'explicit_embedded_resource'
            );
          }
          continue;
        }
        if (emb?.['@_Remove']) excludedPatterns.add(normalizePosixRel(String(emb['@_Remove'])));
        const inc = emb?.['@_Include'];
        if (inc) {
          for (const item of resolveMsBuildPattern(String(inc), projDir, diskFilesRel)) {
            registerMember(
              embeddedMap,
              item.rel,
              item.abs,
              item.exists,
              'EmbeddedResource',
              'explicit_embedded_resource'
            );
          }
        }
      }

      for (const content of asArray(ig.Content)) {
        const inc = typeof content === 'string' ? content : content?.['@_Include'];
        if (inc) {
          for (const item of resolveMsBuildPattern(String(inc), projDir, diskFilesRel)) {
            if (item.rel.toLowerCase().endsWith('.rdlc')) {
              registerMember(rdlcMap, item.rel, item.abs, item.exists, 'Content', 'explicit_content');
            }
          }
        }
      }

      for (const none of asArray(ig.None)) {
        const inc = typeof none === 'string' ? none : none?.['@_Include'];
        if (inc) {
          for (const item of resolveMsBuildPattern(String(inc), projDir, diskFilesRel)) {
            if (item.rel.toLowerCase().endsWith('.rdlc')) {
              registerMember(rdlcMap, item.rel, item.abs, item.exists, 'None', 'explicit_content');
            }
          }
        }
      }

      for (const pr of asArray(ig.ProjectReference)) {
        const inc = typeof pr === 'string' ? pr : pr?.['@_Include'];
        if (inc) {
          projectRefs.add(path.resolve(projDir, normalizePosixRel(String(inc))));
        }
      }
    }

    const excludeRegexes = Array.from(excludedPatterns).map((p) => globToRegExp(p));
    const isExcluded = (rel: string) => excludeRegexes.some((re) => re.test(rel));

    // Apply <Compile Remove="..." /> and SDK default glob rules deterministically
    if (isSdkStyle && enableDefaultItems && enableDefaultCompileItems) {
      const codeExt = projectKind === 'vbproj' ? '.vb' : '.cs';
      for (const rel of diskFilesRel) {
        if (rel.toLowerCase().endsWith(codeExt) && !isExcluded(rel)) {
          registerMember(
            compileMap,
            rel,
            path.resolve(projDir, rel),
            true,
            'Compile',
            'sdk_default_glob'
          );
        }
      }
    }

    if (isSdkStyle && enableDefaultItems) {
      for (const rel of diskFilesRel) {
        if (rel.toLowerCase().endsWith('.rdlc') && !isExcluded(rel)) {
          registerMember(
            rdlcMap,
            rel,
            path.resolve(projDir, rel),
            true,
            'None',
            'sdk_default_glob'
          );
        }
      }
    }

    const sortByRel = (a: ParsedProjectMember, b: ParsedProjectMember) =>
      a.relativePath.localeCompare(b.relativePath);

    const compileItems = Array.from(compileMap.values())
      .filter((m) => !isExcluded(m.relativePath))
      .sort(sortByRel);
    const embeddedResources = Array.from(embeddedMap.values())
      .filter((m) => !isExcluded(m.relativePath))
      .sort(sortByRel);
    const rdlcResources = Array.from(rdlcMap.values())
      .filter((m) => !isExcluded(m.relativePath))
      .sort(sortByRel);

    this.logger.info('ProjectStructureParser', `Parsed ${path.basename(absProj)}`, {
      isSdkStyle,
      targetFramework,
      compileItems: compileItems.length,
      embeddedResources: embeddedResources.length,
      rdlcResources: rdlcResources.length,
    });

    return {
      projectFilePath: absProj,
      projectFileName: path.basename(absProj),
      projectDirectory: projDir,
      projectKind,
      isSdkStyle,
      enableDefaultItems,
      targetFramework,
      assemblyName,
      rootNamespace,
      optionStrict,
      compileItems,
      embeddedResources,
      rdlcResources,
      projectReferences: Array.from(projectRefs).sort((a, b) => a.localeCompare(b)),
      excludedPatterns: Array.from(excludedPatterns).sort((a, b) => a.localeCompare(b)),
    };
  }

  public parseAllProjects(projectRoot: string): ParsedDotNetProject[] {
    const projectFiles = this.discoverProjectFiles(projectRoot);
    return projectFiles.map((f) => this.parseProjectFile(f));
  }
}
