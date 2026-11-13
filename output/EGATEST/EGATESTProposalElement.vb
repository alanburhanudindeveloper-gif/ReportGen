Imports System
Imports System.Data
Imports System.Collections.Generic

Namespace Insurance.Proposal.Reports
    Public Class EGATESTProposalElement
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
    

        ''' <summary>
        ''' Added section from PDF A (CHG-0002: Executive Rider Status: <ExecutiveRiderStatus>)
        ''' </summary>
        Public Shared Function BuildExecutiveRiderStatusExecElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "Executive Rider Status: <ExecutiveRiderStatus>"
            element("ProductCode") = "EGATEST"
            element("PlanCode") = "EGATEST-EXEC-2026"
            Return element
        End Function

        ''' <summary>
        ''' Added section from PDF A (CHG-0004: Benefit Component)
        ''' </summary>
        Public Shared Function BuildBenefitComponentElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "Benefit Component"
            element("ProductCode") = "EGATEST"
            element("PlanCode") = "EGATEST-EXEC-2026"
            Return element
        End Function

        ''' <summary>
        ''' Added section from PDF A (CHG-0005: Coverage Tier)
        ''' </summary>
        Public Shared Function BuildCoverageTierElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "Coverage Tier"
            element("ProductCode") = "EGATEST"
            element("PlanCode") = "EGATEST-EXEC-2026"
            Return element
        End Function

        ''' <summary>
        ''' Added section from PDF A (CHG-0006: Global Evacuation Rider)
        ''' </summary>
        Public Shared Function BuildGlobalEvacuationRiderElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "Global Evacuation Rider"
            element("ProductCode") = "EGATEST"
            element("PlanCode") = "EGATEST-EXEC-2026"
            Return element
        End Function

        ''' <summary>
        ''' Added section from PDF A (CHG-0007: <EvacRiderFee>)
        ''' </summary>
        Public Shared Function BuildEvacRiderFeeElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "<EvacRiderFee>"
            element("ProductCode") = "EGATEST"
            element("PlanCode") = "EGATEST-EXEC-2026"
            Return element
        End Function

        ''' <summary>
        ''' Added section from PDF A (CHG-0008: Executive Wellness Concierge Benefit)
        ''' </summary>
        Public Shared Function BuildExecutiveWellnessConcierElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "Executive Wellness Concierge Benefit"
            element("ProductCode") = "EGATEST"
            element("PlanCode") = "EGATEST-EXEC-2026"
            Return element
        End Function

        ''' <summary>
        ''' Added section from PDF A (CHG-0009: EGA Proposal Illustration — Confidential Template Page 1 of 2)
        ''' </summary>
        Public Shared Function BuildEGAProposalIllustrationCElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "EGA Proposal Illustration — Confidential Template Page 1 of 2"
            element("ProductCode") = "EGATEST"
            element("PlanCode") = "EGATEST-EXEC-2026"
            Return element
        End Function

        ''' <summary>
        ''' Added section from PDF A (CHG-0010: EGA Proposal Illustration — Confidential Template Page 2 of 2)
        ''' </summary>
        Public Shared Function BuildEGAProposalIllustrationCElement(ByVal row As DataRow) As Dictionary(Of String, Object)
            Dim element As New Dictionary(Of String, Object)()
            element("SectionTitle") = "EGA Proposal Illustration — Confidential Template Page 2 of 2"
            element("ProductCode") = "EGATEST"
            element("PlanCode") = "EGATEST-EXEC-2026"
            Return element
        End Function

        ' [REPORTGEN_MOCK] Status badge formatter for RiderStatus (states: Included, Not Covered)
        Public Shared Function FormatRiderStatusStatus(ByVal rawStatus As String) As String
            If String.IsNullOrWhiteSpace(rawStatus) Then
                Return "EGATEST-SAMPLE"
            End If
            Return rawStatus.Trim()
        End Function

        ' [REPORTGEN_MOCK] Status badge formatter for ExecutiveRiderStatus (states: Included, Excluded, Waived)
        Public Shared Function FormatExecutiveRiderStatusStatus(ByVal rawStatus As String) As String
            If String.IsNullOrWhiteSpace(rawStatus) Then
                Return "Included"
            End If
            Return rawStatus.Trim()
        End Function

        ' [REPORTGEN_MOCK] Status badge formatter for WaiverOfPremium (states: Waived, Included, Excluded)
        Public Shared Function FormatWaiverOfPremiumStatus(ByVal rawStatus As String) As String
            If String.IsNullOrWhiteSpace(rawStatus) Then
                Return "Waived"
            End If
            Return rawStatus.Trim()
        End Function
End Class
End Namespace
