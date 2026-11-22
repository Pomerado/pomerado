import { Effect, Either, Schema } from "effect";
import { ExpectedConfirms } from "../browser/dialogs/expected.js";
import { autofillRecipePath } from "../destinations/autofill-recipe.js";
import { decodeSignInRecipe, signInRecipeText } from "../destinations/sign-in-recipe.js";
import {
  decodeSignInStateEntry,
  type SignInStateEntry,
  type SignInStates,
  signInStateEntryText,
  signInStatesOf,
} from "../destinations/sign-in-states.js";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { localError, localRelativePath } from "../execution/local-path.js";
import { ScriptQuestionDeclarations } from "../runtime/script-input.js";
import { SignInRunFailed } from "../runtime/sign-in-replay.js";
import { Artifact, PageUrl, SignInOrigin, type MintArtifact } from "./contracts.js";

/** Where an integration keeps its sign-in's screens, beside `pomerado.json`. */
export const signInStatesPath = "sign-in-states.json";

const Metadata = Schema.Struct({
  entrypoint: Schema.String,
  files: Schema.Array(Schema.String),
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown,
  /**
   * Where the build's sign-in is: its screens (`sign-in-states.json`), or, for an integration
   * written before builds recorded screens, its recipe (`auth-fill.json`); where its runs start
   * and the build's https sign-in origins.
   */
  signIn: Schema.optionalWith(
    Schema.Union(
      Schema.Struct({
        states: Schema.Literal(signInStatesPath),
        entryUrl: PageUrl,
        authenticationOrigins: Schema.optionalWith(Schema.Array(SignInOrigin), { exact: true }),
      }),
      Schema.Struct({
        recipe: Schema.Literal(autofillRecipePath),
        entryUrl: PageUrl,
        authenticationOrigins: Schema.optionalWith(Schema.Array(SignInOrigin), { exact: true }),
      }),
    ),
    { exact: true },
  ),
  /** The questions publication reviewed, the only ones a run asks. */
  questions: Schema.optionalWith(ScriptQuestionDeclarations, { exact: true }),
  /** The confirm popups a write's build accepted, as digests its runs accept without asking. */
  acceptedConfirms: Schema.optionalWith(ExpectedConfirms, { exact: true }),
});
/** The artifact's own files beside its source, which no source path may name. */
const metadataFiles = new Set(["pomerado.json", autofillRecipePath, signInStatesPath]);

/**
 * `sign-in-states.json`: format 1, the library's workspace when it has one, and its entries in
 * the order they were stored, each in its stored form.
 */
const StatesFile = Schema.parseJson(
  Schema.Struct({
    format: Schema.Literal(1),
    workspace: Schema.optionalWith(Schema.Struct({ parent: Schema.String }), { exact: true }),
    entries: Schema.Array(Schema.Unknown),
  }),
);

/** A library in its stored form: every state, then every marker, then every transition. */
const signInStatesText = (library: SignInStates) =>
  `${JSON.stringify(
    {
      format: 1,
      ...(library.workspace === undefined ? {} : { workspace: library.workspace }),
      entries: [...library.states, ...library.signedIn, ...library.transitions].map(
        (entry) => JSON.parse(signInStateEntryText(entry)) as unknown,
      ),
    },
    null,
    2,
  )}\n`;

/**
 * A stored library read back. An entry this host can't read, or one whose key is not its
 * content's, fails it whole, as does a library with no state or no marker: a run never signs in
 * from part of its screens.
 */
const decodeSignInStates = (text: string): SignInStates | "invalid" | "unknown_version" => {
  const stored = Schema.decodeUnknownEither(StatesFile)(text);
  if (stored._tag === "Left") {
    const format = Either.getOrUndefined(Schema.decodeUnknownEither(Schema.parseJson())(text));
    const version: unknown =
      typeof format === "object" && format !== null ? Reflect.get(format, "format") : undefined;
    return typeof version === "number" && version !== 1 ? "unknown_version" : "invalid";
  }
  const entries = stored.right.entries.map(decodeSignInStateEntry);
  if (entries.some((entry) => entry === undefined)) return "invalid";
  // A workspace step needs the library's workspace; the library would leave it out.
  if (
    stored.right.workspace === undefined &&
    entries.some((entry) => entry?.kind === "state" && entry.step.origin === "workspace")
  )
    return "invalid";
  const library = signInStatesOf(stored.right, entries as SignInStateEntry[]);
  return library.states.length === 0 || library.signedIn.length === 0 ? "invalid" : library;
};
const HttpUrl = Schema.String.pipe(
  Schema.filter((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  }),
);
export const Deployment = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]{0,63}$/)),
  description: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  request: Schema.Struct({
    url: HttpUrl,
    intent: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16384)),
    effect: Schema.Literal("read", "write"),
    authenticationOrigins: Schema.optionalWith(Schema.Array(HttpUrl), { exact: true }),
  }),
});
export type Deployment = typeof Deployment.Type;

