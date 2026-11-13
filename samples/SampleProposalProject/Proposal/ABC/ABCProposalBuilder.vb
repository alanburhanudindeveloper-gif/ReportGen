Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace Insurance.Proposal.Reports
    Public Class ABCProposalBuilder
        Public Shared ReadOnly ProductCode As String = "ABC"
        Public Shared ReadOnly PlanCode As String = "ABC-BASIC"

        Public Function BuildProposalDataSet() As DataSet
            Dim ds As New DataSet("ABCDataSource")
            Dim dt As New DataTable("ABCProposalDataSet")
            dt.Columns.Add("MemberName", GetType(System.String))
            dt.Columns.Add("MonthlyFee", GetType(System.Decimal))
            Dim row As DataRow = dt.NewRow()
            row("MemberName") = "Sample"
            row("MonthlyFee") = 95D
            dt.Rows.Add(row)
            Dim el = ABCProposalElement.BuildBasicCardElement(row)
            ds.Tables.Add(dt)
            Return ds
        End Function
    End Class
End Namespace
