// Failure modes covered: a version recorded in one account's sign-in shares a selector, page,
// entry URL or marker that names that account or copies a masked contact or number; a marker a
// signed-out page shows, or a URL path alone that a sign-in page has, passes; a step that signs
// out passes; an entry URL that is one authorization request, or carries credentials, passes; an
// origin outside its role, or a page, popup or recipe origin no role declares, passes; Guardian
// is asked about a version the deterministic checks refuse; an allow without the shared label,
// or a deny's reason, is lost; the review's evidence keeps the signed-out pages' documents or
// queries, or misses what changed against the previous version.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { HostReview, PendingExecution, ReviewTurn } from "../../src/guardian/review.js";
import { makeGuardian } from "../../src/guardian/review.js";
import {
  checkSignInVersion,
  reviewSignInVersion,
  signInVersionChanges,
  signInVersionDecision,
  signInVersionEvidence,
  type SignInVersion,
  type SignInVersionReviewInput,
} from "../../src/guardian/sign-in-version-review.js";

const site = "https://www.example.com";

const version: SignInVersion = {
  entryUrl: "https://www.example.com/login",
  recipe: {
    version: 1,
    steps: [
      {
        page: "https://www.example.com/login",
        fields: [{ selector: "#email", accepts: ["email"] }],
        submit: "button[type=submit]",
      },
      {
        page: "https://login.example.com/password",
        fields: [{ selector: "#password", slot: "password" }],
        submit: "#sign-in",
      },
    ],
    signedIn: { selector: "[data-testid=account-menu]", openPath: "/account" },
  },
  signInOrigins: [
    { role: "site", origin: "https://www.example.com" },
    { role: "site", origin: "https://login.example.com" },
  ],
};

const signedOut = {
  url: "https://www.example.com/login?return=%2Faccount",
  dom: '<!doctype html><html><body><form><input id="email"><button type="submit">Next</button></form></body></html>',
};

const input = (
  change: (base: SignInVersion) => SignInVersion = (base) => base,
  extra: Partial<SignInVersionReviewInput> = {},
): SignInVersionReviewInput => ({
  siteOrigin: site,
  version: change(version),
  signedOutSnapshots: [signedOut],
  ...extra,
});

/** The version with one step's parts replaced. */
const withStep = (
  index: number,
  parts: Partial<SignInVersion["recipe"]["steps"][number]>,
): ((base: SignInVersion) => SignInVersion) => (base) => ({
  ...base,
  recipe: {
    ...base.recipe,
    steps: base.recipe.steps.map((step, at) => (at === index ? { ...step, ...parts } : step)),
  } as SignInVersion["recipe"],
});

const withMarker =
  (signedIn: SignInVersion["recipe"]["signedIn"]) =>
  (base: SignInVersion): SignInVersion => ({ ...base, recipe: { ...base.recipe, signedIn } });

const pending: PendingExecution = {
  invocationId: "version_job",
  attemptId: "version_attempt",
  entrypoint: "operation/operation.mjs",
  screenedIntent: "Review a sign-in version",
  screenedInput: "{}",
  screenedObservations: "Synthetic fixture",
  accountScope: "account_version",
  allowedOrigins: [site],
  allowedEffects: ["read"],
};

const scriptedGuardian = (decision: Record<string, unknown>) => {
  const turns: ReviewTurn[] = [];
  const guardian = makeGuardian({
    run: (turn) => {
      turns.push(turn);
      return Effect.succeed(decision);
    },
  });
  return { guardian, turns };
};

