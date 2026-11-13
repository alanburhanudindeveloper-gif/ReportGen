using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace ReportGen.Project.Scanner
{
    public sealed class ProjectScannerService
    {
        private readonly ProjectStructureParser _parser = new();

        public DeterministicProductCatalog BuildCatalog(string projectRoot)
        {
            var resolvedRoot = Path.GetFullPath(projectRoot);
            var projectFiles = _parser.DiscoverProjectFiles(resolvedRoot);
            var parsedProjects = projectFiles.Select(p => _parser.ParseProjectFile(p)).ToArray();

            var registeredVbToProj = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var allRdlcPaths = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var proj in parsedProjects)
            {
                foreach (var c in proj.CompileItems.Where(i => i.ExistsOnDisk && i.AbsolutePath.EndsWith(".vb", StringComparison.OrdinalIgnoreCase)))
                {
                    registeredVbToProj.TryAdd(Path.GetFullPath(c.AbsolutePath), proj.ProjectFilePath);
                }
                foreach (var r in proj.EmbeddedResources.Concat(proj.RdlcResources).Where(i => i.ExistsOnDisk && i.AbsolutePath.EndsWith(".rdlc", StringComparison.OrdinalIgnoreCase)))
                {
                    allRdlcPaths.Add(Path.GetFullPath(r.AbsolutePath));
                }
            }

            var vbFiles = Directory.GetFiles(resolvedRoot, "*.vb", SearchOption.AllDirectories)
                .Select(Path.GetFullPath)
                .OrderBy(f => f, StringComparer.Ordinal)
                .ToArray();

            var entries = new List<ProposalBuilderEntryPoint>();

            foreach (var vbFile in vbFiles)
            {
                var source = File.ReadAllText(vbFile);
                var classMatch = Regex.Match(source, @"\b(?:Class|Module)\s+([A-Za-z0-9_]+ProposalBuilder)\b", RegexOptions.IgnoreCase);
                var isBuilderFile = Path.GetFileName(vbFile).EndsWith("ProposalBuilder.vb", StringComparison.OrdinalIgnoreCase);

                if (!isBuilderFile && !classMatch.Success) continue;

                var className = classMatch.Success
                    ? classMatch.Groups[1].Value
                    : Path.GetFileNameWithoutExtension(vbFile);
                var productCode = Regex.Replace(className, @"ProposalBuilder$", "", RegexOptions.IgnoreCase).ToUpperInvariant();
                if (string.IsNullOrWhiteSpace(productCode))
                {
                    productCode = Path.GetFileNameWithoutExtension(vbFile).ToUpperInvariant();
                }

                var planCodes = Regex.Matches(source, @"PlanCode[^=]*=\s*""([A-Za-z0-9_-]+)""", RegexOptions.IgnoreCase)
                    .Select(m => m.Groups[1].Value)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(p => p, StringComparer.Ordinal)
                    .ToArray();
                if (planCodes.Length == 0) planCodes = new[] { $"{productCode}-STD" };

                var instantiations = Regex.Matches(source, @"\bNew\s+([A-Za-z0-9_.]+)\s*\(", RegexOptions.IgnoreCase)
                    .Select(m => m.Groups[1].Value.Split('.').Last())
                    .Where(c => c.EndsWith("Element", StringComparison.OrdinalIgnoreCase))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(c => c, StringComparer.Ordinal)
                    .ToArray();

                var rdlcRefs = Regex.Matches(source, @"""([^""\n]+\.rdlc)""", RegexOptions.IgnoreCase)
                    .Select(m => Path.GetFileName(m.Groups[1].Value))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(r => r, StringComparer.Ordinal)
                    .ToArray();

                var peCalls = Regex.Matches(source, @"\bProductEngine\.[A-Za-z0-9_]+", RegexOptions.IgnoreCase)
                    .Select(m => m.Value)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(c => c, StringComparer.Ordinal)
                    .ToArray();

                var relEntry = Path.GetRelativePath(resolvedRoot, vbFile).Replace('\\', '/');
                registeredVbToProj.TryGetValue(vbFile, out var declaringProj);

                var entryHash = ComputeEntryHash(productCode, className, relEntry, File.ReadAllBytes(vbFile));
                entries.Add(new ProposalBuilderEntryPoint(
                    ProductCode: productCode,
                    PlanCodes: planCodes,
                    ClassName: className,
                    FilePath: vbFile,
                    RelativePath: relEntry,
                    ProjectFilePath: declaringProj,
                    RegisteredInProjectFile: declaringProj is not null,
                    ElementClasses: instantiations,
                    ElementFiles: Array.Empty<string>(),
                    RdlcFiles: rdlcRefs,
                    ProductEngineCalls: peCalls,
                    HasProductEngineDependency: peCalls.Length > 0,
                    CatalogHash: entryHash
                ));
            }

            var sortedEntries = entries
                .OrderBy(e => e.ProductCode, StringComparer.Ordinal)
                .ThenBy(e => e.RelativePath, StringComparer.Ordinal)
                .ToArray();

            var relProjectFiles = projectFiles
                .Select(p => Path.GetRelativePath(resolvedRoot, p).Replace('\\', '/'))
                .OrderBy(p => p, StringComparer.Ordinal)
                .ToArray();

            var digest = ComputeCatalogDigest(resolvedRoot, projectFiles, sortedEntries);

            return new DeterministicProductCatalog(
                Service: "ReportGen.Project.Scanner",
                ProjectRoot: resolvedRoot,
                ProjectFiles: relProjectFiles,
                CatalogDigest: digest,
                EntryPointCount: sortedEntries.Length,
                Entries: sortedEntries
            );
        }

        private static string ComputeEntryHash(string productCode, string className, string relPath, byte[] bytes)
        {
            using var sha = SHA256.Create();
            var header = Encoding.UTF8.GetBytes($"code:{productCode}|class:{className}|rel:{relPath}\n");
            sha.TransformBlock(header, 0, header.Length, null, 0);
            sha.TransformFinalBlock(bytes, 0, bytes.Length);
            return Convert.ToHexString(sha.Hash!).ToLowerInvariant()[..20];
        }

        private static string ComputeCatalogDigest(string root, string[] projectFiles, ProposalBuilderEntryPoint[] entries)
        {
            using var sha = SHA256.Create();
            foreach (var pf in projectFiles.OrderBy(p => p, StringComparer.Ordinal))
            {
                var h = Encoding.UTF8.GetBytes($"proj:{Path.GetRelativePath(root, pf).Replace('\\', '/')}\n");
                sha.TransformBlock(h, 0, h.Length, null, 0);
                var data = File.ReadAllBytes(pf);
                sha.TransformBlock(data, 0, data.Length, null, 0);
            }
            foreach (var e in entries)
            {
                var line = Encoding.UTF8.GetBytes($"{e.ProductCode}:{e.RelativePath}:{e.CatalogHash}\n");
                sha.TransformBlock(line, 0, line.Length, null, 0);
            }
            sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            return Convert.ToHexString(sha.Hash!).ToLowerInvariant()[..24];
        }
    }
}
