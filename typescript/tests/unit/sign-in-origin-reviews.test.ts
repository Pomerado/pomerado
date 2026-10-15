import { expect, it } from "vitest";
import { workspaceOriginDecision } from "../../src/guardian/sign-in-origin-reviews.js";

const rationale = "The site's own sign-in sent this account there.";

it.each([
  [{ outcome: "allow", label: "workspace" }, "workspace"],
  [{ outcome: "allow", label: "shared_host" }, "shared_host"],
  // An allow that does not say which kind of host it is trusts nothing.
  [{ outcome: "allow" }, "deny"],
  [{ outcome: "allow", label: "something_else" }, "deny"],
  [{ outcome: "deny" }, "deny"],
  [{ outcome: "deny", label: "workspace" }, "deny"],
  [{ outcome: "deny", label: "unrecognized" }, "deny"],
  [{ outcome: "allow", label: "unrecognized" }, "deny"],
] as const)("a workspace_origin decision %o is %s", (decision, expected) => {
  expect(workspaceOriginDecision({ rationale, ...decision })).toBe(expected);
});
