Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace Insurance.Proposal.Reports
    Public Class MFABenefitElement
        Public Function GetReportTemplateName() As String
            Return "MFABenefit.rdlc"
        End Function

        Public Function BuildBenefitScheduleElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("Title") = "Benefit Schedule"
            element("ReportName") = "MFABenefit.rdlc"
            element("AnnualPremium") = row("AnnualPremium")
            element("RiderStatus") = row("RiderStatus")
            Return element
        End Function
    End Class
End Namespace
