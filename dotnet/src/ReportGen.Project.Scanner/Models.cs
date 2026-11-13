using System.Collections.Generic;

namespace ReportGen.Project.Scanner
{
    public sealed record ProjectItemMember(
        string RelativePath,
        string AbsolutePath,
        string ItemType,
        string InclusionSource,
        bool ExistsOnDisk
    );

    public sealed record ParsedProjectStructure(
        string ProjectFilePath,
        string ProjectFileName,
        string ProjectKind,
        bool IsSdkStyle,
        bool EnableDefaultItems,
        string TargetFramework,
        string? RootNamespace,
        string? AssemblyName,
        string? OptionStrict,
        IReadOnlyList<ProjectItemMember> CompileItems,
        IReadOnlyList<ProjectItemMember> EmbeddedResources,
        IReadOnlyList<ProjectItemMember> RdlcResources,
        IReadOnlyList<string> ProjectReferences
    );

    public sealed record ProposalBuilderEntryPoint(
        string ProductCode,
        IReadOnlyList<string> PlanCodes,
        string ClassName,
        string FilePath,
        string RelativePath,
        string? ProjectFilePath,
        bool RegisteredInProjectFile,
        IReadOnlyList<string> ElementClasses,
        IReadOnlyList<string> ElementFiles,
        IReadOnlyList<string> RdlcFiles,
        IReadOnlyList<string> ProductEngineCalls,
        bool HasProductEngineDependency,
        string CatalogHash
    );

    public sealed record DeterministicProductCatalog(
        string Service,
        string ProjectRoot,
        IReadOnlyList<string> ProjectFiles,
        string CatalogDigest,
        int EntryPointCount,
        IReadOnlyList<ProposalBuilderEntryPoint> Entries
    );
}
