import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import { signInRecipe, type RecordedSignInStep } from "../../src/destinations/sign-in-recipe.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { prepareIntegration } from "../../src/standalone/mcp-package.js";
import { readArtifact, writeArtifact } from "../../src/standalone/artifact-files.js";
import * as pomerado from "../../src/standalone/index.js";
import { SignInRunFailed } from "../../src/runtime/sign-in-replay.js";
import { screenedSignIn } from "../../src/standalone/mint-publication.js";

/** A verified sign-in's recipe as a build publishes it: selectors and slots, never a value. */
const signIn = {
  recipe: {
    version: 3 as const,
    steps: [
      {
        page: "https://example.test/login",
        fields: [
          { selector: "#user", accepts: ["username" as const] },
          { selector: "#password", slot: "password" as const },
        ],
        submit: "#sign-in",
        submittedBy: "host" as const,
      },
      {
        page: "https://example.test/challenge",
        fields: [
          { selector: "#answer", slot: "private_answer" as const, questionSelector: "#question" },
        ],
        submit: "#continue",
      },
    ],
    signedIn: { selector: "#account-menu" },
  },
  entryUrl: "https://example.test/login?next=%2Faccount",
};
const source = {
  entrypoint: "src/main.mjs",
  files: [{ path: "src/main.mjs", content: "export default {};" }],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};
