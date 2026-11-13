Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace Insurance.Proposal.Reports
    Public Class EGATESTProposalBuilder
        Public Shared ReadOnly ProductCode As String = "EGATEST"
        Public Shared ReadOnly PlanCode As String = "EGATEST-EXEC-2026"

        Public Function BuildProposalDataSet(ByVal policyHolder As String, ByVal engine As Object) As DataSet
            Dim ds As New DataSet("EGATESTDataSource")
            Dim dt As New DataTable("EGATESTProposalDataSet")
            dt.Columns.Add("PolicyHolderName", GetType(System.String))
            dt.Columns.Add("AnnualPremium", GetType(System.Decimal))
            dt.Columns.Add("SumAssured", GetType(System.Decimal))
            dt.Columns.Add("RiderStatus", GetType(System.String))

            Dim row As DataRow = dt.NewRow()
            row("PolicyHolderName") = policyHolder
            row("AnnualPremium") = ProductEngine.CalculateAnnualPremium("EGATEST", "EGATEST-EXEC-2026")
            row("SumAssured") = ProductEngine.GetBaseSumAssured("EGATEST", "EGATEST-EXEC-2026")
            row("RiderStatus") = "Included"
            dt.Rows.Add(row)

            Dim summaryEl As New EGATESTProposalElement()
            Dim benefitEl As New EGATESTBenefitElement()
            Dim coverData = summaryEl.BuildCoverageSummaryElement(row)
            Dim scheduleData = benefitEl.BuildBenefitScheduleElement(row)
            Dim disclaimerData = EGATESTProposalElement.BuildLegacyNotesElement(row)

            Dim primaryReportName As String = "EGATESTProposalLayout.rdlc"
            Dim secondaryReportName As String = benefitEl.GetReportTemplateName()

            ds.Tables.Add(dt)
            Return ds
        End Function

        Public Function ComputeIllustrationChecksum(ByVal premium As Decimal, ByVal sumAssured As Decimal) As Decimal
            If sumAssured <= 0D Then Return 0D
            Return Math.Round((premium / sumAssured) * 1000D, 4)
        End Function
    

        ''' <summary>
        ''' Isolated Sample/Reference DataTable adapter matching EGATESTProposalDataSet when ProductEngine is unavailable.
        ''' </summary>
        Public Shared Function BuildReferenceDataTable() As DataTable
            Dim dt As New DataTable("EGATESTProposalDataSet")
            dt.Columns.Add("PolicyHolderName", GetType(System.String))
            dt.Columns.Add("AnnualPremium", GetType(System.Decimal))
            dt.Columns.Add("SumAssured", GetType(System.Decimal))
            dt.Columns.Add("RiderStatus", GetType(System.String))
            dt.Columns.Add("ExecutiveRiderStatus", GetType(System.String))
            dt.Columns.Add("WaiverOfPremium", GetType(System.String))
            dt.Columns.Add("EffectiveDate", GetType(System.DateTime))
            dt.Columns.Add("ProjectedCashValue", GetType(System.Decimal))
            dt.Columns.Add("ProductCode", GetType(System.String))
            dt.Columns.Add("PlanCode", GetType(System.String))
            Dim row As DataRow = dt.NewRow()
            row("PolicyHolderName") = "Jordan Alexander Mercer" ' [REPORTGEN_MOCK mode=ReferencePdfExtract source=ProductEngine.CalculateAnnualPremium ref=Reference-System-PDFB.pdf#p1]
            row("AnnualPremium") = 4280D ' [REPORTGEN_MOCK mode=SampleData source=ProductEngine.GetAnnualPremium("EGATEST", "EGATEST-EXEC-2026") ref=Reference-System-PDFB.pdf#p1]
            row("SumAssured") = 750000D ' [REPORTGEN_MOCK mode=SampleData source=ProductEngine.GetSumAssured("EGATEST", "EGATEST-EXEC-2026") ref=Reference-System-PDFB.pdf#p1]
            row("RiderStatus") = "EGATEST-SAMPLE"
            row("ExecutiveRiderStatus") = "Included" ' [REPORTGEN_MOCK mode=SampleData source=ProductEngine.ResolveExecutiveRiderStatus("EGATEST", "EGATEST-EXEC-2026") ref=Reference-System-PDFB.pdf#p1]
            row("WaiverOfPremium") = "Waived" ' [REPORTGEN_MOCK mode=SampleData source=ProductEngine.ResolveWaiverOfPremium("EGATEST", "EGATEST-EXEC-2026") ref=Reference-System-PDFB.pdf#p1]
            row("EffectiveDate") = "2026-04-01" ' [REPORTGEN_MOCK mode=ReferencePdfExtract source=ProductEngine.ResolveEffectiveDate("EGATEST", "EGATEST-EXEC-2026") ref=Reference-System-PDFB.pdf#p1]
            row("ProjectedCashValue") = 89450D ' [REPORTGEN_MOCK mode=SampleData source=ProductEngine.ResolveProjectedCashValue("EGATEST", "EGATEST-EXEC-2026") ref=Reference-System-PDFB.pdf#p2]
            row("ProductCode") = "EGATEST"
            row("PlanCode") = "EGATEST-EXEC-2026"
            dt.Rows.Add(row)
            Return dt
        End Function
End Class
End Namespace
