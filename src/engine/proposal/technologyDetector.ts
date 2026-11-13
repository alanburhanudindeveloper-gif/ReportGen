import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { ReportGenError, ReportGenErrorCode, StructuredLogger } from '../core/types.ts';
import { TechnologyProfile } from './types.ts';

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

function walkFiles(dir: string, collector: string[] = []): string[] {
  if (!fs.existsSync(dir)) return collector;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walkFiles(full, collector);
      }
    } else if (entry.isFile()) {
      collector.push(full);
    }
  }
  return collector;
}

function hasBinary(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface ITechnologyDetector {
  detect(projectRoot: string): TechnologyProfile;
}

export class TechnologyDetector implements ITechnologyDetector {
  private readonly logger: StructuredLogger;

  constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public detect(projectRoot: string): TechnologyProfile {
    const resolvedRoot = path.resolve(projectRoot);
    if (!fs.existsSync(resolvedRoot)) {
      throw new ReportGenError(
        ReportGenErrorCode.TECHNOLOGY_DETECTION_FAILED,
        `Project root does not exist: ${resolvedRoot}`
      );
    }

    const allFiles = walkFiles(resolvedRoot);
    const vbprojFiles = allFiles.filter((f) => /\.vbproj$/i.test(f));
    const csprojFiles = allFiles.filter((f) => /\.csproj$/i.test(f));
    const vbFiles = allFiles.filter((f) => /\.vb$/i.test(f));
    const csFiles = allFiles.filter((f) => /\.cs$/i.test(f));
    const rdlcFiles = allFiles.filter((f) => /\.rdlc$/i.test(f));

    if (
      vbprojFiles.length === 0 &&
      csprojFiles.length === 0 &&
      vbFiles.length === 0 &&
      csFiles.length === 0
    ) {
      throw new ReportGenError(
        ReportGenErrorCode.TECHNOLOGY_DETECTION_FAILED,
        `No .vbproj, .csproj, .vb, or .cs source files discovered under ${resolvedRoot}.`
      );
    }

    const primaryProj = vbprojFiles[0] ?? csprojFiles[0];
    const isVb =
      vbprojFiles.length > 0 || (csprojFiles.length === 0 && vbFiles.length >= csFiles.length);
    const language: TechnologyProfile['language'] = isVb ? 'VB.NET' : 'C#';

    let projectFormat: TechnologyProfile['projectFormat'] = 'Directory';
    let targetFramework = 'Unknown';
    let projectType = 'Library';
    let rootNamespace: string | undefined;
    let optionStrict: string | undefined;
    let langVersionExplicit: string | undefined;
    const references = new Set<string>();
    const packages = new Set<string>();

    if (primaryProj) {
      const projXml = fs.readFileSync(primaryProj, 'utf-8');
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: true,
      });
      const parsed = parser.parse(projXml);
      const proj = parsed?.Project ?? {};
      const isSdkStyle = Boolean(proj?.['@_Sdk']);

      if (primaryProj.toLowerCase().endsWith('.vbproj')) {
        projectFormat = isSdkStyle ? 'SDK-style .vbproj' : 'Legacy .vbproj';
      } else {
        projectFormat = isSdkStyle ? 'SDK-style .csproj' : 'Legacy .csproj';
      }

      const propGroups = asArray(proj.PropertyGroup);
      for (const pg of propGroups) {
        if (!pg || typeof pg !== 'object') continue;
        if (pg.TargetFramework) targetFramework = String(pg.TargetFramework);
        else if (pg.TargetFrameworks) targetFramework = String(pg.TargetFrameworks);
        else if (pg.TargetFrameworkVersion) targetFramework = String(pg.TargetFrameworkVersion);

        if (pg.OutputType) projectType = `${String(pg.OutputType)} Assembly`;
        else if (isSdkStyle && targetFramework !== 'Unknown') projectType = 'Class Library / Report Module';

        if (pg.RootNamespace) rootNamespace = String(pg.RootNamespace);
        if (pg.OptionStrict) optionStrict = String(pg.OptionStrict);
        if (pg.LangVersion) langVersionExplicit = String(pg.LangVersion);
      }

      for (const ig of asArray(proj.ItemGroup)) {
        if (!ig || typeof ig !== 'object') continue;
        for (const c of asArray(ig.Compile)) {
          const inc = typeof c === 'string' ? c : c?.['@_Include'];
          if (inc) references.add(String(inc));
        }
        for (const emb of asArray(ig.EmbeddedResource)) {
          const inc = typeof emb === 'string' ? emb : emb?.['@_Include'];
          if (inc) references.add(String(inc));
        }
        for (const r of asArray(ig.Reference)) {
          const inc = typeof r === 'string' ? r : r?.['@_Include'];
          if (inc) references.add(String(inc));
        }
        for (const pr of asArray(ig.PackageReference)) {
          const inc = pr?.['@_Include'];
          const ver = pr?.['@_Version'];
          if (inc) packages.add(ver ? `${inc}@${ver}` : String(inc));
        }
      }
    }

    // Also inspect companion dotnet runner packages if present in workspace when target relies on host ReportViewer
    let reportRuntime = 'Unknown / Not declared in target .vbproj';
    const packageList = Array.from(packages);
    const rvPkg = packageList.find((p) => /ReportViewer|Reporting/i.test(p));
    if (rvPkg) {
      reportRuntime = rvPkg;
    } else {
      const companionRunnerProj = path.resolve(
        process.cwd(),
        'dotnet',
        'vb-runner',
        'ReportViewerRunner.vbproj'
      );
      if (fs.existsSync(companionRunnerProj)) {
        const companionXml = fs.readFileSync(companionRunnerProj, 'utf-8');
        const match = companionXml.match(/Include="(ReportViewerCore\.NETCore)"\s+Version="([^"]+)"/i);
        if (match) {
          reportRuntime = `${match[1]}@${match[2]} (host runner in dotnet/vb-runner)`;
        }
      }
    }

    // Detect RDLC schema version from actual .rdlc files in project
    const detectedRdlcVersions = new Set<'2008' | '2016'>();
    for (const rdlc of rdlcFiles) {
      const xml = fs.readFileSync(rdlc, 'utf-8');
      if (/2008\/01\/reportdefinition/i.test(xml)) detectedRdlcVersions.add('2008');
      else if (/2016\/01\/reportdefinition/i.test(xml)) detectedRdlcVersions.add('2016');
    }
    let rdlcVersion: TechnologyProfile['rdlcVersion'] = 'unknown';
    if (detectedRdlcVersions.size === 1) {
      rdlcVersion = Array.from(detectedRdlcVersions)[0];
    } else if (detectedRdlcVersions.size > 1) {
      rdlcVersion = 'mixed';
    }

    const dotnetInstalled = hasBinary('dotnet');
    const msbuildInstalled = hasBinary('msbuild');
    const vbcInstalled = hasBinary('vbc');

    const languageVersion = langVersionExplicit
      ? langVersionExplicit
      : isVb
      ? `Visual Basic${optionStrict ? ` (OptionStrict ${optionStrict})` : ''}`
      : 'C#';

    const profile: TechnologyProfile = {
      language,
      languageVersion,
      projectType,
      targetFramework,
      projectFormat,
      buildTool: dotnetInstalled
        ? 'dotnet build'
        : msbuildInstalled
        ? 'msbuild'
        : 'dotnet / MSBuild (unavailable in current Linux environment)',
      compiler: vbcInstalled
        ? 'vbc'
        : dotnetInstalled
        ? 'Roslyn VB.NET / C# compiler'
        : isVb
        ? 'vbc / Roslyn VB.NET (unavailable in current Linux environment)'
        : 'csc / Roslyn (unavailable in current Linux environment)',
      rdlcVersion,
      reportRuntime,
      optionStrict,
      rootNamespace,
      references: Array.from(references),
      packages: packageList,
      compilerAvailableInEnvironment: dotnetInstalled || msbuildInstalled || vbcInstalled,
      reportRuntimeAvailableInEnvironment:
        dotnetInstalled && Boolean(process.env.REPORTVIEWER_CLI_PATH),
      detectedAt: new Date().toISOString(),
    };

    this.logger.info('TechnologyDetector', `Detected ${profile.language} / RDLC ${profile.rdlcVersion}`, {
      targetFramework: profile.targetFramework,
      projectFormat: profile.projectFormat,
      compilerAvailable: profile.compilerAvailableInEnvironment,
    });

    return profile;
  }
}
