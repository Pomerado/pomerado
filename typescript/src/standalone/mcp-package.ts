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
if (!runtime) throw new Error('Start this integration with the command and arguments in its mcp.json.');
const { startMcpCli } = await import(runtime);
startMcpCli(['serve', '--artifact', fileURLToPath(new URL('.', import.meta.url))]);
`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const reserved = new Set(["deployment.json", "mcp.mjs", "mcp.json", "readme.md"]);

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
        const configPath = join(directory, "mcp.json");
        const runtime = new URL("./mcp-cli.js", import.meta.url).href;
        const args = [launcherPath, runtime];
        const configuration = {
          mcpServers: { [deployment.name]: { command: process.execPath, args } },
        };
        const command = [process.execPath, ...args].map(shellQuote).join(" ");
        yield* workspace.write("deployment.json", `${JSON.stringify(deployment, null, 2)}\n`);
        yield* workspace.write("mcp.mjs", launcher);
        yield* workspace.write("mcp.json", `${JSON.stringify(configuration, null, 2)}\n`);
        yield* workspace.write(
          "README.md",
          `# ${deployment.name}

This integration runs on your computer as a local MCP stdio server. mcp.json holds its server
entry in the standard mcpServers format. The entry starts your Node with this directory's
launcher and your installed Pomerado runtime.

## Add it to your MCP client

- Claude Code passes its own environment to the server.

  \`\`\`sh
  claude mcp add ${deployment.name} -- ${command}
  \`\`\`

- Codex passes servers only a short list of environment variables. After adding the server, put
  \`env_vars = ["OPENAI_API_KEY"]\` under \`[mcp_servers.${deployment.name}]\` in its config.toml.

  \`\`\`sh
  codex mcp add ${deployment.name} -- ${command}
  \`\`\`

- Gemini CLI hides variables named like keys from servers. The -e flag below passes
  OPENAI_API_KEY by reference, so the settings file holds no key.

  \`\`\`sh
  gemini mcp add -e 'OPENAI_API_KEY=$OPENAI_API_KEY' ${deployment.name} ${command}
  \`\`\`

- Cursor, VS Code, Claude Desktop and other clients that read an mcpServers JSON file take the
  entry from mcp.json. In Cursor, add \`"env": { "OPENAI_API_KEY": "\${env:OPENAI_API_KEY}" }\`
  to it.

## Model key

The server needs OPENAI_API_KEY in its environment, because Guardian reviews every run. Model
requests go to the configured provider. This directory and mcp.json hold no key. Give the key to
the server through your client's environment settings, never through chat.

## Call it

Call ${deployment.name} with its discovered input schema. Its URL, intent, authority and
authentication origins are pinned in deployment.json. A call that needs an answer or more time
returns a job ID. Continue that job with get_job, provide_input and cancel_job. Polling never
resubmits an operation.

Answers sent through provide_input are visible to your MCP client and its model provider.
Restarting the server loses live jobs.

## Paths

The launcher uses your installed Pomerado runtime, its minter and Guardian dependencies, and
local Chromium. The launcher source is portable. mcp.json names your current Node and Pomerado
installation. Update those paths if you move either installation or this directory.
`,
        );
        completed = true;
        return { directory, configPath, launcherPath };
      });
  });