describe("reviewSignInVersion", () => {
  it("asks Guardian once, privately, with what changed and no signed-out document", async () => {
    const previous = withStep(1, { submit: "#continue" })(version);
    const { guardian, turns } = scriptedGuardian({
      outcome: "allow",
      label: "shared",
      rationale: "Every part serves any account of the site.",
    });

    const verdict = await Effect.runPromise(
      reviewSignInVersion(guardian, pending, input(undefined, { previous })),
    );

    expect(verdict).toMatchObject({ outcome: "allow" });
    expect(turns).toHaveLength(1);
    const request = turns[0]?.pending.hostReview as HostReview;
    expect(request).toMatchObject({
      kind: "sign_in_version",
      outcomes: ["allow", "deny"],
      private: true,
    });
    expect(request.evidence).toEqual({
      siteOrigin: site,
      version,
      trailingFieldlessSteps: [],
      signedOutPages: ["https://www.example.com/login"],
      signedOutMarker: "absent",
      changes: [{ part: "recipe.steps[1].submit", before: "#continue", after: "#sign-in" }],
    });
  });

  it("refuses a version the checks refuse without asking Guardian", async () => {
    const { guardian, turns } = scriptedGuardian({
      outcome: "allow",
      label: "shared",
      rationale: "Unused.",
    });

    const verdict = await Effect.runPromise(
      reviewSignInVersion(
        guardian,
        pending,
        input(withStep(1, { submit: "text=Continue as Jane" }), { identities: ["Jane"] }),
      ),
    );

    expect(verdict).toEqual({
      outcome: "refused",
      findings: [{ rule: "selector_names_contact", part: "recipe.steps[1].submit" }],
    });
    expect(turns).toHaveLength(0);
  });

  it("returns Guardian's denial with its reason and rationale", async () => {
    const { guardian } = scriptedGuardian({
      outcome: "deny",
      label: "choice_step",
      rationale: "The last step picks one member's records.",
    });
    const choice = (base: SignInVersion): SignInVersion => ({
      ...base,
      recipe: {
        ...base.recipe,
        steps: [...base.recipe.steps, { page: "https://www.example.com/select", fields: [], submit: "text=Primary member" }],
      },
    });

    const verdict = await Effect.runPromise(reviewSignInVersion(guardian, pending, input(choice)));

    expect(verdict).toMatchObject({
      outcome: "deny",
      label: "choice_step",
      rationale: "The last step picks one member's records.",
    });
    expect(signInVersionEvidence(input(choice)).trailingFieldlessSteps).toEqual([2]);
  });
});

