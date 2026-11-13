Imports System
Imports System.Data
Imports System.IO
Imports System.Text.Json
Imports Microsoft.Reporting.NETCore

Module Program
    Sub Main(ByVal args As String())
        If args.Length < 3 Then
            Console.Error.WriteLine("Usage: ReportViewerRunner <rdlcPath> <dummyDataJsonPath> <outputPdfPath>")
            Environment.Exit(2)
        End If

        Dim rdlcPath As String = Path.GetFullPath(args(0))
        Dim jsonPath As String = Path.GetFullPath(args(1))
        Dim outPdfPath As String = Path.GetFullPath(args(2))

        Dim jsonDoc As JsonDocument = JsonDocument.Parse(File.ReadAllText(jsonPath))
        Dim dsName As String = jsonDoc.RootElement.GetProperty("DataSetName").GetString()

        Dim dt As New DataTable(dsName)
        Dim rowObj As JsonElement = jsonDoc.RootElement.GetProperty("Row")
        Dim dr As DataRow = dt.NewRow()

        For Each prop As JsonProperty In rowObj.EnumerateObject()
            Dim valEl As JsonElement = prop.Value.GetProperty("value")
            If valEl.ValueKind = JsonValueKind.Number Then
                dt.Columns.Add(prop.Name, GetType(Decimal))
                dr(prop.Name) = valEl.GetDecimal()
            Else
                dt.Columns.Add(prop.Name, GetType(String))
                dr(prop.Name) = valEl.ToString()
            End If
        Next
        dt.Rows.Add(dr)

        Using report As New LocalReport()
            report.ReportPath = rdlcPath
            report.DataSources.Add(New ReportDataSource(dsName, dt))

            If jsonDoc.RootElement.TryGetProperty("Parameters", Nothing) Then
                Dim pList As New Collections.Generic.List(Of ReportParameter)()
                For Each p As JsonProperty In jsonDoc.RootElement.GetProperty("Parameters").EnumerateObject()
                    pList.Add(New ReportParameter(p.Name, p.Value.ToString()))
                Next
                report.SetParameters(pList)
            End If

            Dim renderedBytes As Byte() = report.Render("PDF")
            Directory.CreateDirectory(Path.GetDirectoryName(outPdfPath))
            File.WriteAllBytes(outPdfPath, renderedBytes)
        End Using

        Console.WriteLine("RENDERED_OK: " & outPdfPath)
    End Sub
End Module
