import { Cause, Option, Runtime } from "effect";

export interface ModelFailureMetadata {
  readonly kind: string;
  readonly code?: string;
  readonly httpStatus?: number;
  readonly causeCode?: string;
  readonly providerCode?: string;
  readonly requestId?: string;
  readonly interrupted?: boolean;
}
const causeCodeOf = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null ? Reflect.get(cause, "code") : undefined;

export const modelFailureMetadata = (error: unknown): ModelFailureMetadata => {
  if (typeof error !== "object" || error === null) return { kind: "unclassified" };
  try {
    if (Runtime.isFiberFailure(error))
      return modelCauseMetadata(error[Runtime.FiberFailureCauseId]);
    const read = (key: string) => {
      const value: unknown = Reflect.get(error, key);
      return typeof value === "string" ? value : undefined;
    };
    const code = read("code");
    const providerCode = read("type");
    const requestId = read("request_id");
    const status: unknown = Reflect.get(error, "status");
    const cause: unknown = Reflect.get(error, "cause");
    const causeCode = causeCodeOf(cause);
    return {
      kind: read("name") ?? read("_tag") ?? "unclassified",
      ...(code === undefined ? {} : { code }),
      ...(typeof status === "number" ? { httpStatus: status } : {}),
      ...(typeof causeCode === "string" ? { causeCode } : {}),
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(requestId === undefined ? {} : { requestId }),
    };
    // error-reporting-allow: typed-recovery a finite metadata projection cannot trust error getters
  } catch {
    return { kind: "unclassified" };
  }
};
export const modelCauseMetadata = (cause: Cause.Cause<unknown>): ModelFailureMetadata => {
  const failure = Cause.failureOption(cause);
  const defect = Cause.dieOption(cause);
  return {
    ...(Option.isSome(failure)
      ? modelFailureMetadata(failure.value)
      : Option.isSome(defect)
        ? modelFailureMetadata(defect.value)
        : { kind: Cause.isInterrupted(cause) ? "interrupted" : "unclassified" }),
    interrupted: Cause.isInterrupted(cause),
  };
};
