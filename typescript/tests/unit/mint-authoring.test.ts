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
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
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
  // The testing skill is shared text; its capture reference is another host's.
  expect(skills.map((entry) => entry.name)).toStrictEqual([
    "core",
    "search",
    "auth",
    "testing",
    "pagination",
    "forms",
    "writes",
    "cart",
    "caller-input",
    "publication",
  ]);
  expect(skill("testing")?.references).toStrictEqual({});
});

/*
 * The shared text names a few skills and reference sections only another host installs, for
 * features the local minter's preamble tells it to ignore: browser recovery, offline commands,
 * captures and maintenance. Every other name loads or installs locally.
 */
const hostedOnlyGuides = new Set([
  ".agents/browser-recovery/SKILL.md",
  "reference/offline-commands.md",
  "reference/captures.md",
  "reference/maintenance.md",
]);

it("names only skills that load and workspace sections that install, or hosted-only ones", async () => {
  const skills = new Set(
    (await Effect.runPromise(loadAuthoringSkills("typescript/authoring"))).map(
      (skill) => skill.name,
    ),
  );
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  expect(guide.files.get("AGENTS.md")).toBe(guide.instructions);
  const hostedNamed = new Set<string>();
  for (const text of guide.files.values()) {
    for (const [path, name = ""] of text.matchAll(/\.agents\/([a-z-]+)\/SKILL\.md/gu))
      if (hostedOnlyGuides.has(path)) hostedNamed.add(path);
      else expect(skills).toContain(name);
    for (const [path] of text.matchAll(/reference\/[a-z-]+\.md/gu))
      if (hostedOnlyGuides.has(path)) hostedNamed.add(path);
      else expect(guide.files.has(path)).toBe(true);
  }
  // A hosted-only name that loads locally, or that no shared text names, is a stale entry.
  expect([...hostedNamed].sort()).toStrictEqual([...hostedOnlyGuides].sort());
  for (const path of hostedOnlyGuides) {
    expect(guide.files.has(path)).toBe(false);
    expect(skills.has(/^\.agents\/([a-z-]+)\//u.exec(path)?.[1] ?? "")).toBe(false);
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
    "**Reach every page the way a person does.** In the Playwright version and your browser probes, open the site's entry page and get everywhere else through the site itself: type into its search boxes and forms, pick its suggestions and options, and click its links and buttons. Never open a URL, path or query string that holds the caller's input, such as a slug made from a name, a code or date placed in a path, or a parameter the site did not send. This holds for `src/tool.mjs`, every fallback in it and your own probes. A URL the site produced in this run is fine to read, return, reload or follow, such as the results page your search landed on or a link's own `href`. So is a fixed page the site links to, opened by its exact `href` without caller input. Never trim, rebuild or guess a link: a link with its query removed is a URL you wrote. When a site control does not offer the caller's value, wait for it, retry it or use another of the site's own controls, and return `InvalidInput` when the site shows the value does not exist. Never fall back to a URL you wrote. This rule does not cover the HTTP version (`src/tool-http.mjs`), which may build its requests from the caller's input. **Read back every input before returning.**",
  ],
  // A value the request gave that the site does not offer goes to the owner before the build ends.
  [
    "workspace/AGENTS.md",
    "no change within your authority gets past it, such as a requirement the site cannot meet. Before ending blocked because a value the request gave is unavailable or invalid on the site, such as a time slot the site does not offer that day, a date outside its calendar or a name it does not list, ask the owner with `request_input` to revise it or stop, as the key rules say. End blocked only when they stop or their answer cannot be met either. In maintenance, follow the intake screen instead. Give the evidence in `intent`",
  ],
  // An option the code reads no results for yet throws rather than returning another option's
  // results, and a format read from one sample breaks on the next value, so the minter reads it
  // off the page.
  [
    "core",
    "never just the example's value. The example's values are one case, never limits. - If the schema lists an option your code doesn't read results for yet, prefer throwing a plain error for that option over returning results for another one. A repair adds it when a caller needs it. - Never derive a format from one sample: not an input format, an element key, a selector, a URL path or a label. A key the page showed for the example's value says nothing about the next value, as when a calendar keyed December 3 as `12-3-2026` where the tool expected `12-03-2026`. Read the format off the page for the value you need, such as the day cell whose visible label or accessible name is the caller's date, or a key the page itself lists, never a key rebuilt from the one you saw. - Inputs are values a caller knows",
  ],
  // The minter reads typed output, kept rows and required facts before it writes the schema and
  // the parser, so a fact the code could not read fails the output check.
  [
    "core",
    "**Output fields.** Decide from the request and the pages which values the request needs: each value it names, the record's identifier as the site shows it, and the context those values depend on as the page shows it, such as dates, a party size or a location. Make each required and non-null, typed so a value the code could not read fails the output check (`Schema.NonEmptyString` for text, `Schema.Int` for a count), never an optional, nullable or plain `Schema.Number` field. Make a field optional or nullable only when the page can lack it and the result still serves the request, and say in its description when it is null. A run whose output fails its schema goes to repair. - Prefer parsing what the page shows into typed fields over returning a result row, card or itinerary as one text blob or summary, and keep every result row the page shows. - Read every output from the page or response on every run, so every returned field has observable support: never a literal, a default you invented, or a constant `null`, `[]`, `false`, `0` or fixed label where the page can show the value. - Return `null` only when this record's page lacks the value, and an empty list only when the page shows none; never throw for either. When the code cannot read a value the request needs, throw `OperationFailure` naming it; never return a placeholder, a label or another record's value in its place. - One field per fact, as the page states it, and variants as the dimensions and values the page lists. - Prefer numbers for amounts and counts, ISO 8601 for dates and times and minutes for durations; type a date-only value as the runtime's `CalendarDate` (forms skill). A value that does not parse cleanly may be the site's own text.",
  ],
  // Output a caller can filter and compare on is parsed into typed fields.
  [
    "publication",
    'did not return is refused (`contract_output_mismatch`). Values the request needs are required and non-null, and no output is a constant where the page shows a value (core skill, output fields). - **Typed output.** Prefer parsing what the page shows into typed fields over returning a result row, card or itinerary as one text blob or summary. Give each fact a caller would filter, sort or compare its own field (core skill, output fields). A flight card reading "XX 234, 7:00 AM-3:31 PM, Nonstop, 5h 31m" should return `{ "flight_number": "XX 234", "departure_time": "2026-11-16T07:00:00-08:00", "arrival_time": "2026-11-16T15:31:00-05:00", "stops": 0, "duration_minutes": 331 }` rather than `{ "summary": "XX 234 7:00 AM ..." }`. The site\'s own text may ride beside the typed fields, or stand in for one value that truly does not parse, with that field\'s description saying so. - **Inputs.**',
  ],
];

/*
 * Text both hosts now read word for word, from places that were host sections before: one line
 * from each, with its whitespace collapsed.
 */
const formerSections: readonly (readonly [string, string])[] = [
  ["core", "Unclear means possible. `websiteEffect: may_have_dispatched` makes that execution's effect possible"],
  ["auth", "The `loginUrl` you pass on `authenticate` is published with the tool, and every run opens it to sign in."],
  ["auth", "A run can begin partway through that flow because its bound profile or remembered device omitted an earlier stage."],
  ["caller-input", "1. Declare every question the run may ask in the contract, `defineOperation({ name, input, output, questions }, ...)`, by id, with its `type` and a short `prompt`."],
  ["forms", "Filling in or advancing a form that saves data on the site (an application, a profile, a contracting or checkout form) is a write, even when nothing is submitted yet"],
  ["pagination", "A mint question keeps the live browser for up to 10 minutes; that is not cursor expiry."],
  ["writes", "- The first `act` step claims the build's write."],
  ["publication", "- **Login URL.** A signed-in tool publishes the `loginUrl` you signed in from, and every run opens it."],
  ["workspace/AGENTS.md", "Choose meaningful tests; there is no mandatory test count or promotion matrix."],
  ["workspace/AGENTS.md", "- `src/`: your operation. It exists from the start and is empty until you write to it"],
  ["testing", "Choose cases that catch actual risk: applied filters, account scope, IDs, units"],
  ["testing", "A read may run up to two live tests per attempt with an input you choose instead of the caller's"],
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
        [...sharedGuidance, ...formerSections].filter(
          ([name, line]) => !(texts.get(name) ?? "").replace(/\s+/g, " ").includes(line),
        ),
      ).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * Text only the local host reads stays in host sections a composing host replaces: the core
 * skill's closing summary of local execution and completion follows the shared paragraph on host
 * incidents, and a host that composes empty text there keeps that paragraph only.
 */
it("keeps the local execution and completion summary in a host section", async () => {
  const summary =
    "## Standalone execution and completion Use the ordinary `defineOperation` API and existing Kernel-shaped browser calls above.";
  const lines = [
    summary,
    "It offers no browser replacement or captured replay facility. An invalidated native executor ends this attempt; never use a new browser to repeat an uncertain effect.",
    "Correct a refused binding by reading the current screen. A rejected credential needs caller correction; do not resubmit it.",
  ];
  const shared = "so never repeat it without the read-back above.";
  const local = ((await renderedTexts("typescript/authoring")).get("core") ?? "").replace(/\s+/g, " ");
  expect(lines.filter((line) => !local.includes(line))).toStrictEqual([]);
  expect(local.indexOf(shared)).toBeGreaterThan(0);
  expect(local.indexOf(summary)).toBeGreaterThan(local.indexOf(shared));
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    const composed = ((await renderedTexts(root)).get("core") ?? "").replace(/\s+/g, " ");
    expect(composed).toContain(shared);
    expect(composed).not.toContain("Standalone execution and completion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The shared tool list describes another host's command sandbox; the local host's own section
// says which description holds here.
it("tells the local minter its own exec_command rule replaces the shared one", async () => {
  const guide = (await renderedTexts("typescript/authoring")).get("workspace/AGENTS.md") ?? "";
  const text = guide.replace(/\s+/g, " ");
  const shared = "`exec_command` is offline only";
  const leadIn =
    "## Standalone workspace and tools On this host, the tool rules below replace the tool list above where they differ.";
  const local = "`exec_command` runs a local process over caller-owned files";
  expect(text.indexOf(shared)).toBeGreaterThan(0);
  expect(text.indexOf(leadIn)).toBeGreaterThan(text.indexOf(shared));
  expect(text.indexOf(local)).toBeGreaterThan(text.indexOf(leadIn));
});

it("lists every installed skill in the local workspace README", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const readme = (await renderedTexts("typescript/authoring")).get("workspace/README.md") ?? "";
  const list = /Read the installed ([^.]+) skills as relevant\./u.exec(readme.replace(/\s+/g, " "));
  const named = new Set((list?.[1] ?? "").split(/, | and /u));
  expect(skills.map(({ name }) => name).filter((name) => !named.has(name))).toStrictEqual([]);
});

// A run's uncertain write status is the host's own word, so the shared sentences leave it to a
// host section: the local host says `may_have_applied`, and a composing host says its own.
it("names the local host's own status for a run's uncertain write", async () => {
  const local = ((await renderedTexts("typescript/authoring")).get("writes") ?? "").replace(/\s+/g, " ");
  expect(local).toContain(
    "before reporting its marks, returns `may_have_applied` with any unconfirmed result",
  );
  expect(local).toContain("An `unverifiable` write reports `may_have_applied` too");
  expect(local).not.toContain("possibly_completed");
  const root = await authoringCopy((path, text) =>
    path.endsWith("/writes/SKILL.md")
      ? text.replace(sectionMarker, (marker: string, id: string) =>
          id.endsWith("-status") ? "`OTHER-STATUS`" : marker,
        )
      : text,
  );
  try {
    const composed = ((await renderedTexts(root)).get("writes") ?? "").replace(/\s+/g, " ");
    expect(composed).toContain("returns `OTHER-STATUS` with any unconfirmed result");
    expect(composed).toContain("An `unverifiable` write reports `OTHER-STATUS` too");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A read build becomes a write through `mint_update`; `request_input` takes no write upgrade.
it("asks for no write upgrade through request_input anywhere in the shared text", async () => {
  const texts = await renderedTexts("typescript/authoring");
  expect(
    [...texts].filter(([, text]) => /writeUpgrade|write upgrade/iu.test(text)).map(([name]) => name),
  ).toStrictEqual([]);
  expect((texts.get("workspace/AGENTS.md") ?? "").replace(/\s+/g, " ")).toContain(
    "ask the caller with request_input what would change, then change the task to a write with mint_update",
  );
});

/*
 * The publication skill is one text for both hosts. The local builder reads the shared lines about
 * the private fallback, which its preamble lists as a hosted feature, and about the login URL
 * check and recorded confirm popups, which it now has too. The hosted-only checks (site metadata, the HTTP version, recorded requests,
 * session tokens, protected results) stay in host sections it never reads. It saves every file
 * under the four folders when Node could load one the operation's imports do not name.
 */
it("gives the local builder the shared publication text and no hosted-only check", async () => {
  const texts = await renderedTexts("typescript/authoring");
  const publication = (texts.get("publication") ?? "").replace(/\s+/g, " ");
  expect(publication).toContain(
    "Never run the write again. After the last round the host publishes privately and flags it |",
  );
  expect(publication).toContain("- **Login URL.** A signed-in tool publishes the `loginUrl`");
  expect(publication).toContain("`confirmation_unrecorded`, `confirm_action_unmatched`,");
  expect(publication).toContain(
    "`finish_build`'s metadata names the tool and describes it in the public definition Guardian reviews (`publication/definition.json`):",
  );
  expect(publication).toContain(
    "module they import, or every file under those four folders when Node could load a saved file those imports do not name, or the workspace has a `package.json`.",
  );
  for (const hosted of [
    "siteName",
    "routes.json",
    "tool-http.mjs",
    "recorded-requests",
    "session token",
    "issuing response",
    "integration",
    "missing_protected_result",
  ])
    expect(publication).not.toContain(hosted);
  expect(texts.get("core")?.replace(/\s+/g, " ")).toContain(
    "during the run, and publication before the first `finish_build`.",
  );
});

/*
 * The testing skill's capture loading, saved HTTP and DOM fixtures and post-publication cases are
 * another host's sections, so neither the local host nor a host that composes nothing reads them.
 */
it("keeps the testing skill's capture and saved-fixture paragraphs in host sections", async () => {
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    for (const texts of [await renderedTexts("typescript/authoring"), await renderedTexts(root)]) {
      const testing = (texts.get("testing") ?? "").replace(/\s+/g, " ");
      expect(testing).toContain(
        "- pureFiles: parsers/calculation with ordinary files and meaningful assertions. - liveBrowser: authorized fresh observation",
      );
      for (const hosted of [
        "retain_capture",
        "loadCaptureFixture",
        "network.ndjson",
        "SavedCaptureEvidence",
        "held-out",
        "## Load existing capture evidence",
      ])
        expect(testing).not.toContain(hosted);
      expect(testing.trimEnd().endsWith("silently call production from an offline test.")).toBe(
        true,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
 * The stale-session rule is one text for both hosts: the host signs in again by itself when a reset
 * or a page load leaves the site signed out, and a step it cannot keep signed in fails with
 * `session_not_kept`. The local host does both.
 */
it("gives both hosts the same stale-session rule", async () => {
  const sentence =
    "A signed-in build gets back the session saved right after sign-in instead. When the page is signed out after that reset, or after a full page load your source asks about with `ensureSignedIn`, the host signs in again by itself; do not call `authenticate` for it. When the host cannot keep the site signed in, the step fails with `session_not_kept`: report that cause instead of signing in again. That source must perform the flow from its input, never rely on a page an exploration left open.";
  const local = (await renderedTexts("typescript/authoring")).get("core") ?? "";
  expect(local.replace(/\s+/g, " ")).toContain(sentence);
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    const composed = (await renderedTexts(root)).get("core")?.replace(/\s+/g, " ") ?? "";
    expect(composed).toContain(sentence);
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
    ["3b2675ba76183eace4ddab175651ba59685aecf7a4f43fb0fa66466f11414bf9", "core"],
    ["90be0a8d6480497b79bc18724b6f6ff2abcd1971fc59189bf18f12cf37b3ef7c", "search"],
    ["fb38da33920193937b44e85e9ecf00c628311a13b9218868a054207209f19be4", "auth"],
    ["647c39673b73eb0b5c8dbd451f61531ae2cc2c53ca842382030a4f37c2788983", "testing"],
    ["9950488e2fe7907774479c528a6378d368d7d618b375d3450882ba2d9f49e240", "pagination"],
    ["50b398c0abef87fa73454d8a7d0eb3e60341827dbac6fd90f6c4725219136e05", "forms"],
    ["c02d1bdafa584a4f8b03b3bd4688edcf044b9aee077afbce33fafa114f7e6ba2", "writes"],
    ["a6a79d3d19f685f4d05697ce105102465b0fd5244a0cf1e297ac9e9cdd9f4d9e", "cart"],
    ["b3147e9625a33c2a7c3db014199964d574af5e892d72b65680cda843e66da3e0", "caller-input"],
    ["c882afded68960b6387260744bd119c0d397b9ed08c004c9421e486d24432c79", "publication"],
    ["5ff05613733463e730f1fcc791fa1645f8be7ad613352852d9644f83ab6d416e", "workspace/AGENTS.md"],
    ["e023d1b6f7bc3673118d4310d9813cfa878c554b68a353413e73592054d2704d", "workspace/README.md"],
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
    ["aba44b16df36914a1d988881085b9b43e4d6e0570e0a68423318eecd7abb4cbc", "read, 1 left"],
    ["bad5f0878c5ecce40c209c1f5e3bd0dac6422c9e42fb0a857c0281e99c6e88eb", "read, 0 left"],
    ["acf24b4205a7e37c6cfab1f19421d36f26a385bbc7bcaaf8a2799ef29fc77d5e", "write, 1 left"],
    ["fa380b552c8ddec278fc6d2de4f613a37459d2f9cbf3c9393fe94251ee71511a", "write, 0 left"],
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
          executeKernelOperation(
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
      executeKernelOperation(
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