const scratch = async (use: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-artifact-"));
  try {
    await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const run = <A>(effect: Effect.Effect<A, unknown, import("effect").Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

it("writes a sign-in as auth-fill.json beside pomerado.json and reads it back", () =>
  scratch(async (directory) => {
    const artifact = { ...source, signIn };
    expect(await run(writeArtifact(directory, artifact).pipe(Effect.andThen(readArtifact(directory))))).toEqual(
      artifact,
    );
    expect((await readdir(directory)).sort()).toEqual(["auth-fill.json", "pomerado.json", "src"]);
    expect(JSON.parse(await readFile(join(directory, "auth-fill.json"), "utf8"))).toEqual(
      signIn.recipe,
    );
    expect(JSON.parse(await readFile(join(directory, "pomerado.json"), "utf8"))).toEqual({
      entrypoint: "src/main.mjs",
      files: ["src/main.mjs"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      signIn: { recipe: "auth-fill.json", entryUrl: signIn.entryUrl },
    });
  }));

it("keeps the questions publication reviewed in pomerado.json and reads them back", () =>
  scratch(async (directory) => {
    const questions = { delivery: { type: "choice" as const, prompt: "Which delivery speed?" } };
    const artifact = { ...source, questions };
    expect(await run(writeArtifact(directory, artifact).pipe(Effect.andThen(readArtifact(directory))))).toEqual(
      artifact,
    );
    expect(JSON.parse(await readFile(join(directory, "pomerado.json"), "utf8"))).toEqual({
      entrypoint: "src/main.mjs",
      files: ["src/main.mjs"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      questions,
    });
    // An invalid question id is refused before anything is written.
    await scratch(async (other) => {
      await expect(
        run(writeArtifact(other, { ...source, questions: { Delivery: questions.delivery } })),
      ).rejects.toThrow();
      expect(await readdir(other)).toEqual([]);
    });
  }));

it("keeps an empty question set in pomerado.json, apart from an artifact saved without one", () =>
  scratch(async (directory) => {
    const artifact = { ...source, questions: {} };
    const restored = await run(writeArtifact(directory, artifact).pipe(Effect.andThen(readArtifact(directory))));
    expect(restored).toEqual(artifact);
    expect("questions" in restored).toBe(true);
    expect(JSON.parse(await readFile(join(directory, "pomerado.json"), "utf8"))).toMatchObject({
      questions: {},
    });
  }));

it("reads an artifact written without a sign-in as it always was", () =>
  scratch(async (directory) => {
    // pomerado.json as 0.2.0 wrote it: no signIn, and no recipe beside it.
    await writeFile(
      join(directory, "pomerado.json"),
      `${JSON.stringify({ entrypoint: "src/main.mjs", files: ["src/main.mjs"], inputSchema: { type: "object" }, outputSchema: { type: "object" } }, null, 2)}\n`,
    );
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/main.mjs"), "export default {};");
    const restored = await run(readArtifact(directory));
    expect(restored).toEqual(source);
    expect("signIn" in restored).toBe(false);
    expect("questions" in restored).toBe(false);
  }));

it.each([
  [{ ...signIn.recipe, version: 4 }, "unknown_version"],
  [{ ...signIn.recipe, version: 2 }, "invalid"],
  ["not json", "invalid"],
  [undefined, "missing"],
])("refuses an artifact whose recipe it cannot read (%#)", (recipe, reason) =>
  scratch(async (directory) => {
    await run(writeArtifact(directory, { ...source, signIn }));
    if (recipe === undefined) await rm(join(directory, "auth-fill.json"));
    else
      await writeFile(
        join(directory, "auth-fill.json"),
        typeof recipe === "string" ? recipe : JSON.stringify(recipe),
      );
    // The run fails before signing in or running anything, rather than running signed out.
    const failure = await run(Effect.flip(readArtifact(directory)));
    expect(failure).toMatchObject({ _tag: "SignInRunFailed", code: "MissingRecipe", reason });
    // A library caller tells it apart with the class `pomerado` exports.
    expect(failure).toBeInstanceOf(pomerado.SignInRunFailed);
    expect(pomerado.SignInRunFailed).toBe(SignInRunFailed);
    expect(failure.message).toContain("doesn't run signed out");
  }));

it("refuses a version 2 recipe that names a question selector before writing it", () =>
  scratch(async (directory) => {
    await expect(
      run(writeArtifact(directory, { ...source, signIn: { ...signIn, recipe: { ...signIn.recipe, version: 2 } } } as never)),
    ).rejects.toThrow("sign-in recipe");
    expect(await readdir(directory)).toEqual([]);
  }));

it("refuses an entry address with a fragment or credentials", () =>
  scratch(async (directory) => {
    for (const entryUrl of ["https://example.test/login#state", "https://user:secret@example.test/login"])
      await expect(
        run(writeArtifact(directory, { ...source, signIn: { ...signIn, entryUrl } })),
      ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  }));

it("writes auth-fill.json in the bytes another host writes for the same recipe", () =>
  scratch(async (directory) => {
    // A version 2 sign-in with rejection markers, one beside a popup, a method choice and an
    // approval, recorded in the order a host holds each screen.
    const steps: RecordedSignInStep[] = [
      {
        page: "https://site.test/login",
        rejectedMarkers: [{ slot: "password", selector: ".err" }],
        fields: [
          { selector: "#u", slot: "username", accepts: ["username"] },
          { selector: "#p", slot: "password" },
        ],
        submit: "#go",
        submittedBy: "host",
      },
      {
        page: "https://auth.site.test/x",
        rejectedMarkers: [{ slot: "date_of_birth", selector: ".dob-error" }],
        popup: { opener: "primary", origin: "https://auth.site.test" },
        fields: [{ selector: "#dob", slot: "date_of_birth", format: "MM/DD/YYYY", control: "text" }],
        submit: "#n",
        methods: [{ method: "sms", selector: "#n" }],
      },
      { page: "https://site.test/approve", fields: [], approval: "device" },
    ];
    const recipe = signInRecipe(steps, { selector: "#account", openPath: "/me" });
    await run(writeArtifact(directory, { ...source, signIn: { recipe, entryUrl: "https://site.test/login" } }));
    // The host writes JSON.stringify(recipe, null, 2) of each screen in recipeStep's order.
    const host = {
      version: 2,
      steps: [
        {
          page: "https://site.test/login",
          rejectedMarkers: [{ slot: "password", selector: ".err" }],
          fields: [
            { selector: "#u", accepts: ["username"] },
            { selector: "#p", slot: "password" },
          ],
          submit: "#go",
          submittedBy: "host",
        },
        {
          page: "https://auth.site.test/x",
          popup: { opener: "primary", origin: "https://auth.site.test" },
          rejectedMarkers: [{ slot: "date_of_birth", selector: ".dob-error" }],
          fields: [{ selector: "#dob", slot: "date_of_birth", format: "MM/DD/YYYY", control: "text" }],
          submit: "#n",
          methods: [{ method: "sms", selector: "#n" }],
        },
        { page: "https://site.test/approve", approval: "device", fields: [] },
      ],
      signedIn: { selector: "#account", openPath: "/me" },
    };
    expect(await readFile(join(directory, "auth-fill.json"), "utf8")).toBe(
      JSON.stringify(host, null, 2),
    );
  }));

it("writes a version 1 recipe's file in the same bytes as the recipe the build published", () =>
  scratch(async (directory) => {
    const recipe = signInRecipe(
      [
        {
          page: "https://example.test/login",
          fields: [
            { selector: "#user", slot: "email", accepts: ["username", "email"] },
            { selector: "#password", slot: "password" },
          ],
          submit: "#sign-in",
          submittedBy: "host",
        },
      ],
      { selector: "#account-menu", urlPath: "/account" },
    );
    await run(writeArtifact(directory, { ...source, signIn: { recipe, entryUrl: signIn.entryUrl } }));
    expect(await readFile(join(directory, "auth-fill.json"), "utf8")).toBe(
      JSON.stringify(recipe, null, 2),
    );
  }));

it("refuses to publish a login URL that holds a sign-in value, naming the login URL and never the value", async () => {
  const secrets = makeRunSecrets();
  secrets.register("ada@example.test");
  const held = { ...signIn, entryUrl: "https://example.test/login?email=ada%40example.test" };
  const refused = await Effect.runPromise(Effect.either(screenedSignIn(held, secrets.assertAbsent)));
  if (Either.isRight(refused)) throw new Error("The login URL was published");
  expect(refused.left).toMatchObject({
    code: "PublicationUnavailable",
    reason: "login_url_contains_credential",
    publicationFeedback: { parts: [{ part: "loginUrl", credentialKinds: ["credential"] }] },
  });
  expect(JSON.stringify(refused.left)).not.toContain("ada");
  // A recipe that holds one is refused too, and a sign-in that holds none publishes as it is.
  const named = {
    ...signIn,
    recipe: { ...signIn.recipe, signedIn: { selector: "[data-user='ada@example.test']" } },
  };
  expect(
    Either.isLeft(await Effect.runPromise(Effect.either(screenedSignIn(named, secrets.assertAbsent)))),
  ).toBe(true);
  expect(await Effect.runPromise(screenedSignIn(signIn, secrets.assertAbsent))).toBe(signIn);
  expect(await Effect.runPromise(screenedSignIn(undefined, secrets.assertAbsent))).toBeUndefined();
});

it("preserves an artifact roundtrip and refuses metadata collisions before writing source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pomerado-artifact-"));
  const artifact = {
    entrypoint: "src/main.mjs",
    files: [{ path: "src/main.mjs", content: "export default {};" }],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  };
  try {
    for (const path of [
      "pomerado.json",
      "/workspace/pomerado.json",
      "Pomerado.JSON",
      "pomerado.json/data.txt",
      "auth-fill.json",
      "Auth-Fill.JSON",
      "auth-fill.json/data.txt",
    ]) {
      await expect(
        Effect.runPromise(
          Effect.scoped(
            writeArtifact(directory, {
              ...artifact,
              files: [...artifact.files, { path, content: "authored source" }],
            }),
          ),
        ),
      ).rejects.toThrow("metadata file");
      expect(await readdir(directory)).toEqual([]);
    }
    const restored = await Effect.runPromise(
      Effect.scoped(
        writeArtifact(directory, artifact).pipe(Effect.andThen(readArtifact(directory))),
      ),
    );
    expect(restored).toEqual(artifact);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  "Auth-Fill.json",
  "MCP.mjs",
  "Mcp.Json",
  "readme.md/main.mjs",
  "Codex-MCP.toml",
  ".MCP.json",
  ".vscode/mcp.json",
  ".Cursor/mcp.json",
  ".codex/config.toml",
  ".GEMINI/settings.json",
  ".claude/settings.json",
])(
  "refuses packaging collision %s and removes the incomplete integration",
  async (path) => {
    const root = await mkdtemp(join(tmpdir(), "pomerado-integration-"));
    try {
      await expect(
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const publish = yield* prepareIntegration({
                root,
                name: "reserved_collision",
                request: { url: "https://example.test", intent: "Read page", effect: "read" },
              });
              return yield* publish({
                entrypoint: path,
                files: [{ path, content: "export default {};" }],
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
              });
            }),
          ),
        ),
      ).rejects.toThrow("collides with an integration packaging file");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("packages a client-neutral MCP server entry that holds no key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pomerado-integration-"));
  try {
    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const publish = yield* prepareIntegration({
            root,
            name: "example_reader",
            request: { url: "https://example.test", intent: "Read page", effect: "read" },
          });
          return yield* publish({
            entrypoint: "src/main.mjs",
            files: [{ path: "src/main.mjs", content: "export default {};" }],
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          });
        }),
      ),
    );
    const directory = join(await realpath(root), "example_reader");
    expect(published.configPath).toBe(join(directory, "mcp.json"));
    expect((await readdir(directory)).sort()).toEqual([
      "README.md",
      "deployment.json",
      "mcp.json",
      "mcp.mjs",
      "pomerado.json",
      "src",
    ]);
    const launcher = join(directory, "mcp.mjs");
    expect(JSON.parse(await readFile(published.configPath, "utf8"))).toEqual({
      mcpServers: {
        example_reader: {
          command: process.execPath,
          args: [launcher, expect.stringMatching(/^file:\/\/.+\/mcp-cli\.js$/)],
        },
      },
    });
    const readme = await readFile(join(directory, "README.md"), "utf8");
    for (const command of [
      "claude mcp add example_reader -- ",
      "codex mcp add example_reader -- ",
      "gemini mcp add example_reader ",
    ])
      expect(readme).toContain(command);
    // Running a minted integration makes no Guardian or model request, so it needs no key.
    expect(readme).toContain("The server needs no model key");
    expect(readme).not.toContain("OPENAI_API_KEY");
    expect(readme).not.toContain("env_vars");
    // A call starts at the URL's site root, as the example did, not at its path.
    expect(readme.replaceAll(/\s+/gu, " ")).toContain(
      "Each call starts at the site root of the URL in deployment.json and opens any deeper page itself.",
    );
    expect(readme).not.toContain("Each call opens the URL");
    // A run uses the URL, the authority's tool hints and, to sign in, the sign-in origins from
    // deployment.json.
    expect(readme.replaceAll(/\s+/gu, " ")).toContain(
      "A run doesn't check authority or intent, and edits to src/ or deployment.json aren't reviewed. A run that signs in replays its sign-in only on the site and the sign-in origins in deployment.json.",
    );
    expect(readme).not.toContain("intent or sign-in origins");
    expect(readme).not.toContain("pinned");
    expect(readme).not.toContain("codex-mcp.toml");
    expect(await readFile(launcher, "utf8")).not.toContain("Codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
