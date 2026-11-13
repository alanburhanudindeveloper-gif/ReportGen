Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace Insurance.Proposal.Reports
    Public Class MFAProposalBuilder
        Public Shared ReadOnly ProductCode As String = "MFA"
        Public Shared ReadOnly PlanCode As String = "MFA-STD"

        Public Function BuildProposalDataSet(ByVal policyHolder As String, ByVal engine As Object) As DataSet
            Dim ds As New DataSet("MFADataSource")
            Dim dt As New DataTable("MFAProposalDataSet")
            dt.Columns.Add("PolicyHolderName", GetType(System.String))
            dt.Columns.Add("AnnualPremium", GetType(System.Decimal))
            dt.Columns.Add("SumAssured", GetType(System.Decimal))
            dt.Columns.Add("RiderStatus", GetType(System.String))

            Dim row As DataRow = dt.NewRow()
            row("PolicyHolderName") = policyHolder
            row("AnnualPremium") = ProductEngine.CalculateAnnualPremium("MFA", "MFA-STD")
            row("SumAssured") = ProductEngine.GetBaseSumAssured("MFA", "MFA-STD")
            row("RiderStatus") = "Included"
            dt.Rows.Add(row)

            Dim summaryEl As New MFAProposalElement()
            Dim benefitEl As New MFABenefitElement()
            Dim coverData = summaryEl.BuildCoverageSummaryElement(row)
            Dim scheduleData = benefitEl.BuildBenefitScheduleElement(row)
            Dim disclaimerData = MFAProposalElement.BuildLegacyNotesElement(row)

            Dim primaryReportName As String = "MFAProposalLayout.rdlc"
            Dim secondaryReportName As String = benefitEl.GetReportTemplateName()

            ds.Tables.Add(dt)
            Return ds
        End Function

        Public Function ComputeIllustrationChecksum(ByVal premium As Decimal, ByVal sumAssured As Decimal) As Decimal
            If sumAssured <= 0D Then Return 0D
            Return Math.Round((premium / sumAssured) * 1000D, 4)
        End Function
    End Class
End Namespace
