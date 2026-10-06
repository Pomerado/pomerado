import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import { type ExecutionRequest, MintFailure, type MintRequest } from "./contracts.js";
import { entrypointImportClosure } from "./operation-source.js";
import type { MintProjection } from "./projection.js";
import { screenMintText } from "./workspace.js";

/**
 * The checks a host runs on one submitted step before Guardian reviews it, and the read/write
 * state they read: which input the step runs, whether a write build's session admits it, whether
 * it would blindly repeat a write, and whether a read build may run its example again or become
 * a write. Each answers from facts the host passes in.
 */

/** A host's refusal of a step, which runs nothing. */
interface Refusal {
  readonly supported: false;
  readonly reason: string;
}
const refused = (reason: string): Refusal => ({ supported: false, reason });

/** Live read tests an attempt may run on an input the agent chose. */
const maximumAgentTestInputs = 2;
const testInputNotJson = "testInput must be the tool's input as JSON text. Nothing was executed.";
const JsonText = Schema.parseJson();

/**
 * Preflight's refusal of a step's `testInput`, if any. Only a read's live test may run an input
 * the agent chose, at most two per attempt, counted from the history's `agent_chosen` marks; a
 * test Guardian denied never ran and left none.
 */
export const preflightTestInput = (
  submitted: ExecutionRequest,
  scope: {
    readonly buildEffect: MintRequest["effect"] | undefined;
    readonly executionHistory: readonly { readonly input?: "agent_chosen" }[];
  },
): Refusal | undefined => {
  if (submitted.testInput === undefined) return undefined;
  if (submitted.purpose !== "test" || submitted.target !== "liveBrowser")
    return refused(
      "testInput is only for a read's live test: purpose test, target liveBrowser. An example runs the caller's input (or exampleInput when that input is empty), and an offline test and every other purpose run the caller's input. Nothing was executed.",
    );
  if (scope.buildEffect !== "read")
    return refused(
      "A write build never runs a live test or an input you chose; its session uses the caller's values. Nothing was executed.",
    );
  if (Option.isNone(Schema.decodeUnknownOption(JsonText)(submitted.testInput)))
    return refused(testInputNotJson);
  const chosen = scope.executionHistory.filter((entry) => entry.input === "agent_chosen").length;
  return chosen >= maximumAgentTestInputs
    ? refused(
        `This attempt already ran ${maximumAgentTestInputs} live tests with an input you chose, the most it allows. Run a live test with the caller's input (omit testInput) or publish. Nothing was executed.`,
      )
    : undefined;
};

const ExampleInput = Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown }));
/**
 * The input an example runs in place of the caller's empty one: the agent's `exampleInput`, a
 * JSON object it wrote from the request and the owner's answers. Undefined when the step carries
 * none, or text that is not a JSON object, which preflight refuses.
 */
const intentDerivedInput = (submitted: ExecutionRequest) =>
  submitted.exampleInput === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(ExampleInput)(submitted.exampleInput));

/**
 * Preflight's refusal of a step's `exampleInput`, if any: the agent's reading of the request runs
 * only as a read's example where the caller gave it nothing to run.
 */
export const exampleInputRefusal = (
  submitted: ExecutionRequest,
  scope: { readonly buildEffect: MintRequest["effect"] | undefined; readonly callerInput: unknown },
): Refusal | undefined => {
  if (submitted.exampleInput === undefined) return undefined;
  const { callerInput } = scope;
  const refusal =
    submitted.purpose !== "example"
      ? "exampleInput is valid only for purpose example."
      : scope.buildEffect !== "read"
        ? "exampleInput is valid only on a read build; a write runs the caller's values in its act session."
        : typeof callerInput !== "object" ||
            callerInput === null ||
            Array.isArray(callerInput) ||
            Object.keys(callerInput).length > 0
          ? "The caller supplied input, and the example runs it as it is."
          : intentDerivedInput(submitted) === undefined
            ? "exampleInput must be JSON text of the tool's input object."
            : undefined;
  return refusal === undefined
    ? undefined
    : refused(`${refusal} Correct or remove exampleInput and execute again. Nothing was executed.`);
};

/**
 * The input a step runs, with its mark for Guardian and the history: a read's live test on an
 * input the agent chose is `agent_chosen`, a read's example on the agent's reading of an empty
 * caller input is `intent_derived`, and every other step runs the caller's input unmarked.
 * Preflight already refused a misplaced input.
 */
