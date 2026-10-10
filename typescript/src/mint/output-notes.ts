import {
  applyOutputOverrides,
  lintOutput,
  outputCheckMeaning,
  type OutputFinding,
  type OutputOverride,
  type ReviewedOutputFinding,
} from "../runtime/output-lint.js";

/**
 * The output check at publication, the same for every host: the host runs it on the read example's
 * output at `finish_build`, refuses publication while a blocking finding stands without the
 * minter's override, and gives the publication review every finding, with each override and its
 * reason, in `outputNotesPath`.
 */

/** The host's notes on the example's output, host evidence for publication review only. */
export const outputNotesPath = "publication/output-notes.json";

export interface OutputNotes {
  /** Every finding, with the minter's reason where an override names it. */
  readonly findings: readonly ReviewedOutputFinding[];
  /** Findings that still refuse publication: blocking, with no override. */
  readonly blocking: readonly OutputFinding[];
  /** Whether any finding or override exists, so the notes file is worth the reviewer's read. */
  readonly any: boolean;
  /** The notes file's text, for `outputNotesPath`. */
  readonly text: string;
}

/**
 * The example output's findings with the minter's overrides applied. `controlLabels` are the
 * accessible names of the buttons and links on the page the example ended on, when the host kept
 * them. The notes carry no sample: the reviewer reads values in the example output itself.
 */
export const outputNotes = (input: {
  readonly output: unknown;
  readonly outputSchema?: unknown;
  readonly controlLabels?: readonly string[];
  readonly overrides?: readonly OutputOverride[];
}): OutputNotes => {
  const findings = lintOutput(input.output, {
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    ...(input.controlLabels === undefined ? {} : { controlLabels: input.controlLabels }),
  });
  const applied = applyOutputOverrides(findings, input.overrides);
  return {
    findings: applied.findings,
    blocking: applied.blocking,
    any: findings.length > 0 || (input.overrides?.length ?? 0) > 0,
    text: JSON.stringify(
      {
        findings: applied.findings.map((finding) => ({
          ...finding,
          meaning: outputCheckMeaning[finding.check],
        })),
        ...(applied.unmatched.length === 0 ? {} : { unmatchedOverrides: applied.unmatched }),
      },
      null,
      2,
    ),
  };
};

/** The refusal's instruction to the minter, naming each blocking finding by path and check. */
export const outputChecksRefusal = (blocking: readonly Pick<OutputFinding, "path" | "check" | "count">[]) =>
  `Not published: the example's output holds what no page shows a person: ${blocking
    .map(
      (finding) =>
        `${finding.path} ${outputCheckMeaning[finding.check]} (${finding.check}, ${finding.count} ${finding.count === 1 ? "value" : "values"})`,
    )
    .join(
      "; ",
    )}. Fix the read in source: read rendered text with visibleText, visibleTexts or readRows instead of textContent, innerHTML or a hidden copy, then run the example again and call finish_build with that new executionId. Only when such a value is the tool's intended output, such as a tool that returns code, call finish_build again with the same executionId and outputOverrides naming each path and check with the reason; the publication reviewer reads every override.`;
