import { Script } from "node:vm";
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
      Schema.decodeUnknown(detailNavigation.input)({ recordId: "record_42" }),
    ),
  ).toEqual({ recordId: "record_42" });
  expect(
    await Effect.runPromise(
      Effect.either(Schema.decodeUnknown(detailNavigation.input)({ recordId: "../other-record" })),
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
