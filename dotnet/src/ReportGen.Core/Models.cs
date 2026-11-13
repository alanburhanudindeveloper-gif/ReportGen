using System;
using System.Collections.Generic;

namespace ReportGen.Core.Models
{
    public sealed record RegionStyle(
        string FontFamily,
        double FontSizePt,
        bool Bold,
        bool Italic,
        string Color,
        string? BackgroundColor,
        string? BorderColor,
        double? BorderWidthPt,
        string TextAlign
    );

    public sealed record LayoutRegion(
        string Id,
        int PageNumber,
        string Type,
        double X,
        double Y,
        double Width,
        double Height,
        string? Text,
        RegionStyle Style,
        string SemanticRole,
        double Confidence,
        string BandKind
    );

    public sealed record TablixCellModel(
        int ColIndex,
        int RowIndex,
        int ColSpan,
        int RowSpan,
        bool SkipBecauseMerged,
        string Kind,
        string Name,
        string Value,
        bool IsExpression,
        RegionStyle Style
    );

    public sealed record TablixRowModel(
        double HeightIn,
        bool IsDetailRow,
        IReadOnlyList<TablixCellModel> Cells
    );

    public sealed record TablixRegionModel(
        string Name,
        int PageNumber,
        string BandKind,
        double TopIn,
        double LeftIn,
        double WidthIn,
        double HeightIn,
        string DataSetName,
        bool IsRepeatingDetail,
        IReadOnlyList<double> ColumnWidthsIn,
        IReadOnlyList<TablixRowModel> Rows
    );

    public sealed record ReportFieldModel(string Name, string DataType, object SampleValue, bool IsCalculated);

    public sealed record ReportDefinitionModel(
        string ReportName,
        string DataSourceName,
        string DataSetName,
        double PageWidthIn,
        double PageHeightIn,
        IReadOnlyList<ReportFieldModel> Fields,
        IReadOnlyList<TablixRegionModel> TablixRegions
    );
}
