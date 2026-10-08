import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import type { SkillDescriptor } from "@openai/agents/sandbox";
import { Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import parser from "../../authoring/examples/parser.js";
import { detailNavigation } from "../../authoring/examples/navigation.js";
import authEntry from "../../authoring/examples/auth-entry.js";
import bookSeat from "../../authoring/examples/caller-choice.js";
import dialogPicker from "../../authoring/examples/dialog-picker.js";
import placeOrder from "../../authoring/examples/write-session.js";
import { continueInvoices } from "../../authoring/examples/pagination.js";
import { selectInvoiceLayout } from "../../authoring/examples/variants.js";
import { inputFeedbackInstruction } from "../../src/mint/input-feedback.js";
import { loadAuthoringSkills, loadWorkspaceGuide } from "../../src/mint/skills.js";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { offlineKernel } from "../support/offline-kernel.js";
import { runKernelOperation } from "../support/kernel-run.js";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

it("loads modular skill references and keeps auth discovery outside managed login", async () => {
  expect("websiteAuth" in authEntry).toBe(false);
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const skill = (name: string) => skills.find((entry) => entry.name === name);
  expect(new Set(skills.map((entry) => entry.name)).size).toBe(skills.length);
  // Host tool descriptions, failure guidance and AGENTS.md send the agent to these skills by path.
  for (const name of ["writes"]) expect(skill(name)).toBeDefined();
  expect(skill("writes")?.references).toHaveProperty("write-session.ts");
  expect(skill("writes")?.references).toHaveProperty("write-readback.ts");
  expect(skill("core")?.references).toHaveProperty("native-page.ts");
  expect(skill("core")?.references).toHaveProperty("navigation.ts");
  expect(skill("auth")?.references).toHaveProperty("auth-entry.ts");
  expect(skill("forms")?.references).toHaveProperty("custom-selection.ts");
  expect(skill("forms")?.references).toHaveProperty("dialog-picker.ts");
  expect(skill("caller-input")?.references).toHaveProperty("caller-choice.ts");
});

it("names only skills that load and workspace sections that install", async () => {
  const skills = new Set(
    (await Effect.runPromise(loadAuthoringSkills("typescript/authoring"))).map(
      (skill) => skill.name,
    ),
  );
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  expect(guide.files.get("AGENTS.md")).toBe(guide.instructions);
  for (const text of guide.files.values()) {
    for (const [, name] of text.matchAll(/\.agents\/([a-z-]+)\/SKILL\.md/gu))
      expect(skills).toContain(name);
    for (const [path] of text.matchAll(/reference\/[a-z-]+\.md/gu))
      expect(guide.files.has(path)).toBe(true);
  }
});

const sectionMarker =
  /<!-- pomerado:section ([a-z0-9.-]+)(?: -->|:start\n[\s\S]*?\npomerado:section \1:end -->)/g;

const authoringCopy = async (edit: (path: string, text: string) => string) => {
  const root = await mkdtemp(join(tmpdir(), "pomerado-authoring-"));
  await cp("typescript/authoring", root, { recursive: true });
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const path = join(entry.parentPath, entry.name);
      await writeFile(path, edit(path, await readFile(path, "utf8")));
    }
  return root;
};

/** What a host that supplies its own text does first: every section gets the host's text. */
const composeHostText = (text: string) =>
  text.replace(sectionMarker, (_match, id: string) => `host text for ${id}`);

const contents = (skills: readonly SkillDescriptor[]) =>
  skills.map((skill) => {
    if (!(skill.content instanceof Uint8Array)) throw new Error(`${skill.name} is not bytes`);
    return new TextDecoder().decode(skill.content);
  });

it("loads standalone text by default", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  for (const text of [...contents(skills), ...guide.files.values()])
    expect(text).not.toContain("<!-- pomerado:");
});

