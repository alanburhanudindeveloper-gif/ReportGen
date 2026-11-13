import { StructuredLogger } from '../core/types.ts';
import { MinimalMutationPatcher } from './minimalMutationPatcher.ts';
import {
  BenchmarkAnalysis,
  MinimalMutationDiffItem,
  MinimalMutationReport,
  ProposalDefinition,
} from './types.ts';

export class ProposalVbGenerator {
  private readonly patcher: MinimalMutationPatcher;

  constructor(logger: StructuredLogger) {
    this.patcher = new MinimalMutationPatcher(logger);
  }

  public generate(
    definition: ProposalDefinition,
    benchmark: BenchmarkAnalysis
  ): {
    builderVbCode: string;
    elementVbCode: string;
    diffItems: MinimalMutationDiffItem[];
    diffReport: MinimalMutationReport;
  } {
    const out = this.patcher.patchVbArtifacts(definition, benchmark);
    return {
      builderVbCode: out.builderVbCode,
      elementVbCode: out.elementVbCode,
      diffItems: out.diffItems,
      diffReport: out.report,
    };
  }
}
