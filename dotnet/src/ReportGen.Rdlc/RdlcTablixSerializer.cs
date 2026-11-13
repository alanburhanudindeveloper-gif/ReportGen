using System;
using System.Globalization;
using System.Linq;
using System.Xml.Linq;
using ReportGen.Core.Models;

namespace ReportGen.Rdlc.Generator
{
    public sealed class RdlcTablixSerializer
    {
        private static readonly XNamespace RdlNs = "http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition";
        private static readonly XNamespace RdNs = "http://schemas.microsoft.com/SQLServer/reporting/reportdesigner";

        private static string FmtIn(double inches) =>
            Math.Max(0.05, Math.Round(inches, 3)).ToString("0.###", CultureInfo.InvariantCulture) + "in";

        public XDocument Serialize(ReportDefinitionModel def, string embeddedVbCode)
        {
            var dataSets = new XElement(RdlNs + "DataSets",
                new XElement(RdlNs + "DataSet",
                    new XAttribute("Name", def.DataSetName),
                    new XElement(RdlNs + "Query",
                        new XElement(RdlNs + "DataSourceName", def.DataSourceName),
                        new XElement(RdlNs + "CommandText", "/* Local Query */")
                    ),
                    new XElement(RdlNs + "Fields",
                        def.Fields.Select(f =>
                            new XElement(RdlNs + "Field",
                                new XAttribute("Name", f.Name),
                                new XElement(RdlNs + "DataField", f.Name),
                                new XElement(RdNs + "TypeName", f.DataType)
                            )
                        )
                    )
                )
            );

            var tablixElements = def.TablixRegions.Select(t => BuildTablix(t));

            var report = new XElement(RdlNs + "Report",
                new XAttribute(XNamespace.Xmlns + "rd", RdNs),
                new XElement(RdlNs + "AutoRefresh", 0),
                new XElement(RdlNs + "DataSources",
                    new XElement(RdlNs + "DataSource",
                        new XAttribute("Name", def.DataSourceName),
                        new XElement(RdlNs + "ConnectionProperties",
                            new XElement(RdlNs + "DataProvider", "System.Data.DataSet"),
                            new XElement(RdlNs + "ConnectString", "/* Local Connection */")
                        )
                    )
                ),
                dataSets,
                new XElement(RdlNs + "ReportSections",
                    new XElement(RdlNs + "ReportSection",
                        new XElement(RdlNs + "Body",
                            new XElement(RdlNs + "ReportItems", tablixElements),
                            new XElement(RdlNs + "Height", FmtIn(def.PageHeightIn - 0.7)),
                            new XElement(RdlNs + "Style")
                        ),
                        new XElement(RdlNs + "Width", FmtIn(def.PageWidthIn - 0.7)),
                        new XElement(RdlNs + "Page",
                            new XElement(RdlNs + "PageHeight", FmtIn(def.PageHeightIn)),
                            new XElement(RdlNs + "PageWidth", FmtIn(def.PageWidthIn)),
                            new XElement(RdlNs + "Style")
                        )
                    )
                ),
                new XElement(RdlNs + "Code", embeddedVbCode),
                new XElement(RdNs + "ReportUnitType", "Inch")
            );

            return new XDocument(new XDeclaration("1.0", "utf-8", null), report);
        }

        private static XElement BuildTablix(TablixRegionModel tablix)
        {
            return new XElement(RdlNs + "Tablix",
                new XAttribute("Name", tablix.Name),
                new XElement(RdlNs + "TablixBody",
                    new XElement(RdlNs + "TablixColumns",
                        tablix.ColumnWidthsIn.Select(w =>
                            new XElement(RdlNs + "TablixColumn",
                                new XElement(RdlNs + "Width", FmtIn(w))
                            )
                        )
                    ),
                    new XElement(RdlNs + "TablixRows",
                        tablix.Rows.Select(r =>
                            new XElement(RdlNs + "TablixRow",
                                new XElement(RdlNs + "Height", FmtIn(r.HeightIn)),
                                new XElement(RdlNs + "TablixCells",
                                    r.Cells.Select(c =>
                                        c.SkipBecauseMerged
                                            ? new XElement(RdlNs + "TablixCell")
                                            : new XElement(RdlNs + "TablixCell",
                                                new XElement(RdlNs + "CellContents",
                                                    new XElement(RdlNs + "Textbox",
                                                        new XAttribute("Name", c.Name),
                                                        new XElement(RdlNs + "CanGrow", "true"),
                                                        new XElement(RdlNs + "Paragraphs",
                                                            new XElement(RdlNs + "Paragraph",
                                                                new XElement(RdlNs + "TextRuns",
                                                                    new XElement(RdlNs + "TextRun",
                                                                        new XElement(RdlNs + "Value", c.Value)
                                                                    )
                                                                )
                                                            )
                                                        )
                                                    )
                                                )
                                            )
                                    )
                                )
                            )
                        )
                    )
                ),
                new XElement(RdlNs + "TablixColumnHierarchy",
                    new XElement(RdlNs + "TablixMembers",
                        tablix.ColumnWidthsIn.Select(_ => new XElement(RdlNs + "TablixMember"))
                    )
                ),
                new XElement(RdlNs + "TablixRowHierarchy",
                    new XElement(RdlNs + "TablixMembers",
                        tablix.Rows.Select((r, idx) =>
                            tablix.IsRepeatingDetail && r.IsDetailRow
                                ? new XElement(RdlNs + "TablixMember",
                                    new XElement(RdlNs + "Group", new XAttribute("Name", $"Details_{tablix.Name}_{idx}"))
                                  )
                                : new XElement(RdlNs + "TablixMember",
                                    new XElement(RdlNs + "KeepWithGroup", "After")
                                  )
                        )
                    )
                ),
                new XElement(RdlNs + "DataSetName", tablix.DataSetName),
                new XElement(RdlNs + "Top", FmtIn(tablix.TopIn)),
                new XElement(RdlNs + "Left", FmtIn(tablix.LeftIn)),
                new XElement(RdlNs + "Height", FmtIn(tablix.HeightIn)),
                new XElement(RdlNs + "Width", FmtIn(tablix.WidthIn))
            );
        }
    }
}
