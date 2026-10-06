import { MintFailure } from "../mint/contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { LocalOperationFailure } from "../execution/local-operation.js";
export const error = (cause: unknown) =>
  cause instanceof Error ? cause : new Error("Pomerado operation failed", { cause });
export const mintError = (cause: unknown) =>
  cause instanceof MintFailure
    ? cause
    : new MintFailure({
        code: "Unavailable",
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "standalone",
          error: cause,
        }),
      });

/** Contract extraction reports the original schema refusal to finish_build. */
export const publicationError = (cause: unknown) => {
  if (cause instanceof LocalOperationFailure) {
    const code = [cause.code, cause.tag].find(
      (value) => value === "InvalidInput" || value === "InvalidOutput",
    );
    if (code === "InvalidInput" || code === "InvalidOutput")
      return new MintFailure({
        code: "PublicationUnavailable",
        reason: code === "InvalidInput" ? "contract_input_mismatch" : "contract_output_mismatch",
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "standalone.publish.contract",
          error: cause,
        }),
      });
  }
  return mintError(cause);
};
