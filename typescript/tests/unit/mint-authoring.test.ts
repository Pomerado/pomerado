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
import dialogPicker from "../../authoring/examples/dialog-picker.js";
import { continueInvoices } from "../../authoring/examples/pagination.js";
import { selectInvoiceLayout } from "../../authoring/examples/variants.js";
import { loadAuthoringSkills, loadWorkspaceGuide } from "../../src/mint/skills.js";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { executeKernelOperation, offlineKernel } from "../../src/runtime/kernel-operation.js";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

it("loads modular skill references and keeps auth discovery outside managed login", async () => {
  expect("websiteAuth" in authEntry).toBe(false);
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring", "standalone"));
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
    (await Effect.runPromise(loadAuthoringSkills("typescript/authoring", "standalone"))).map(
      (skill) => skill.name,
    ),
  );
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring", "standalone"));
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

/** What a host does before loading in hosted mode: every section gets the host's text. */
const composeHostText = (text: string) =>
  text.replace(sectionMarker, (_match, id: string) => `host text for ${id}`);

const contents = (skills: readonly SkillDescriptor[]) =>
  skills.map((skill) => {
    if (!(skill.content instanceof Uint8Array)) throw new Error(`${skill.name} is not bytes`);
    return new TextDecoder().decode(skill.content);
  });

it("loads standalone text by default and refuses uncomposed sections in hosted mode", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  expect(skills).toEqual(
    await Effect.runPromise(loadAuthoringSkills("typescript/authoring", "standalone")),
  );
  for (const text of [...contents(skills), ...guide.files.values()])
    expect(text).not.toContain("<!-- pomerado:");
  const refused = { _tag: "Left", left: { code: "Unavailable" } };
  expect(
    await Effect.runPromise(Effect.either(loadAuthoringSkills("typescript/authoring", "hosted"))),
  ).toMatchObject(refused);
  expect(
    await Effect.runPromise(Effect.either(loadWorkspaceGuide("typescript/authoring", "hosted"))),
  ).toMatchObject(refused);
});

it("loads a host-composed directory in hosted mode exactly as composed", async () => {
  const root = await authoringCopy((_path, text) => composeHostText(text));
  try {
    const skills = await Effect.runPromise(loadAuthoringSkills(root, "hosted"));
    const guide = await Effect.runPromise(loadWorkspaceGuide(root, "hosted"));
    for (const [index, skill] of skills.entries())
      expect(contents(skills)[index]).toBe(
        await readFile(join(root, skill.name, "SKILL.md"), "utf8"),
      );
    expect(guide.instructions).toBe(await readFile(join(root, "workspace/AGENTS.md"), "utf8"));
    expect(guide.instructions).toContain("host text for ");
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
    "Do not infer invalid input from a timeout, missing observation, lost authentication, or failure of our automation. Not finding a value where you first looked is not that evidence. Before you call a value unavailable, look everywhere the site keeps it, such as later calendar months, other tabs or more results.",
  );
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
    ["43687c3a072436628b4694bc0fc788b2d6ab126200dfaf504fcc393358eb58f4", "core"],
    ["3b569c6f058ac70c7a68d930aae8bad26cc42947fdfc6545db38ad77692bce3a", "auth"],
    ["d994e365240de6503f2173214e0d9e541a31acc8bed4b91c6342f503abb75008", "pagination"],
    ["97287c44e1b4629efa00f066d65ba0859cb4a4625d44b97faea7784b0a084afd", "forms"],
    ["4b99ef8281a9e202be17a353f7a7b25e7c4da7bc00afc84088e2077be6d0683f", "writes"],
    ["c6f95c20707e9f3e799ffe71999997aa887c0ffa0c893af0f8c408c5d04ab179", "caller-input"],
    ["1476c2ae5a2ef3250df463e2a87951bcf2cfda2afe36e5fd95896da6338606c2", "workspace/AGENTS.md"],
    ["f0ecedee023825939be935b5444aadc0ad57421c1a047127caae2d4a564186d1", "workspace/README.md"],
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
])("refuses %s in either mode", async (_case, appended) => {
  const append = (path: string, text: string) =>
    path.endsWith(join("core", "SKILL.md")) ? `${text}${appended}` : text;
  // The hosted copy is composed as in the test above, which loads, so only the marker fails it.
  const roots = {
    standalone: await authoringCopy(append),
    hosted: await authoringCopy((path, text) => append(path, composeHostText(text))),
  };
  try {
    for (const [mode, root] of Object.entries(roots) as [keyof typeof roots, string][])
      expect(await Effect.runPromise(Effect.either(loadAuthoringSkills(root, mode)))).toMatchObject(
        { _tag: "Left", left: { code: "Unavailable" } },
      );
  } finally {
    for (const root of Object.values(roots)) await rm(root, { recursive: true, force: true });
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
            { kernel: offlineKernel, sessionId: "offline", offline: true },
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