it("reads every skill and guide file through a host's render, with its key", async () => {
  const root = await authoringCopy((_path, text) => composeHostText(text));
  const keys: string[] = [];
  // A host that composed the directory keeps its text and refuses any section it left.
  const composed = (text: string, sectionKey: string) => {
    keys.push(sectionKey);
    if (text.includes("pomerado:")) throw new Error("Uncomposed section");
    return text;
  };
  try {
    const skills = await Effect.runPromise(loadAuthoringSkills(root, composed));
    const guide = await Effect.runPromise(loadWorkspaceGuide(root, composed));
    for (const [index, skill] of skills.entries())
      expect(contents(skills)[index]).toBe(
        await readFile(join(root, skill.name, "SKILL.md"), "utf8"),
      );
    expect(guide.instructions).toBe(await readFile(join(root, "workspace/AGENTS.md"), "utf8"));
    expect(guide.instructions).toContain("host text for ");
    // Skills load concurrently, so their keys arrive in any order before the guide's.
    expect(keys.slice(0, skills.length).sort()).toEqual(skills.map((skill) => skill.name).sort());
    expect(keys.slice(skills.length)).toEqual(["agents", "guide"]);
    const refused = { _tag: "Left", left: { code: "Unavailable" } };
    expect(
      await Effect.runPromise(Effect.either(loadAuthoringSkills("typescript/authoring", composed))),
    ).toMatchObject(refused);
    expect(
      await Effect.runPromise(Effect.either(loadWorkspaceGuide("typescript/authoring", composed))),
    ).toMatchObject(refused);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * Guidance about the operation SDK, schemas, page readiness, sign-in, caller questions, forms,
 * pagination and writes is shared text, so a host that composes its own text into the named
 * sections keeps it, and the local host reads it too. One line from each shared place, with its
 * whitespace collapsed.
 */
const sharedGuidance: readonly (readonly [string, string])[] = [
  [
    "core",
    "A `secret` answer comes back as a handle such as `{{secret.s1}}`, never the value, which you never see.",
  ],
  [
    "core",
    "An operation is `defineOperation({ name, input, output }, async ({ kernel, sessionId, siteOrigin, siteDomain, input, decideDialog, ask, waitPastChallenge, verified, remainingMs, errors }) => ...)`.",
  ],
  ["core", "- Make one execute call per operation."],
  ["core", "- The code works for every value the schema accepts."],
  ["core", "Take the site origin from the context's `siteOrigin`."],
  ["core", "The tools and the files you may edit are in `AGENTS.md`."],
  ["core", "Read their bodies only when useful."],
  [
    "core",
    "Inspect login markup using reviewed read-only `explore` without private credential injection.",
  ],
  ["core", "Only the host requests website credentials, and only during `authenticate`."],
  ["auth", "Sign-in pages are often slow, and the next screen can take a while to show."],
  [
    "auth",
    "After a step whose submit the host clicked, its result names `captures/after-submit/<step>.json` (`nextScreen`)",
  ],
  [
    "caller-input",
    "Use a published input instead whenever the value is stable and the caller can supply it up front",
  ],
  ["caller-input", "One ask takes up to eight questions, with up to 50 options per choice."],
  [
    "caller-input",
    "A read build's example run, or a write build's `act` step, asks the build's owner through the same request",
  ],
  [
    "forms",
    "Derive `getByRole` names from a scoped `locator.ariaSnapshot()` or a retained ARIA snapshot.",
  ],
  ["forms", "Preserve add/replace and single/multiple intent."],
  ["forms", "- Walk every step for real, in the session, with the caller's values."],
  ["pagination", "1. Validate cursor/query/account scope before browser effects."],
  ["pagination", "Never recreate a hold, draft, upload, payment token or write as pagination."],
  ["writes", "A write build changes something real on the caller's account"],
  [
    "writes",
    "Write `src/tool.mjs`, the `playwright` version: a Kernel script running the whole flow",
  ],
  [
    "writes",
    "Call `finish_build` with entrypoint `src/tool.mjs` and the confirming step's `executionId`",
  ],
  [
    "workspace/AGENTS.md",
    "This file is the workspace `AGENTS.md`: the host loads it as your instructions on every turn",
  ],
  [
    "workspace/AGENTS.md",
    "**Load large content progressively.** Know a file's size before reading it:",
  ],
  [
    "workspace/AGENTS.md",
    "Follow these stages in order: 1. Discover the public login entry using execute purpose `explore` with `liveBrowser`.",
  ],
  [
    "workspace/AGENTS.md",
    "- When the execute receipt explicitly has `retryable:true` and `reviewDispatch:not_sent`, resubmit that same execution",
  ],
  [
    "workspace/AGENTS.md",
    "Give the evidence in `intent` and a plain one- or two-sentence `explanation` for the caller",
  ],
  ["workspace/AGENTS.md", "Do not manufacture success from model prose."],
  [
    "publication",
    "Read this before your first `finish_build`. `finish_build` asks the host to review the current source and publish it against an execution that already ran",
  ],
  ["publication", "Guardian reports what it finds in rounds, and each round costs minutes"],
  [
    "publication",
    "- Published files are all of `src/`, the named entrypoints and any `explore/`, `test/` or `scratch/` module they import",
  ],
  ["publication", "## Never put these in published files"],
  [
    "publication",
    "| `reason` | `input_feedback_unresolved` | The feedback rounds are spent | End the attempt; do not execute again |",
  ],
  [
    "publication",
    "A rejection never authorizes repeating a claimed example or a write that may have committed.",
  ],
  [
    "workspace/AGENTS.md",
    "## Publication Read .agents/publication/SKILL.md before your first `finish_build`",
  ],
  [
    "workspace/AGENTS.md",
    "Keep the build's own execution and result separate from future code publication.",
  ],
  // A write proves itself with `verified()` and no argument, whatever it read back.
  [
    "core",
    "- After a write, call `verified()` with no argument just before returning, once a call has read the result back, either the site's confirmation for this submission or the saved state. Return the confirmation number or record in the output. Without it the write stays a possible effect.",
  ],
  // A browser version reaches every page through the site, never through a URL it built.
  [
    "core",
    'For a detail read, reach the record through the site\'s own search, list or link for the schema-validated caller identifier (AGENTS.md, "Reach every page the way a person does"). Never build its page URL from the identifier, and never accept a caller URL as the target. A successful response or plausible content is insufficient',
  ],
  [
    "workspace/AGENTS.md",
    "**Reach every page the way a person does.** In the Playwright version and your browser probes, open the site's entry page and get everywhere else through the site itself: type into its search boxes and forms, pick its suggestions and options, and click its links and buttons. Never open a URL, path or query string that holds the caller's input, such as a slug made from a name, a code or date placed in a path, or a parameter the site did not send. This holds for `src/tool.mjs`, every fallback in it and your own probes. A URL the site produced in this run is fine to read, return, reload or follow, such as the results page your search landed on or a link's own `href`. So is a fixed page the site links to, opened without caller input. When a site control does not offer the caller's value, wait for it, retry it or use another of the site's own controls, and return `InvalidInput` when the site shows the value does not exist. Never fall back to a URL you wrote. This rule does not cover the HTTP version (`src/tool-http.mjs`), which may build its requests from the caller's input. Before claiming a requested search or list result",
  ],
  // A value the request gave that the site does not offer goes to the owner before the build ends.
  [
    "workspace/AGENTS.md",
    "no change within your authority gets past it, such as a requirement the site cannot meet. Before ending blocked because a value the request gave is unavailable or invalid on the site, such as a time slot the site does not offer that day, a date outside its calendar or a name it does not list, ask the owner with `request_input` to revise it or stop, as the key rules say. End blocked only when they stop or their answer cannot be met either. In maintenance, follow the intake screen instead. Give the evidence in `intent`",
  ],
  // A format read from one sample breaks on the next value, so the minter reads it off the page.
  [
    "core",
    "never just the example's value. The example's values are one case, never limits. - Never derive a format from one sample: not an input format, an element key, a selector or a label. A key the page showed for the example's value says nothing about the next value, as when a calendar keyed December 3 as `12-3-2026` where the tool expected `12-03-2026`. Read the format off the page for the value you need, such as the day cell whose visible label or accessible name is the caller's date, or a key the page itself lists, never a key rebuilt from the one you saw. - Inputs are values a caller knows",
  ],
  // Output a caller can filter and compare on is parsed into typed fields.
  [
    "publication",
    'did not return is refused (`contract_output_mismatch`). - **Typed output.** Prefer parsing what the page shows into typed fields over returning a result row, card or itinerary as one text blob or summary. Prefer giving each fact a caller would filter, sort or compare on its own field: a price as integer minor units with `currency`, times as ISO 8601 with the offset, durations in minutes, counts as integers, and codes and names as their own strings. A flight card reading "XX 234, 7:00 AM-3:31 PM, Nonstop, 5h 31m, $244" should return `{ "flight_number": "XX 234", "departure_time": "2026-11-16T07:00:00-08:00", "arrival_time": "2026-11-16T15:31:00-05:00", "stops": 0, "duration_minutes": 331, "price_minor": 24400, "currency": "USD" }` rather than `{ "summary": "XX 234 7:00 AM ..." }`. The site\'s own text may ride beside the typed fields, or stand in for one value that truly does not parse, with that field\'s description saying so. - **Inputs.**',
  ],
];

const renderedTexts = async (directory: string, render?: (text: string) => string) => {
  const skills = await Effect.runPromise(loadAuthoringSkills(directory, render));
  const guide = await Effect.runPromise(loadWorkspaceGuide(directory, render));
  const texts = new Map(skills.map((skill, index) => [skill.name, contents(skills)[index] ?? ""]));
  for (const [path, text] of guide.files) texts.set(`workspace/${path}`, text);
  return texts;
};

it("gives the local host and a composing host the same shared guidance", async () => {
  // A host that composes empty text into every section keeps only what is shared.
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    const hosts = [
      await renderedTexts("typescript/authoring"),
      await renderedTexts(root, (text) => {
        if (text.includes("pomerado:")) throw new Error("Uncomposed section");
        return text;
      }),
    ];
    for (const texts of hosts)
      expect(
        sharedGuidance.filter(
          ([name, line]) => !(texts.get(name) ?? "").replace(/\s+/g, " ").includes(line),
        ),
      ).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * A local build that still has input feedback after its rounds ends unpublished, and the local
 * host has no site metadata, login URL, HTTP version, recorded requests, session tokens or
 * private fallback, so its builder reads none of them. It saves every file under the four
 * folders when Node could load one the operation's imports do not name.
 */
it("tells the local builder what its own publication checks and how it ends", async () => {
  const texts = await renderedTexts("typescript/authoring");
  const publication = (texts.get("publication") ?? "").replace(/\s+/g, " ");
  expect(publication).toContain(
    "Never run the write again. After the last round the build ends unpublished with Guardian's findings |",
  );
  expect(publication).toContain(
    "`finish_build`'s metadata names the tool and describes it in the public definition Guardian reviews (`publication/definition.json`):",
  );
  expect(publication).toContain(
    "module they import, or every file under those four folders when Node could load a saved file those imports do not name, or the workspace has a `package.json`.",
  );
  for (const hosted of [
    "publishes privately",
    "siteName",
    "loginUrl",
    "routes.json",
    "tool-http.mjs",
    "recorded-requests",
    "session token",
    "issuing response",
    "integration",
    "confirm_action_unmatched",
    "missing_protected_result",
  ])
    expect(publication).not.toContain(hosted);
  expect(texts.get("core")?.replace(/\s+/g, " ")).toContain(
    "during the run, and publication before the first `finish_build`.",
  );
});

it("leaves no heading, list or skill header of the local host's authoring empty", async () => {
  const texts = await renderedTexts("typescript/authoring");
  const core = texts.get("core") ?? "";
  const kernelScripts = core.slice(core.indexOf("## Kernel scripts"), core.indexOf("**The input"));
  expect(kernelScripts.replace("## Kernel scripts", "").trim()).not.toBe("");
  expect(texts.get("workspace/AGENTS.md")).toContain("Follow these stages in order:\n\n1. ");
  expect(texts.get("writes")).toMatch(/^---\nname: writes\ndescription: \S/u);
});

/*
 * The local host restores the session saved right after sign-in and never signs in again by
 * itself, so a stale session shows up as a login wall that the minter's own sign-in fixes. A host
 * whose sessions behave otherwise replaces that sentence, and the text around it stays shared.
 */
it("lets a host replace the stale-session sentence", async () => {
  const sentence =
    "A signed-in build gets back the session saved right after sign-in instead, so a stale session shows up as a login wall that a new sign-in fixes. That source must perform the flow from its input, never rely on a page an exploration left open.";
  const local = (await renderedTexts("typescript/authoring")).get("core") ?? "";
  expect(local.replace(/\s+/g, " ")).toContain(sentence);
  expect(local).not.toContain("session_not_kept");
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    const composed = (await renderedTexts(root)).get("core")?.replace(/\s+/g, " ") ?? "";
    expect(composed).toContain(
      "A signed-in build gets back the session saved right after sign-in instead never rely on a page an exploration left open.",
    );
    expect(composed).not.toContain("stale session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Many sign-in forms enable their submit only once the fields hold input, and the host waits for
// it. The minter records such a submit as it observes it, disabled or not.
it("lets the minter record a sign-in submit the page has not enabled yet", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const auth = contents(skills)[skills.findIndex((skill) => skill.name === "auth")] ?? "";
  expect(auth.replace(/\s+/g, " ")).toContain(
    "Record a field only after observing its unique visible enabled match in the intended frame and form, and a submit after observing its unique visible match there, even one the page enables only once the fields hold input.",
  );
  expect(auth).not.toContain("enabled submit");
});

// A local build asks for a username, email, phone or account number as text, which the terminal
// shows, and records a verified sign-in's screens as a recipe that each run of the tool replays.
it("tells the local minter how its sign-in values are asked, what it records and what a run does with it", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const auth = (contents(skills)[skills.findIndex((skill) => skill.name === "auth")] ?? "").replace(
    /\s+/g,
    " ",
  );
  expect(auth).toContain(
    "The host obtains the needed value through the caller's input callback or the terminal, checks the original field/document/origin/focus binding and inserts privately. The terminal hides a password, code or other secret as it is typed, and shows a username, email, phone number or account number.",
  );
  expect(auth).toContain(
    "No saved credential, seed or SMS automation is used. The host records the screens of a verified sign-in, without values, and publishes them with the tool; each run of the tool replays them, asking for the login and any code or answer only when the site needs it.",
  );
  expect(auth).not.toContain("masked terminal");
  expect(auth).not.toContain("don't replay");
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  const instructions = guide.instructions.replace(/\s+/g, " ");
  expect(instructions).toContain(
    "The host collects credentials through the caller's input callback or the terminal, which hides a password, code or other secret and shows an identifier as it is typed, and inserts them through the guarded credential channel.",
  );
  expect(instructions).not.toContain("masked terminal");
  // A verified sign-in fixes its login URL, so only a new sign-in from another URL changes it.
  expect(instructions).toContain(
    "The login URL of the build's verified sign-in publishes with the tool, so it never holds a value of the account, such as its email. If `finish_build` refuses it with `login_url_contains_credential`, sign in again from a login URL without one: send each sign-in screen's `signInStep` with that `loginUrl`, then `signedIn`, and call `finish_build` again with the same `executionId`. A signed-in check alone does not change it.",
  );
});

// A write committed values the page never showed matching the input; a page's own recent-search
// save looked like an unintended write; a value the site keeps a few clicks away was called
// invalid input.
it("has the minter read back a write, accept recent-search saves and look before invalid input", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  const text = (name: string) =>
    (contents(skills)[skills.findIndex((skill) => skill.name === name)] ?? "").replace(/\s+/g, " ");
  expect(text("writes")).toContain(
    "- Before committing, read back from the page what you are about to submit and check each value against the caller's input, in the session and on every branch of the composed script. Fail before the commit if one does not match. Never read back a field filled with a secret handle.",
  );
  expect(text("core")).toContain(
    "Telemetry, analytics and bot-sensor POSTs are normal and need no change. So is an anonymous recent-search, prefill or search-state save the site fires when you submit a search.",
  );
  expect(guide.instructions.replace(/\s+/g, " ")).toContain(
    "Do not infer invalid input from a timeout, missing observation, lost authentication, or failure of our automation. Not finding a value where you first looked is not that evidence. Before you call a value unavailable, check where the site would show it for the requested scope, such as the requested date's calendar or the results for the requested search. Settled evidence for the requested option, such as the site showing it as sold out or not offered, is enough.",
  );
});

// A write that passed the page's headings to `verified` lost its receipt. With no argument there
// is nothing to get wrong, so no skill or reference teaches the argument form any more.
it("teaches every write to call verified() with no argument and declare a read-back", async () => {
  const texts = await renderedTexts("typescript/authoring");
  const examples = await readdir("typescript/authoring/examples");
  for (const name of examples)
    texts.set(name, await readFile(join("typescript/authoring/examples", name), "utf8"));
  expect(
    [...texts].filter(([, text]) => /verified\(\s*\{|confirmation: "message"/u.test(text)),
  ).toStrictEqual([]);
  expect(placeOrder.write).toEqual({ confirmation: "readback", commits: ["place-order"] });
  expect(bookSeat.write).toEqual({ confirmation: "readback", commits: ["book-seat"] });
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/*
 * Pins everything the package gives a standalone minting model: each skill's name, description,
 * text and references in catalog order, the instructions and the workspace README. Change a digest
 * only for an intended authoring change, after reading the rendered text. Each digest comes before
 * its name so a secret scanner does not read a name such as `auth` as a key for it.
 */
it("renders the pinned standalone authoring", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  expect(guide.instructions).toBe(guide.files.get("AGENTS.md"));
  expect([
    ...skills.map((skill) => [sha256(JSON.stringify(skill)), skill.name]),
    ...[...guide.files].map(([path, text]) => [sha256(text), `workspace/${path}`]),
  ]).toStrictEqual([
    ["9d25055c9445a8ba8bc250081471fed224530b0370e5d3358d254f509aad5ae7", "core"],
    ["c056088dd5ce577c203f9dbbd7b834e7095ae070a2c68e398212ef977522aac2", "auth"],
    ["bdf5324413e06a4b016719eb5b4aff0746603a121b657ff22a69515a5ba6e33d", "pagination"],
    ["b99772eda1e62e6181b6c88684ed7b101550eb335549dc28fda482116954e397", "forms"],
    ["706afe09763eab5ae5dfaf40e63ba6bdd25b9dfb16e3eda099bc3d898980311f", "writes"],
    ["604f965786a2b63e39b0fd31ca5b0b79960554b49bd0567709bb9e9c212a908b", "caller-input"],
    ["b6c17fb7b3bdabea246b4894d341d4812945d059f60cb73efec3cfe272ce0554", "publication"],
    ["dc40ff1aa51272005f11fc6c8022c0cad869038377c37cb760d263586ae19c65", "workspace/AGENTS.md"],
    ["9d04f527102b5b6de5acc9b954c57a2aead3bfff46bd20eecb70e45a10804a2c", "workspace/README.md"],
  ]);
});

/*
 * Pins the input-feedback instruction a standalone build's minter reads after a publication
 * review, for a read and a write, with one round left and with none. A standalone build has no
 * fallback, so each ends with the build ending unpublished.
 */
it("renders the pinned standalone input-feedback instructions", () => {
  expect(
    [false, true].flatMap((write) =>
      [1, 0].map((rounds) => [
        sha256(inputFeedbackInstruction(rounds, { write })),
        `${write ? "write" : "read"}, ${rounds} left`,
      ]),
    ),
  ).toStrictEqual([
    ["7d8808e98d27441c029303a499d4d30fa874b6199fec2dd65a3a90b5a26787f6", "read, 1 left"],
    ["230ad9c68c6607199a3ee2daf483a8017babb18597d22789aacb84392d1da7e8", "read, 0 left"],
    ["455b35df112a08a4e6a100a9a54ef810810580cf3d33e9dd2c5279ca299c08e6", "write, 1 left"],
    ["fb7a6750993e7c9c453ae695165f07036f95c971a475684a916fb5a6ed2fa8df", "write, 0 left"],
  ]);
});

it.each([
  ["an unterminated section", "<!-- pomerado:section core.left-open:start\nleft open\n"],
  ["a stray end marker", "pomerado:section core.stray:end -->\n"],
  ["a marker without its space", "<!--pomerado:section core.unspaced -->\n"],
  ["a section named for another file", "<!-- pomerado:section auth.elsewhere -->\n"],
  [
    "a duplicated section",
    "<!-- pomerado:section core.twice -->\n<!-- pomerado:section core.twice -->\n",
  ],
  [
    "a section inside a code fence",
    "```md\n<!-- pomerado:section core.fenced:start\nshown\npomerado:section core.fenced:end -->\n```\n",
  ],
  ["a 0.1.1 end marker", "pomerado:hosted:end -->\n"],
  ["an uppercase marker", "<!-- Pomerado:section core.upper -->\n"],
  ["an uppercase end marker", "POMERADO:SECTION core.upper:end -->\n"],
])("refuses %s", async (_case, appended) => {
  const root = await authoringCopy((path, text) =>
    path.endsWith(join("core", "SKILL.md")) ? `${text}${appended}` : text,
  );
  try {
    expect(await Effect.runPromise(Effect.either(loadAuthoringSkills(root)))).toMatchObject({
      _tag: "Left",
      left: { code: "Unavailable" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("validates dialog picker request fields before browser work", async () => {
  expect(
    await Effect.runPromise(Schema.decodeUnknown(dialogPicker.input)({ query: "item", key: "B" })),
  ).toEqual({ query: "item", key: "B" });
  for (const input of [
    { query: "", key: "B" },
    { query: "item", key: "" },
    { query: null, key: "B" },
  ])
    expect(
      await Effect.runPromise(Effect.either(Schema.decodeUnknown(dialogPicker.input)(input))),
    ).toMatchObject({ _tag: "Left" });
});

it("validates detail identifiers and rejects traversal before browser work", async () => {
  expect(
    await Effect.runPromise(
      Schema.decodeUnknown(detailNavigation.input)({ record_id: "record_42" }),
    ),
  ).toEqual({ record_id: "record_42" });
  expect(
    await Effect.runPromise(
      Effect.either(Schema.decodeUnknown(detailNavigation.input)({ record_id: "../other-record" })),
    ),
  ).toMatchObject({ _tag: "Left" });
});

it("accepts authoritative empty invoices and rejects absent/invalid bodies", async () => {
  const parse = async (body: string) => {
    const journal = await Effect.runPromise(makeEffectJournal);
    return Effect.runPromise(
      Effect.either(
        Effect.scoped(
          runKernelOperation(
            parser,
            { body },
            { kernel: offlineKernel, sessionId: "offline" },
          ).pipe(
            Effect.provideService(ExecutionContext, {
              deadline: Deadline.after(5_000),
              journal,
              events: { emit: () => Effect.void },
              capture: { start: Effect.void, finish: Effect.void },
            }),
          ),
        ),
      ),
    );
  };
  expect(await parse(JSON.stringify({ invoices: [], complete: true }))).toEqual(
    Either.right({ invoices: [], complete: true }),
  );
  for (const body of ["", "{}", '{"invoices":[],"complete":"yes"}'])
    expect(await parse(body)).toMatchObject({ _tag: "Left" });
});

it.each(["usable", "expired", "unavailable"] as const)(
  "continues the scoped read through %s state",
  async (state) => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      continueInvoices(
        "open",
        "account-a",
        { scope: "account-a", query: "open", afterId: "invoice-1" },
        {
          inspectWarmState: Effect.succeed(state),
          reconstructRead: Effect.sync(() => {
            calls.push("reconstruct");
            return "ready" as const;
          }),
          readAfter: (id) =>
            Effect.sync(() => {
              calls.push(id);
              return { ids: ["invoice-3"], coverage: "complete" as const };
            }),
        },
      ),
    );
    expect(calls).toEqual(state === "usable" ? ["invoice-1"] : ["reconstruct", "invoice-1"]);
    // Changed live data need not contain a former invoice-2 snapshot.
    expect(result.ids).toEqual(["invoice-3"]);
  },
);

it("rejects cursor scope before inspection and gives no cursor for unsupported reconstruction", async () => {
  let touched = false;
  const site = {
    inspectWarmState: Effect.sync(() => {
      touched = true;
      return "expired" as const;
    }),
    reconstructRead: Effect.succeed("unsupported" as const),
    readAfter: () => Effect.die("must not execute unsupported continuation"),
  };
  expect(
    await Effect.runPromise(
      Effect.either(
        continueInvoices(
          "open",
          "account-b",
          { scope: "account-a", query: "open", afterId: "1" },
          site,
        ),
      ),
    ),
  ).toMatchObject({ _tag: "Left" });
  expect(touched).toBe(false);
  const partial = await Effect.runPromise(
    continueInvoices(
      "open",
      "account-a",
      { scope: "account-a", query: "open", afterId: "1" },
      site,
    ),
  );
  expect(partial.coverage).toBe("partial");
  expect(partial.next).toBeUndefined();
});

it("selects old/new structural variants deterministically and rejects ambiguous/loading/unknown", () => {
  expect(selectInvoiceLayout({ tables: 1, lists: 0, loading: false })).toBe("table");
  expect(selectInvoiceLayout({ tables: 0, lists: 1, loading: false })).toBe("cards");
  for (const [observation, reason] of [
    [{ tables: 1, lists: 1, loading: false }, "ambiguous"],
    [{ tables: 1, lists: 0, loading: true }, "loading"],
    [{ tables: 0, lists: 0, loading: false }, "unsupported"],
    [{ tables: 2, lists: 0, loading: false }, "identity_mismatch"],
  ] as const)
    expect(() => selectInvoiceLayout(observation)).toThrow(reason);
});

it("reacquires a destroyed observation context without replaying the auth-entry click", async () => {
  let clicks = 0;
  let reads = 0;
  let url = "https://members.example.test/";
  const controls = [{ tag: "input", type: "text" }];
  const entry = {
    filter: () => entry,
    count: async () => 1,
    getAttribute: async () => "/member/login",
    click: async () => {
      clicks++;
      url = "https://members.example.test/member/login";
    },
  };
  const form = {
    getByLabel: () => ({ waitFor: async () => undefined }),
    locator: () => ({
      evaluateAll: async () => {
        if (++reads === 1)
          throw new Error("Execution context was destroyed, most likely because of a navigation");
        return controls;
      },
    }),
  };
  const page = {
    url: () => url,
    getByRole: (role: string) => (role === "navigation" ? { getByRole: () => entry } : form),
    waitForURL: async () => undefined,
    waitForLoadState: async () => undefined,
  };
  const journal = await Effect.runPromise(makeEffectJournal);
  const result = await Effect.runPromise(
    Effect.scoped(
      runKernelOperation(
        authEntry,
        {},
        {
          sessionId: "fixture",
          siteOrigin: "https://members.example.test",
          kernel: {
            browsers: {
              playwright: {
                execute: async (_session, body) => {
                  const pending: unknown = new Script(
                    `(async () => { ${body.code} })()`,
                  ).runInNewContext({ page, URL });
                  const result: unknown = await pending;
                  return { success: true, result, stdout: "", stderr: "" };
                },
              },
            },
          },
        },
      ).pipe(
        Effect.provideService(ExecutionContext, {
          deadline: Deadline.after(2000),
          journal,
          events: { emit: () => Effect.void },
          capture: { start: Effect.void, finish: Effect.void },
        }),
      ),
    ),
  );
  expect(result).toMatchObject({ controls, coverage: "observed_login_form" });
  expect(clicks).toBe(1);
  expect(reads).toBe(2);
});

const runPureFiles = (entrypoint: string, sources: readonly (readonly [string, string])[]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources,
          input: {},
          target: "pureFiles",
        });
      }),
    ),
  );

/*
 * Every skill reference, as the agent copies it into its workspace, and every import the workspace
 * guide or a skill shows, must load against the SDK the local executor stages beside authored
 * source. It fails when an example or the guidance names an import the executor cannot resolve.
 */
it("loads every reference and every documented import against the runtime the local executor ships", async () => {
  const authoring = "typescript/authoring";
  const skills = await Effect.runPromise(loadAuthoringSkills(authoring));
  const guide = await Effect.runPromise(loadWorkspaceGuide(authoring));
  const modules = new Map<string, string>();
  // A reference names the repository's SDK paths; the workspace README maps them to the
  // workspace's own, two levels above src/.
  for (const name of new Set(skills.flatMap((skill) => Object.keys(skill.references ?? {}))))
    modules.set(
      `src/${name.replace(/\.ts$/u, ".mjs")}`,
      stripTypeScriptTypes(await readFile(join(authoring, "examples", name), "utf8"), {
        mode: "transform",
      }).replaceAll('"../../src/', '"../../'),
    );
  const documents = [
    ...guide.files.values(),
    ...skills.map((skill) => {
      if (typeof skill.content === "string") return skill.content;
      if (skill.content instanceof Uint8Array) return new TextDecoder().decode(skill.content);
      throw new Error(`Expected rendered text for skill ${skill.name}`);
    }),
  ];
  for (const content of documents)
    for (const [index, [, block]] of [
      ...content.matchAll(/```(?:js|javascript|ts|typescript)?\n([\s\S]*?)```/gu),
    ].entries()) {
      // An import statement, over several lines when it lists its names that way.
      const imports = [...(block ?? "").matchAll(/^import\s[^;]*?["'][^"']+["'];?/gmu)].map(
        ([statement]) => statement,
      );
      if (imports.length > 0)
        modules.set(`src/documented-${modules.size}-${index}.mjs`, imports.join("\n"));
    }
  expect([...modules.keys()].filter((path) => path.includes("documented-")).length).toBeGreaterThan(
    0,
  );
  // The real local executor loads every module from one authored entrypoint, which finds the
  // SDK at whichever path this layout resolves, so only the modules under test can fail.
  const entrypoint = "src/load-every-import.mjs";
  const entry = `import { Schema } from "effect";
const sdk = await import("../../runtime/index.js").catch(() => import("../runtime/index.js"));
const paths = ${JSON.stringify([...modules.keys()].map((path) => `./${path.slice("src/".length)}`))};
export default sdk.defineOperation(
  { input: Schema.Struct({}), output: Schema.Struct({ failed: Schema.Array(Schema.String) }) },
  async () => {
    const failed = [];
    for (const path of paths) {
      try {
        await import(path);
      } catch (error) {
        failed.push(path + ": " + String(error?.message ?? error).split("\\n")[0]);
      }
    }
    return { failed };
  },
);
`;
  const result = await runPureFiles(entrypoint, [...modules, [entrypoint, entry]]);
  expect(result.output).toEqual({ failed: [] });
}, 30_000);

/*
 * Before the executor staged authored source a level below the SDK, source in src/ reached the SDK
 * and the dependency folder one level up, a nested module two levels up, and its working folder
 * held package.json. Integrations saved that way keep running, against the same modules as the
 * documented path, with relative file paths still read from the authored root.
 */
it("runs source that reaches the SDK one level up from src/, as saved integrations may", async () => {
  const result = await runPureFiles("src/tool.mjs", [
    [
      "src/tool.mjs",
      `import { Schema } from "effect";
import * as dependency from "../node_modules/effect/dist/esm/index.js";
import { readFileSync } from "node:fs";
import * as documented from "../../runtime/index.js";
import * as runtime from "../runtime/index.js";
import * as browser from "../browser/index.js";
import { nested } from "./lib/nested.mjs";
export default runtime.defineOperation(
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ same: Schema.Boolean, note: Schema.String, type: Schema.String }),
  },
  async () => ({
    same:
      documented.defineOperation === runtime.defineOperation &&
      browser.OperationFailure === runtime.OperationFailure &&
      nested === runtime.defineOperation &&
      dependency.Schema === Schema,
    note: JSON.parse(readFileSync("src/note.json", "utf8")).note,
    type: JSON.parse(readFileSync("package.json", "utf8")).type,
  }),
);`,
    ],
    ["src/lib/nested.mjs", `export { defineOperation as nested } from "../../runtime/index.js";`],
    ["src/note.json", JSON.stringify({ note: "authored root" })],
  ]);
  expect(result.output).toEqual({ same: true, note: "authored root", type: "module" });
}, 30_000);

it("refuses authored files named like a folder the host stages beside them", async () => {
  const operation = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async () => ({}));`;
  for (const name of ["runtime", "browser", "privacy", "node_modules"]) {
    const result = await runPureFiles("src/tool.mjs", [
      ["src/tool.mjs", operation],
      [name, "export {};"],
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result, name).toMatchObject({
      message: expect.stringContaining(`Reviewed source cannot replace trusted SDK: ${name}`),
    });
  }
}, 30_000);
