import { commitMarkMaxLength, commitMarkPattern } from "../runtime/operation.js";

/** Commit steps a run can prove it never reached: one or more distinct authored mark names. */
const declaresCommitMarks = (commits: readonly unknown[] | undefined) =>
  commits !== undefined &&
  commits.length > 0 &&
  new Set(commits).size === commits.length &&
  commits.every(
    (name) =>
      typeof name === "string" &&
      name.length <= commitMarkMaxLength &&
      commitMarkPattern.test(name),
  );

/**
 * Why a composed write script cannot publish against its session: it declares no confirmation,
 * names none of its commit steps (so no run of it could show it sent nothing), declares a
 * commit step the session never entered (so its marks do not follow its real commit), rejects
 * the caller's own input, declares one the named step did not record, or declares
 * `unverifiable` although a step of the session did confirm the write.
 */
export const writeContractRefusal = (
  declared:
    | {
        readonly confirmation: "message" | "readback" | "unverifiable";
        readonly commits?: readonly unknown[];
      }
    | undefined,
  inputDecodes: boolean,
  step: { readonly confirmation?: "message" | "readback" },
  session: { readonly confirmed: boolean; readonly enteredMarks: ReadonlySet<string> },
) =>
  declared === undefined
    ? ("confirmation_undeclared" as const)
    : !declaresCommitMarks(declared.commits)
      ? ("commit_marks_undeclared" as const)
      : declared.commits?.some(
            (name) => typeof name !== "string" || !session.enteredMarks.has(name),
          ) === true
        ? ("commit_marks_unentered" as const)
        : !inputDecodes
          ? ("contract_input_mismatch" as const)
          : declared.confirmation === "unverifiable"
            ? session.confirmed
              ? ("confirmation_unrecorded" as const)
              : undefined
            : step.confirmation !== declared.confirmation
              ? ("confirmation_unrecorded" as const)
              : undefined;