describe("checkSignInVersion", () => {
  it("passes a version every account can replay", () => {
    expect(checkSignInVersion(input())).toEqual([]);
  });

  it.each([
    [
      "a method selector copying a masked phone number",
      withStep(1, {
        methods: [
          { method: "sms", selector: "text=Text ***-***-1234" },
          { method: "email", selector: "text=Email me a code" },
        ],
      }),
      [{ rule: "selector_names_contact", part: "recipe.steps[1].methods[0].selector" }],
    ],
    [
      "a field selector holding a long number",
      withStep(0, { fields: [{ selector: "input[name=member-84731922]", accepts: ["email"] }] }),
      [{ rule: "selector_names_contact", part: "recipe.steps[0].fields[0].selector" }],
    ],
    [
      "a rejection marker copying a masked address",
      withStep(0, { rejectedMarkers: [{ slot: "email", selector: "text=j•••@example.com not found" }] }),
      [{ rule: "selector_names_contact", part: "recipe.steps[0].rejectedMarkers[0].selector" }],
    ],
    [
      "a page path holding an account number",
      withStep(1, { page: "https://login.example.com/members/84731922/password" }),
      [{ rule: "page_names_contact", part: "recipe.steps[1].page" }],
    ],
    [
      "a marker holding a masked account",
      withMarker({ selector: "text=Checking ••1234" }),
      [{ rule: "indicator_holds_identity", part: "recipe.signedIn.selector" }],
    ],
  ] as const)("refuses %s", (_name, change, findings) => {
    expect(checkSignInVersion(input(change))).toEqual(findings);
  });

  it("refuses every part naming the recording account's identity, plain or percent-encoded", () => {
    const named = (base: SignInVersion): SignInVersion => ({
      ...withStep(0, { page: "https://www.example.com/login/jane%40example.com" })(base),
      entryUrl: "https://www.example.com/login?hint=jane%40example.com",
    });
    expect(
      checkSignInVersion(
        input(
          (base) => withMarker({ selector: "text=Jane Doe", openPath: "/account" })(named(base)),
          { identities: ["jane@example.com", "Jane Doe", "JD"] },
        ),
      ),
    ).toEqual([
      { rule: "page_names_contact", part: "entryUrl" },
      { rule: "page_names_contact", part: "recipe.steps[0].page" },
      { rule: "indicator_holds_identity", part: "recipe.signedIn.selector" },
    ]);
  });

  it("checks the masked pattern past the origin only, so a port is not a number", () => {
    const ported: SignInVersion = {
      ...version,
      entryUrl: "https://www.example.com:8443/login",
      recipe: {
        ...version.recipe,
        steps: [{ ...version.recipe.steps[0]!, page: "https://www.example.com:8443/login" }],
      },
      signInOrigins: [{ role: "site", origin: "https://www.example.com:8443" }],
    };
    expect(checkSignInVersion(input(() => ported))).toEqual([]);
  });

  it.each([
    [
      "a marker a signed-out page shows",
      withMarker({ selector: "#email" }),
      [{ rule: "marker_matches_signed_out_page", part: "recipe.signedIn" }],
    ],
    [
      "a URL path marker on the sign-in page",
      withMarker({ urlPath: "/login" }),
      [
        { rule: "marker_is_login_path", part: "recipe.signedIn.urlPath" },
        { rule: "marker_matches_signed_out_page", part: "recipe.signedIn" },
      ],
    ],
    [
      "a URL path marker on a later sign-in screen",
      withMarker({ urlPath: "/password" }),
      [{ rule: "marker_is_login_path", part: "recipe.signedIn.urlPath" }],
    ],
    [
      "an empty marker",
      withMarker({ openPath: "/account" }),
      [{ rule: "marker_missing", part: "recipe.signedIn" }],
    ],
  ] as const)("refuses %s", (_name, change, findings) => {
    expect(checkSignInVersion(input(change))).toEqual(findings);
  });

  it.each([
    ["a submit that signs out", withStep(1, { submit: "#signOutButton" }), "recipe.steps[1].submit"],
    ["a submit that logs off", withStep(1, { submit: "text=Log off" }), "recipe.steps[1].submit"],
    [
      "a method that signs out",
      withStep(1, { methods: [{ method: "sms", selector: "a.sign-out" }] }),
      "recipe.steps[1].methods[0].selector",
    ],
    ["a logout page", withStep(1, { page: "https://login.example.com/logout" }), "recipe.steps[1].page"],
  ] as const)("refuses %s", (_name, change, part) => {
    expect(checkSignInVersion(input(change))).toEqual([{ rule: "sign_out", part }]);
  });

  it("keeps a sign-out marker and a word that only contains log", () => {
    expect(
      checkSignInVersion(
        input((base) =>
          withMarker({ selector: "button:has-text('Sign out')" })(
            withStep(0, { submit: ".catalog-offers button" })(base),
          ),
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "an authorization request",
      "https://login.example.com/oauth2/authorize?client_id=web&state=Zm9vYmFyMTIzNDU2Nzg5MA",
      [{ rule: "one_time_url", part: "entryUrl" }],
    ],
    [
      "credentials",
      "https://user:secret@www.example.com/login",
      [{ rule: "url_credentials", part: "entryUrl" }],
    ],
    [
      "an undeclared origin",
      "https://www.example.org/login",
      [{ rule: "origin_undeclared", part: "entryUrl" }],
    ],
  ] as const)("refuses an entry URL with %s", (_name, entryUrl, findings) => {
    expect(checkSignInVersion(input((base) => ({ ...base, entryUrl })))).toEqual(findings);
  });

  it.each([
    [
      "a site origin on another site",
      { role: "site", origin: "https://www.example.org" },
    ],
    ["a site origin that is not exact", { role: "site", origin: "https://www.example.com/login" }],
    ["a fixed origin on the site itself", { role: "fixed", origin: "https://id.example.com" }],
    ["a workspace on another domain", { role: "workspace", parent: "example.org" }],
  ] as const)("refuses %s", (_name, origin) => {
    expect(
      checkSignInVersion(
        input((base) => ({ ...base, signInOrigins: [...base.signInOrigins, origin] })),
      ),
    ).toEqual([{ rule: "origin_role", part: "signInOrigins[2]" }]);
  });

  it("accepts an approved provider and a workspace step, and refuses them undeclared", () => {
    const provider: SignInVersion = {
      ...version,
      recipe: {
        version: 4,
        workspace: { parent: "example.com" },
        signInOrigins: ["https://id.provider.example"],
        steps: [
          version.recipe.steps[0]!,
          {
            page: "https://id.provider.example/sign-in",
            fields: [{ selector: "#password", slot: "password" }],
            submit: "#next",
          },
          { origin: "workspace", page: "/verify", fields: [{ selector: "#code", slot: "code" }] },
        ],
        signedIn: version.recipe.signedIn,
      },
      signInOrigins: [
        { role: "site", origin: "https://www.example.com" },
        { role: "fixed", origin: "https://id.provider.example" },
        { role: "workspace", parent: "example.com" },
      ],
    };
    expect(checkSignInVersion(input(() => provider))).toEqual([]);
    expect(
      checkSignInVersion(
        input(() => ({ ...provider, signInOrigins: [{ role: "site", origin: site }] })),
      ),
    ).toEqual([
      { rule: "origin_undeclared", part: "recipe.workspace" },
      { rule: "origin_undeclared", part: "recipe.signInOrigins[0]" },
      { rule: "origin_undeclared", part: "recipe.steps[1].page" },
      { rule: "origin_undeclared", part: "recipe.steps[2].page" },
    ]);
  });

  it("refuses a popup on an undeclared origin", () => {
    const popup: SignInVersion = {
      ...version,
      recipe: {
        version: 2,
        steps: [
          {
            ...version.recipe.steps[0]!,
            popup: { opener: "primary", origin: "https://accounts.provider.example" },
          },
        ],
        signedIn: version.recipe.signedIn,
      },
    };
    expect(checkSignInVersion(input(() => popup))).toEqual([
      { rule: "origin_undeclared", part: "recipe.steps[0].popup.origin" },
    ]);
  });
});

describe("signInVersionDecision", () => {
  const rationale = "Synthetic rationale.";
  it.each([
    [{ outcome: "allow", label: "shared" }, { outcome: "allow" }],
    // An allow that names a problem, or no label, shares nothing.
    [{ outcome: "allow", label: "marker" }, { outcome: "deny", label: "marker" }],
    [{ outcome: "allow" }, { outcome: "deny" }],
    [{ outcome: "deny", label: "account_specific" }, { outcome: "deny", label: "account_specific" }],
    [{ outcome: "deny", label: "shared" }, { outcome: "deny" }],
  ] as const)("acts on %o as %o", (decision, expected) => {
    expect(signInVersionDecision({ rationale, ...decision })).toEqual(expected);
  });
});

describe("signInVersionChanges", () => {
  it("names each added, removed and changed part", () => {
    const after: SignInVersion = {
      ...version,
      recipe: {
        ...version.recipe,
        steps: [
          version.recipe.steps[0]!,
          { ...version.recipe.steps[1]!, submit: "#continue" },
          { page: "https://login.example.com/trust", fields: [], submit: "text=Not now" },
        ],
        signedIn: { selector: "[data-testid=account-menu]" },
      },
    };
    expect(signInVersionChanges(version, after)).toEqual([
      { part: "recipe.steps[1].submit", before: "#sign-in", after: "#continue" },
      {
        part: "recipe.steps[2]",
        after: { page: "https://login.example.com/trust", fields: [], submit: "text=Not now" },
      },
      { part: "recipe.signedIn.openPath", before: "/account" },
    ]);
    expect(signInVersionChanges(version, version)).toEqual([]);
  });
});