export const validateArtifact = (value: unknown) =>
  Schema.decodeUnknown(Artifact)(value).pipe(
    Effect.tap((artifact) =>
      Effect.try({
        try: () => {
          const paths = artifact.files.map((file) => localRelativePath(file.path));
          if (paths.some((path) => metadataFiles.has(path.split("/")[0]?.toLowerCase() ?? "")))
            throw new Error("Artifact source collides with its metadata file");
          if (
            new Set(paths).size !== paths.length ||
            !paths.includes(localRelativePath(artifact.entrypoint))
          )
            throw new Error("Artifact requires unique files and a listed entrypoint");
        },
        catch: localError,
      }),
    ),
    Effect.mapError(localError),
  );

export const readArtifact = (directory: string) =>
  Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace({ root: directory });
    const metadata = yield* workspace
      .read("pomerado.json")
      .pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Metadata))),
        Effect.mapError(localError),
      );
    const files = yield* Effect.forEach(metadata.files, (path) =>
      workspace.read(path).pipe(Effect.map((content) => ({ path, content }))),
    );
    const { signIn, ...source } = metadata;
    if (signIn === undefined) return yield* validateArtifact({ ...source, files });
    // A sign-in this host cannot read fails the artifact: it never runs signed out instead.
    const text = yield* workspace
      .read("states" in signIn ? signIn.states : signIn.recipe)
      .pipe(
        Effect.mapError(() => new SignInRunFailed({ code: "MissingRecipe", reason: "missing" })),
      );
    if ("states" in signIn) {
      const states = decodeSignInStates(text);
      if (states === "invalid" || states === "unknown_version")
        return yield* new SignInRunFailed({ code: "MissingRecipe", reason: states });
      return yield* validateArtifact({ ...source, files, signIn: { ...signIn, states } });
    }
    // An integration written before builds recorded screens signs in by its recipe.
    const recipe = decodeSignInRecipe(text);
    if (recipe === "invalid" || recipe === "unknown_version")
      return yield* new SignInRunFailed({ code: "MissingRecipe", reason: recipe });
    return yield* validateArtifact({ ...source, files, signIn: { ...signIn, recipe } });
  });

/** The file a checked artifact's sign-in is written to, its text, and its `pomerado.json` entry. */
const storedSignIn = (signIn: (typeof Artifact.Type)["signIn"]) =>
  Effect.gen(function* () {
    if (signIn === undefined) return undefined;
    const { recipe, states, ...rest } = signIn;
    if (states !== undefined)
      return {
        path: signInStatesPath,
        text: signInStatesText(states),
        metadata: { states: signInStatesPath, ...rest },
      };
    if (recipe === undefined)
      return yield* Effect.fail(localError(new Error("Artifact sign-in has no screens or recipe")));
    return {
      path: autofillRecipePath,
      text: signInRecipeText(recipe),
      metadata: { recipe: autofillRecipePath, ...rest },
    };
  });

export const writeArtifact = (directory: string, artifact: MintArtifact) =>
  Effect.gen(function* () {
    const checked = yield* validateArtifact(artifact);
    const workspace = yield* createLocalWorkspace({ root: directory });
    for (const file of checked.files) yield* workspace.write(file.path, file.content);
    // A sign-in with screens is written as its screens alone; only one without them, as an
    // integration read from before builds recorded screens, keeps its recipe.
    const signIn = yield* storedSignIn(checked.signIn);
    if (signIn?.text !== undefined) yield* workspace.write(signIn.path, signIn.text);
    yield* workspace.write(
      "pomerado.json",
      `${JSON.stringify(
        {
          entrypoint: checked.entrypoint,
          files: checked.files.map((file) => file.path),
          inputSchema: checked.inputSchema,
          outputSchema: checked.outputSchema,
          ...(signIn === undefined ? {} : { signIn: signIn.metadata }),
          ...(checked.questions === undefined ? {} : { questions: checked.questions }),
          ...(checked.acceptedConfirms === undefined
            ? {}
            : { acceptedConfirms: checked.acceptedConfirms }),
        },
        null,
        2,
      )}\n`,
    );
  });

export const readIntegration = (directory: string) =>
  Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace({ root: directory });
    const deployment = yield* workspace
      .read("deployment.json")
      .pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(Deployment))),
        Effect.mapError(localError),
      );
    return { artifact: yield* readArtifact(directory), deployment };
  });
