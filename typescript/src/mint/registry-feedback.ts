import type { RegistryIssue } from "../registry/issues.js";

/**
 * What the minter is told when the registry refuses a reviewed publication.
 * A check the minter's own metadata or source decides is fixable, and it may publish again with
 * no cap, as may a publication whose tool another publisher advanced meanwhile; a check on
 * host-built fields is not.
 */
const feedback: Readonly<
  Record<RegistryIssue, { readonly fixable: boolean; readonly instruction: string }>
> = {
  definition_invalid: {
    fixable: true,
    instruction:
      "The registry could not accept the tool's public definition: its name, description or input or output schema is not a valid published definition. Check the metadata you passed to finish_build and the schemas the source declares, correct them, and call finish_build again with the same executionId.",
  },
  variants_invalid: {
    fixable: true,
    instruction:
      "The registry refused the declared supported variants: each variant id must be unique and each needs its own passing test. Correct supportedVariants in the metadata, or drop the variant, and call finish_build again with the same executionId.",
  },
  write_confirmation_on_read: {
    fixable: true,
    instruction:
      "The source declares a write confirmation, but this build is a read. Remove the write declaration from defineOperation and call finish_build again with the same executionId.",
  },
  variant_removed: {
    fixable: true,
    instruction:
      "The published tool already supports variants this publication leaves out, and a publication never drops an enabled variant. Keep every variant the published tool supports, with its test, and call finish_build again with the same executionId.",
  },
  variant_contract_changed: {
    fixable: true,
    instruction:
      "The published tool supports variants, and this publication changes its input or output schema, target, effect or sign-in, which a variant tool cannot change. Keep the published contract, or publish without variants, and call finish_build again with the same executionId.",
  },
  site_origin_invalid: {
    fixable: false,
    instruction: "The registry refused the site origin the host recorded for this build.",
  },
  destination_evidence_invalid: {
    fixable: false,
    instruction: "The registry refused the route evidence the host recorded for this build.",
  },
  login_url_without_signed_in_browser: {
    fixable: false,
    instruction:
      "The registry refused the login URL the host recorded, because this build is not a signed-in browser tool.",
  },
  login_url_unusable: {
    fixable: true,
    instruction:
      "The login URL cannot start a sign-in. Sign in again with authenticate and a web loginUrl, then call finish_build again with the same executionId.",
  },
  target_mismatch: {
    fixable: false,
    instruction:
      "The registry refused the host-recorded target, effect or implementation settings of this build.",
  },
  catalog_generation_invalid: {
    fixable: false,
    instruction: "The registry refused the host's catalog reference for this site.",
  },
  attempt_stopped: {
    fixable: false,
    instruction: "This attempt stopped or lost its lease before the publication could commit.",
  },
  catalog_moved: {
    fixable: false,
    instruction: "The site's catalog changed while this publication was being committed.",
  },
  generation_moved: {
    fixable: true,
    instruction:
      "The published tool changed while this build ran: another publication advanced it, and the host did not commit this build over it. If this build should still replace that version, call finish_build again with the same executionId; the host reads the current version and reviews the publication afresh. Otherwise end the build.",
  },
  revision_exists: {
    fixable: false,
    instruction: "The registry already holds a different revision under this build's revision id.",
  },
};

/**
 * A refusal with no named check is treated as one the minter cannot fix. `problem` is the
 * registry's finite reason for an unusable login URL, which the minter sees with the fix.
 */
export const registryRefusal = (issue: RegistryIssue | undefined, problem?: string) =>
  issue === undefined
    ? {
        fixable: false,
        instruction: "The registry refused this publication without naming the check.",
      }
    : issue === "login_url_unusable" && problem !== undefined
      ? {
          fixable: true,
          instruction: `The login URL cannot start a sign-in (${problem}). Sign in again with authenticate and a web loginUrl, then call finish_build again with the same executionId.`,
        }
      : feedback[issue];
