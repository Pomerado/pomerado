/**
 * Features the shared prompts describe that another host supplies and the local host does not.
 * The local host renders this list twice: on top of its minter's `AGENTS.md`, as features to
 * ignore, and at the end of its Guardian's execution policy, as protections not to count on. A
 * host that supplies them all renders neither.
 *
 * Each entry is one line and names the features it covers. A change that brings a feature to the
 * local host deletes that feature's entry here, and nothing else needs to change.
 */
export interface HostedFeature {
  readonly features: readonly FeatureId[];
  readonly name: string;
}

/** A feature's ID in the design that splits hosted and local features. */
export type FeatureId = `F${number}`;

export const hostedFeatures: readonly HostedFeature[] = [
  { features: ["F14", "F22"], name: "Anti-bot, CAPTCHA, proxies and browser replacement" },
  { features: ["F16"], name: "Saved logins" },
  { features: ["F13", "F15", "F12"], name: "HTTP recording, captures, HTTP versions and savedHTTP" },
  { features: ["F21"], name: "Maintenance and repair" },
  { features: ["F17"], name: "Saved browser profiles" },
  { features: ["F1"], name: "Mid-run re-sign-in" },
  { features: ["F2"], name: "Read-back after an uncertain commit" },
  // Covers the shared text about `stateChangingRequests`: the core skill's "State-changing
  // requests" section and the write session's rule to read it on every step. It stays when
  // read-back after an uncertain commit comes to the local host.
  {
    features: ["F2"],
    name: "Per-step list of requests that could change the site (`stateChangingRequests`)",
  },
  { features: ["F3"], name: "Honest run outcomes" },
  { features: ["F4"], name: "Repeat-write protection" },
  { features: ["F5"], name: "Recorded confirm popups" },
  { features: ["F6"], name: "One-time login URL check" },
  { features: ["F7"], name: "Host incidents" },
  { features: ["F8"], name: "Sandboxed offline commands" },
  { features: ["F9"], name: "Protected answers" },
  { features: ["F10"], name: "Direct sign-in" },
  { features: ["F11"], name: "Private fallback publication" },
  { features: ["F12"], name: "savedDOM tests" },
  { features: ["F18"], name: "Execution capacity" },
  { features: ["F19"], name: "Browser retirement" },
  { features: ["F20"], name: "Write fencing" },
];

/** What the local minter reads first: the features to ignore, one per line. */
export const renderHostedFeaturesPreamble = (features: readonly HostedFeature[]) =>
  features.length === 0
    ? ""
    : [
        "These features are part of hosted Pomerado and not available open source. Please ignore these features.",
        ...features.map(({ name }) => `- ${name}`),
      ].join("\n");

/** A name as it reads mid-sentence: "Host incidents" becomes "host incidents", "savedDOM" stays. */
const midSentence = (name: string) =>
  /^[A-Z][a-z]/u.test(name) ? `${name.charAt(0).toLowerCase()}${name.slice(1)}` : name;

/** What the local Guardian reads last: the same features, as protections not to count on. */
export const renderHostedProtectionsLine = (features: readonly HostedFeature[]) =>
  features.length === 0
    ? ""
    : `These hosted protections aren't present here: ${features
        .map(({ name }) => midSentence(name))
        .join("; ")}. Don't count on them.`;

export const hostedFeaturesPreamble = renderHostedFeaturesPreamble(hostedFeatures);
export const hostedProtectionsLine = renderHostedProtectionsLine(hostedFeatures);
