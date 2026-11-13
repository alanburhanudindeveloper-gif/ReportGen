using System.Text;
using ReportGen.Core.Models;

namespace ReportGen.Vb.Generator
{
    public sealed class VbCodeGenerator
    {
        public string GenerateClass(ReportDefinitionModel definition, string targetNamespace = "ReportGen.Generated")
        {
            var sb = new StringBuilder();
            sb.AppendLine("Imports System");
            sb.AppendLine("Imports System.Data");
            sb.AppendLine();
            sb.AppendLine($"Namespace {targetNamespace}");
            sb.AppendLine($"    Public Class {definition.ReportName}Report");
            sb.AppendLine("        Public Function GetReportData() As DataTable");
            sb.AppendLine($"            Dim dt As New DataTable(\"{definition.DataSetName}\")");
            foreach (var f in definition.Fields)
            {
                var vbType = f.DataType == "System.Decimal" ? "GetType(Decimal)" : "GetType(String)";
                sb.AppendLine($"            dt.Columns.Add(\"{f.Name}\", {vbType})");
            }
            sb.AppendLine("            Return dt");
            sb.AppendLine("        End Function");
            sb.AppendLine();
            sb.AppendLine("        Public Function CalculateLineTotal(ByVal qty As Decimal, ByVal price As Decimal, ByVal discountPercent As Decimal) As Decimal");
            sb.AppendLine("            Dim gross As Decimal = qty * price");
            sb.AppendLine("            Return Math.Round(gross - (gross * (discountPercent / 100D)), 2, MidpointRounding.AwayFromZero)");
            sb.AppendLine("        End Function");
            sb.AppendLine("    End Class");
            sb.AppendLine("End Namespace");
            return sb.ToString();
        }
    }
}
