import { Effect, Schema } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import { localError, localRelativePath } from "../execution/local-path.js";
import { Artifact, type MintArtifact } from "./contracts.js";

const Metadata = Schema.Struct({
  entrypoint: Schema.String,
  files: Schema.Array(Schema.String),
  inputSchema: Schema.Unknown,
  outputSchema: Schema.Unknown,
});
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
          if (paths.some((path) => path.split("/")[0]?.toLowerCase() === "pomerado.json"))
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
    return yield* validateArtifact({ ...metadata, files });
  });

export const writeArtifact = (directory: string, artifact: MintArtifact) =>
  Effect.gen(function* () {
    const checked = yield* validateArtifact(artifact);
    const workspace = yield* createLocalWorkspace({ root: directory });
    for (const file of checked.files) yield* workspace.write(file.path, file.content);
    yield* workspace.write(
      "pomerado.json",
      `${JSON.stringify(
        {
          entrypoint: checked.entrypoint,
          files: checked.files.map((file) => file.path),
          inputSchema: checked.inputSchema,
          outputSchema: checked.outputSchema,
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
