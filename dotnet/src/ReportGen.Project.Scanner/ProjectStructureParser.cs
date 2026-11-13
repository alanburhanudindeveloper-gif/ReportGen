using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace ReportGen.Project.Scanner
{
    public sealed class ProjectStructureParser
    {
        private static readonly HashSet<string> IgnoredDirs = new(StringComparer.OrdinalIgnoreCase)
        {
            "node_modules", ".git", "bin", "obj", "dist", ".vs", ".reportgen-backup"
        };

        public IReadOnlyList<string> DiscoverProjectFiles(string projectRoot)
        {
            var resolvedRoot = Path.GetFullPath(projectRoot);
            if (!Directory.Exists(resolvedRoot))
            {
                throw new DirectoryNotFoundException($"Project root does not exist: {resolvedRoot}");
            }

            var files = WalkFilesDeterministic(resolvedRoot);
            var set = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var f in files.Where(f => f.EndsWith(".vbproj", StringComparison.OrdinalIgnoreCase)
                                            || f.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)))
            {
                set.Add(Path.GetFullPath(f));
            }

            foreach (var sln in files.Where(f => f.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)))
            {
                var content = File.ReadAllText(sln);
                var slnDir = Path.GetDirectoryName(sln)!;
                foreach (Match m in Regex.Matches(content, @"Project\([^)]+\)\s*=\s*""[^""]+"",\s*""([^""]+\.(?:vbproj|csproj))""", RegexOptions.IgnoreCase))
                {
                    var candidate = Path.GetFullPath(Path.Combine(slnDir, NormalizeRel(m.Groups[1].Value)));
                    if (File.Exists(candidate))
                    {
                        set.Add(candidate);
                    }
                }
            }

            return set.OrderBy(p => p, StringComparer.Ordinal).ToArray();
        }

        public ParsedProjectStructure ParseProjectFile(string projectFilePath)
        {
            var absProj = Path.GetFullPath(projectFilePath);
            var projDir = Path.GetDirectoryName(absProj)!;
            var ext = Path.GetExtension(absProj).ToLowerInvariant();
            var projectKind = ext == ".csproj" ? "csproj" : "vbproj";

            var doc = XDocument.Load(absProj);
            var root = doc.Root ?? throw new InvalidDataException($"Invalid project XML: {absProj}");

            var isSdkStyle = root.Attribute("Sdk") is not null;
            var enableDefaultItems = isSdkStyle;
            var enableDefaultCompileItems = isSdkStyle;
            var targetFramework = "Unknown";
            string? rootNamespace = null;
            string? assemblyName = null;
            string? optionStrict = null;

            foreach (var pg in root.Elements().Where(e => e.Name.LocalName == "PropertyGroup"))
            {
                targetFramework = GetProp(pg, "TargetFramework")
                    ?? GetProp(pg, "TargetFrameworks")
                    ?? GetProp(pg, "TargetFrameworkVersion")
                    ?? targetFramework;
                rootNamespace = GetProp(pg, "RootNamespace") ?? rootNamespace;
                assemblyName = GetProp(pg, "AssemblyName") ?? assemblyName;
                optionStrict = GetProp(pg, "OptionStrict") ?? optionStrict;

                var defItems = GetProp(pg, "EnableDefaultItems");
                if (defItems is not null) enableDefaultItems = !string.Equals(defItems, "false", StringComparison.OrdinalIgnoreCase);

                var defComp = GetProp(pg, "EnableDefaultCompileItems");
                if (defComp is not null) enableDefaultCompileItems = !string.Equals(defComp, "false", StringComparison.OrdinalIgnoreCase);
            }

            var diskFilesRel = WalkFilesDeterministic(projDir)
                .Select(f => NormalizeRel(Path.GetRelativePath(projDir, f)))
                .OrderBy(r => r, StringComparer.Ordinal)
                .ToArray();

            var compileItems = new SortedDictionary<string, ProjectItemMember>(StringComparer.OrdinalIgnoreCase);
            var embeddedItems = new SortedDictionary<string, ProjectItemMember>(StringComparer.OrdinalIgnoreCase);
            var rdlcItems = new SortedDictionary<string, ProjectItemMember>(StringComparer.OrdinalIgnoreCase);
            var projectRefs = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            var excluded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var ig in root.Elements().Where(e => e.Name.LocalName == "ItemGroup"))
            {
                foreach (var item in ig.Elements())
                {
                    var name = item.Name.LocalName;
                    var inc = item.Attribute("Include")?.Value;
                    var rem = item.Attribute("Remove")?.Value;

                    if (rem is not null) excluded.Add(NormalizeRel(rem));
                    if (string.IsNullOrWhiteSpace(inc)) continue;

                    if (name == "ProjectReference")
                    {
                        projectRefs.Add(Path.GetFullPath(Path.Combine(projDir, NormalizeRel(inc))));
                        continue;
                    }

                    foreach (var match in ExpandPattern(inc, projDir, diskFilesRel))
                    {
                        if (name == "Compile")
                        {
                            AddIfMissing(compileItems, new ProjectItemMember(match.Rel, match.Abs, "Compile", "explicit_compile", match.Exists));
                        }
                        else if (name == "EmbeddedResource")
                        {
                            var member = new ProjectItemMember(match.Rel, match.Abs, "EmbeddedResource", "explicit_embedded_resource", match.Exists);
                            AddIfMissing(embeddedItems, member);
                            if (match.Rel.EndsWith(".rdlc", StringComparison.OrdinalIgnoreCase))
                            {
                                AddIfMissing(rdlcItems, member);
                            }
                        }
                        else if ((name == "Content" || name == "None") && match.Rel.EndsWith(".rdlc", StringComparison.OrdinalIgnoreCase))
                        {
                            AddIfMissing(rdlcItems, new ProjectItemMember(match.Rel, match.Abs, name, "explicit_content", match.Exists));
                        }
                    }
                }
            }

            var excludeRegexes = excluded.Select(GlobToRegex).ToArray();
            bool IsExcluded(string rel) => excludeRegexes.Any(re => re.IsMatch(rel));

            if (isSdkStyle && enableDefaultItems && enableDefaultCompileItems)
            {
                var codeExt = projectKind == "vbproj" ? ".vb" : ".cs";
                foreach (var rel in diskFilesRel.Where(r => r.EndsWith(codeExt, StringComparison.OrdinalIgnoreCase) && !IsExcluded(r)))
                {
                    AddIfMissing(compileItems, new ProjectItemMember(rel, Path.GetFullPath(Path.Combine(projDir, rel)), "Compile", "sdk_default_glob", true));
                }
            }

            if (isSdkStyle && enableDefaultItems)
            {
                foreach (var rel in diskFilesRel.Where(r => r.EndsWith(".rdlc", StringComparison.OrdinalIgnoreCase) && !IsExcluded(r)))
                {
                    AddIfMissing(rdlcItems, new ProjectItemMember(rel, Path.GetFullPath(Path.Combine(projDir, rel)), "None", "sdk_default_glob", true));
                }
            }

            return new ParsedProjectStructure(
                ProjectFilePath: absProj,
                ProjectFileName: Path.GetFileName(absProj),
                ProjectKind: projectKind,
                IsSdkStyle: isSdkStyle,
                EnableDefaultItems: enableDefaultItems,
                TargetFramework: targetFramework,
                RootNamespace: rootNamespace,
                AssemblyName: assemblyName,
                OptionStrict: optionStrict,
                CompileItems: compileItems.Values.Where(v => !IsExcluded(v.RelativePath)).OrderBy(v => v.RelativePath, StringComparer.Ordinal).ToArray(),
                EmbeddedResources: embeddedItems.Values.Where(v => !IsExcluded(v.RelativePath)).OrderBy(v => v.RelativePath, StringComparer.Ordinal).ToArray(),
                RdlcResources: rdlcItems.Values.Where(v => !IsExcluded(v.RelativePath)).OrderBy(v => v.RelativePath, StringComparer.Ordinal).ToArray(),
                ProjectReferences: projectRefs.OrderBy(r => r, StringComparer.Ordinal).ToArray()
            );
        }

        private static void AddIfMissing(IDictionary<string, ProjectItemMember> map, ProjectItemMember item)
        {
            if (!map.ContainsKey(item.RelativePath)) map[item.RelativePath] = item;
        }

        private static string? GetProp(XElement pg, string name) =>
            pg.Elements().FirstOrDefault(e => e.Name.LocalName == name)?.Value;

        private static string NormalizeRel(string p) => p.Replace('\\', '/').TrimStart('.', '/');

        private static IEnumerable<(string Rel, string Abs, bool Exists)> ExpandPattern(string pattern, string projDir, string[] diskFilesRel)
        {
            var rel = NormalizeRel(pattern);
            if (!rel.Contains('*') && !rel.Contains('?'))
            {
                var abs = Path.GetFullPath(Path.Combine(projDir, rel));
                yield return (rel, abs, File.Exists(abs));
                yield break;
            }
            var re = GlobToRegex(rel);
            foreach (var match in diskFilesRel.Where(f => re.IsMatch(f)))
            {
                yield return (match, Path.GetFullPath(Path.Combine(projDir, match)), true);
            }
        }

        private static Regex GlobToRegex(string pattern)
        {
            var esc = Regex.Escape(NormalizeRel(pattern))
                .Replace(@"\*\*/", "__GS_S__")
                .Replace(@"\*\*", "__GS__")
                .Replace(@"\*", "[^/]*")
                .Replace(@"\?", "[^/]")
                .Replace("__GS_S__", "(?:.*/)?")
                .Replace("__GS__", ".*");
            return new Regex($"^{esc}$", RegexOptions.IgnoreCase);
        }

        private static List<string> WalkFilesDeterministic(string root)
        {
            var result = new List<string>();
            WalkRecursive(root, result);
            result.Sort(StringComparer.Ordinal);
            return result;
        }

        private static void WalkRecursive(string dir, List<string> collector)
        {
            foreach (var subDir in Directory.GetDirectories(dir).OrderBy(d => d, StringComparer.Ordinal))
            {
                var name = Path.GetFileName(subDir);
                if (!IgnoredDirs.Contains(name)) WalkRecursive(subDir, collector);
            }
            foreach (var file in Directory.GetFiles(dir).OrderBy(f => f, StringComparer.Ordinal))
            {
                collector.Add(file);
            }
        }
    }
}
