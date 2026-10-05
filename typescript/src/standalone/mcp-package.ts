import { mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { createLocalWorkspace } from "../execution/local-workspace.js";
import {
  localFilePath,
  localPromise,
  localError,
  localRelativePath,
} from "../execution/local-path.js";
import type { MintArtifact, PomeradoRequest } from "./contracts.js";
import { Deployment, writeArtifact } from "./artifact-files.js";

const launcher = `import { fileURLToPath } from 'node:url';
const runtime = process.argv[2];
if (!runtime) throw new Error('Start this integration using its generated Codex configuration.');
const { startMcpCli } = await import(runtime);
startMcpCli(['serve', '--artifact', fileURLToPath(new URL('.', import.meta.url))]);
`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const reserved = new Set(["deployment.json", "mcp.mjs", "codex-mcp.toml", "readme.md"]);

/** Only the local operator's configuration chooses the root; tool arguments choose one slug. */
export const prepareIntegration = (options: {
  readonly root: string;
  readonly name: string;
  readonly request: PomeradoRequest;
  readonly description?: string;
}) =>
  Effect.gen(function* () {
    const deployment = yield* Schema.decodeUnknown(Deployment)({
      name: options.name,
      description: options.description ?? options.request.intent,
      request: {
        url: options.request.url,
        intent: options.request.intent,
        effect: options.request.effect,
        ...(options.request.authenticationOrigins === undefined
          ? {}
          : {
              authenticationOrigins: options.request.authenticationOrigins,
            }),
      },
    }).pipe(Effect.mapError(localError));
    yield* localPromise(() => mkdir(resolve(options.root), { recursive: true }));
    const root = yield* localPromise(() => realpath(resolve(options.root)));
    const directory = yield* localFilePath(root, deployment.name);
    let completed = false;
    yield* Effect.acquireRelease(
      localPromise(() => mkdir(directory)),
      () =>
        completed
          ? Effect.void
          : localPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
    );
    return (artifact: MintArtifact) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => {
            if (
              artifact.files.some((file) =>
                reserved.has((localRelativePath(file.path).split("/")[0] ?? "").toLowerCase()),
              )
            )
              throw new Error("Artifact source collides with an integration packaging file");
          },
          catch: localError,
        });
        yield* writeArtifact(directory, artifact);
        const workspace = yield* createLocalWorkspace({ root: directory });
        const launcherPath = join(directory, "mcp.mjs");
        const configPath = join(directory, "codex-mcp.toml");
        const runtime = new URL("./mcp-cli.js", import.meta.url).href;
        const configuration = `[mcp_servers.${deployment.name}]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify([launcherPath, runtime])}
env_vars = ["OPENAI_API_KEY"]
`;
        yield* workspace.write("deployment.json", `${JSON.stringify(deployment, null, 2)}\n`);
        yield* workspace.write("mcp.mjs", launcher);
        yield* workspace.write("codex-mcp.toml", configuration);
        yield* workspace.write(
          "README.md",
          `# ${deployment.name}

This integration is hosted locally over MCP stdio. Add the command and arguments from
codex-mcp.toml to your Codex configuration (~/.codex/config.toml). Alternatively, register it with:

\`\`\`sh
codex mcp add ${deployment.name} -- ${shellQuote(process.execPath)} ${shellQuote(launcherPath)} ${shellQuote(runtime)}
\`\`\`

Call ${deployment.name} with its discovered input schema. Its URL, intent, authority and
authentication origins are pinned in deployment.json. Jobs and questions continue through
get_job, provide_input and cancel_job; polling never resubmits an operation.

The launcher uses the shared installed Pomerado runtime, minter/Guardian dependencies and
local Chromium. Configured model providers receive model requests. The TOML forwards
OPENAI_API_KEY from Codex's environment. Supply provider keys in
the server's environment; this directory and its configuration contain no keys. Answers sent
through provide_input are visible to the MCP client and its model. Restarting loses live jobs.

The launcher source is portable. The local configuration references your current Node and
runtime installation; update those paths if you move either installation or this directory.
`,
        );
        completed = true;
        return { directory, configPath, launcherPath };
      });
  });