export const stepInput = (
  submitted: ExecutionRequest,
  callerInput: unknown,
): Effect.Effect<
  { readonly input: unknown; readonly mark?: "agent_chosen" | "intent_derived" },
  MintFailure
> => {
  if (submitted.testInput !== undefined)
    return Schema.decodeUnknown(JsonText)(submitted.testInput).pipe(
      Effect.map((input) => ({ input, mark: "agent_chosen" as const })),
      Effect.mapError(
        (error) =>
          new MintFailure({
            code: "InvalidRequest",
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "stepInput",
              error,
              context: { reason: testInputNotJson },
            }),
          }),
      ),
    );
  const derived = submitted.purpose === "example" ? intentDerivedInput(submitted) : undefined;
  return Effect.succeed(
    derived === undefined ? { input: callerInput } : { input: derived, mark: "intent_derived" },
  );
};

/** One act step of a write session, as the blind-repeat guard reads it. */
export interface WriteStep {
  readonly entrypoint: string;
  /** `writeStepDigest` of the step's source when it ran. */
  readonly sourceDigest: string;
  /** The step sent state-changing requests, or may have. */
  readonly stateChanging: boolean;
}

const sourceDigest = (files: ReadonlyMap<string, string>) =>
  createHash("sha256")
    .update(JSON.stringify([...files].sort(([left], [right]) => left.localeCompare(right))))
    .digest("hex");

/** The digest of an act step's own source: its entrypoint and the files it imports. */
export const writeStepDigest = (files: ReadonlyMap<string, string>, entrypoint: string) =>
  sourceDigest(entrypointImportClosure(files, entrypoint));

/**
 * Why an act step is refused before review as a blind repeat: it is unchanged and runs straight
 * after itself, and that run sent state-changing requests, so it could commit the write twice.
 * Once another act step has run, as a read-back does, the agent has verified and may run it again.
 */
export const replayedWriteStep = (
  submitted: ExecutionRequest,
  files: ReadonlyMap<string, string>,
  steps: readonly WriteStep[],
): string | undefined => {
  if (submitted.purpose !== "act") return undefined;
  const last = steps.at(-1);
  return last?.stateChanging === true &&
    last.entrypoint === submitted.entrypoint &&
    last.sourceDigest === writeStepDigest(files, submitted.entrypoint)
    ? "This act step is unchanged and just sent state-changing requests, so running it again blindly could commit the write twice. First run an act step that reads the page or the account and learns whether the write happened; if it did not, you may run this step again."
    : undefined;
};

/** Why a write build refuses this step now; undefined when it may run. */
export const writeSessionBoundary = (
  submitted: ExecutionRequest,
  scope: {
    readonly buildEffect: MintRequest["effect"] | undefined;
    readonly writeSessionStarted: boolean;
  },
): string | undefined => {
  if (submitted.purpose === "act")
    return scope.buildEffect === "write" && submitted.target === "liveBrowser"
      ? undefined
      : "Purpose act is a live step (target liveBrowser) of a write build's one write session. A read explores, then runs its example.";
  if (scope.buildEffect !== "write" || submitted.target !== "liveBrowser") return undefined;
  if (submitted.purpose === "example" || submitted.purpose === "test")
    return "A write build performs its action once, through purpose act steps, never as a live example or a live test. Read .agents/writes/SKILL.md; test offline with pureFiles, savedDOM or savedHTTP.";
  if (submitted.purpose === "explore" && scope.writeSessionStarted)
    return "This write build's session has started, so live exploration is over. Continue with the next act step on the page as it is, or test offline.";
  return undefined;
};

/** A read build that has not claimed its example may run its read example again. */
export const repeatableReadFor = (
  buildEffect: MintRequest["effect"] | undefined,
  exampleClaimed: boolean,
) => buildEffect === "read" && !exampleClaimed;

/**
 * The host's check of an approved write upgrade: only a repeatable read may become a write. It
 * returns the approved question, screened, which Guardian's intent then carries.
 */
export const writeUpgradeApproval = (
  projection: MintProjection,
  state: {
    readonly buildEffect: MintRequest["effect"] | undefined;
    readonly repeatableRead: boolean;
  },
  change: string,
): Effect.Effect<string, MintFailure> =>
  state.buildEffect !== "read" || !state.repeatableRead
    ? Effect.fail(
        new MintFailure({
          code: "Unavailable",
          failureDetail: failureDetail("mint_host_dependency_failed", {
            operation: "writeUpgradeApproval",
            context: { check: "not_a_repeatable_read", effect: state.buildEffect },
          }),
        }),
      )
    : screenMintText({ projection }, change);
