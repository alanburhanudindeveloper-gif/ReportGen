Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace Insurance.Proposal.Reports
    Public Class MFAProposalElement
        Public Shared Function BuildCoverageSummaryElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("Title") = "Coverage Summary"
            element("PolicyHolderName") = row("PolicyHolderName")
            element("SumAssured") = row("SumAssured")
            Return element
        End Function

        Public Shared Function BuildBenefitScheduleElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("Title") = "Benefit Schedule"
            element("AnnualPremium") = row("AnnualPremium")
            element("RiderStatus") = row("RiderStatus")
            Return element
        End Function

        Public Shared Function BuildLegacyNotesElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("Title") = "Legacy Terms"
            element("Notes") = "Standard MFA terms apply."
            Return element
        End Function
    End Class
End Namespace
