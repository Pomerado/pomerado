<h1 align="center"><a href="https://pomerado.ai">Pomerado</a></h1>

<p align="center">Turn websites into MCP integrations.</p>
<p align="center">Describe what you want to do on a website. Pomerado builds an integration your agent can use.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/node-24.21%2B%20%3C25-339933?style=for-the-badge&amp;logo=nodedotjs&amp;logoColor=white" alt="Node 24.21 or later in Node 24">
  <img src="https://img.shields.io/badge/pnpm-10.34.5-F69220?style=for-the-badge&amp;logo=pnpm&amp;logoColor=white" alt="pnpm 10.34.5">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#create-an-integration">Create an integration</a> ·
  <a href="#use-your-integration">Use your integration</a> ·
  <a href="#repository-guide">Repository guide</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

## How it works

Pomerado helps agents use websites, including ones without APIs. Connect it to Codex, describe a task, and get a reusable MCP integration. Both Pomerado and the integrations you create run on your computer.

```text
┌────────────────────────────────────────────────────────────┐
│  website task → Pomerado MCP → integration MCP → Playwright  │
└────────────────────────────────────────────────────────────┘
```

- Describe a task in Codex and let Pomerado build the integration.
- Connect the generated MCP and call it whenever you need it.
- Answer sign-in questions and other prompts in the same chat.
- Use your own browser and model API key.

This repository contains Pomerado's minter and Guardian, with native Playwright for browser execution. Both MCPs use stdio, so Codex starts them for you. Model requests go to your configured provider.

## Quickstart

Use macOS or Linux, Node 24.21 or a later Node 24 release, and pnpm 10.34.5.

```sh
git clone https://github.com/Pomerado/pomerado.git
cd pomerado
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm build
export OPENAI_API_KEY='your-model-api-key'
```

On Linux, install Chromium's system dependencies with `corepack pnpm exec playwright install --with-deps chromium` if needed.

The shared model configuration uses `gpt-6-sol` for minting and `gpt-6-luna` for Guardian. Your model account must have access to both. Local hosting still sends model requests to your configured provider. Library callers can inject Agents SDK `ModelProvider` implementations through `minterProvider` and `guardianProvider`.

### Connect Pomerado to Codex

Find your Node executable and checkout paths.

```sh
node -p 'process.execPath'
pwd
```

Add this section to `~/.codex/config.toml`, replacing the paths with yours. Keep your other configuration sections.

```toml
[mcp_servers.pomerado]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/pomerado/dist/typescript/src/standalone/mcp-cli.js", "mint", "--root", "/absolute/path/to/integrations"]
env_vars = ["OPENAI_API_KEY"]
```

Codex must have `OPENAI_API_KEY` in its environment so it can forward the value to the MCP. Keep that key out of chat and integration source. The configuration names the environment variable without writing its value. See the [Codex MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp) for client setup.

The configured root is where minted integrations are saved. Starting the MCP and listing tools do not launch Chromium or invoke a model.

## Create an integration

Ask Codex to create an integration with Pomerado. We call this minting.

> Use Pomerado to create an integration named example_reader that reads the main heading from https://example.com. Keep it read-only.

- `mint` creates an integration from a name, URL, task description, optional input, and `read` or `write` permission. Names use lowercase letters, digits and underscores.
- `get_job` checks progress and waits for a question or completion. Minting starts once and returns a job ID.
- `provide_input` sends your answer to a question in the same chat. Pomerado checks that the answer matches the requested format.
- `cancel_job` stops the job and cleans up its browser and child process. An action already sent to a website may have taken effect.

Codex uses these tools to continue the same job. Checking progress or answering a question never starts the integration again. The default active mint budget is 20 minutes. Time spent answering a human question does not consume that budget.

Choose write authority only when you intend to change the website. A write mint can perform the requested action while creating the integration. Its final source is checked without repeating that action. The standalone host requires write authority up front.

The destination must be new. Pomerado reserves it before starting work, so a name collision cannot run the task and then fail to save it.

## Use your integration

When minting finishes, Pomerado saves the integration and returns the paths you need to connect it.

```text
integrations/example_reader/
├── src/                 Generated operation modules
├── pomerado.json        Entrypoint and input/output schemas
├── deployment.json      Tool name, description, URL, intent and authority
├── mcp.mjs              Fixed launcher for the shared Pomerado runtime
├── mcp.json             Standard MCP server entry, with no key
└── README.md            Commands and usage for this integration
```

1. Open the generated `README.md`. It lists the add command for each major MCP client, with your local Node, launcher and runtime paths filled in.
2. Add the server to your client, or copy the entry in `mcp.json` into a client that reads an `mcpServers` file.
3. Make sure the server gets `OPENAI_API_KEY` from its environment. Generated integrations still use Guardian.
4. Reload the MCP configuration in your client and ask it to use the integration.

> Use example_reader to read the page heading.

The integration MCP exposes a tool named after your integration, with its arguments nested under `input`. It also provides `get_job`, `provide_input` and `cancel_job` for calls that need an answer or more time.

Ordinary calls return the validated operation output. A pending call returns a job ID to continue. Calling the business tool again starts a new execution, including another website write when the integration has write authority.

The generated launcher imports your installed Pomerado runtime. Keep that installation available. The launcher source is portable, but its local configuration contains installation paths. Update those paths if you move the integration, Node or Pomerado.

## Questions and authentication

When a task needs a login, Pomerado can inspect the sign-in form, ask for credentials in chat, and fill them into the browser. It uses the same sign-in and autofill helpers as the Pomerado application.

Answers sent through `provide_input`, including passwords and codes, are visible to the MCP client and its model provider. Codex should explain this before collecting protected answers. There is no portal, credential vault, saved login recipe, submission ledger or automatic SMS/TOTP service.

Each MCP job owns a fresh browser context and closes it when the job ends. A minted integration does not inherit the mint's signed-in browser. Authenticated runs need their own declared sign-in inputs and implementation. Automatic login replay is not included. The library can keep a signed-in session open across mint and run calls.

Jobs and pending answers live in memory. Restarting the MCP loses active jobs but keeps saved integrations. The default server accepts one active job and retains at most 32 job records, with completed records expiring after 15 minutes.

Supplied secrets are masked in minting-model observations and checked in generated source. Operation outputs are returned without secret redaction. Error diagnostics mask credential-shaped values. Website content reaches the configured models. This package has no general privacy screening service.

<details>
<summary>Attach an existing Playwright browser</summary>

By default, Pomerado launches local Chromium. Add `--headed` to the minting MCP arguments to see it. To use an existing browser server, add `--endpoint` and its native Playwright WebSocket URL to the MCP command arguments.

```toml
args = ["/absolute/path/to/pomerado/dist/typescript/src/standalone/mcp-cli.js", "mint", "--root", "/absolute/path/to/integrations", "--endpoint", "ws://your-browser-host/playwright-endpoint"]
```

The endpoint must support `chromium.connect()`, with a matching Playwright version. A Chromium remote debugging URL for `connectOverCDP()` uses a different protocol. For a local connection test, start a Playwright browser server and use its printed endpoint.

```sh
node --input-type=module -e 'import { chromium } from "playwright"; const server = await chromium.launchServer({ headless: true }); console.log(server.wsEndpoint());'
```

Pomerado owns its browser context. Closing a session closes that context and disconnects from a supplied server, leaving the server and other clients' contexts available. A failed browser transport is invalidated without replaying the request.

</details>

---

## Repository guide

This repository owns the shared minter, Guardian, operation runtime and live authentication helpers. Its local host supplies files, child processes and native Playwright. Pomerado Cloud installs the same core as a pinned library package.

| Path                           | Responsibility                                                   |
| ------------------------------ | ---------------------------------------------------------------- |
| `typescript/src/mint/`         | Shared minter loop, source tools and completion                  |
| `typescript/src/guardian/`     | Shared review loop, source inspection and policy                 |
| `typescript/src/runtime/`      | Shared operation SDK, schemas and browser call contract          |
| `typescript/src/browser/`      | Shared browser helpers used by authored operations               |
| `typescript/src/destinations/` | Shared sign-in inspection, autofill and trusted credential entry |
| `typescript/src/inputs/`       | Input validation, terminal collection and per-session secrets    |
| `typescript/src/execution/`    | Local workspaces, child processes and native Playwright adapter  |
| `typescript/src/standalone/`   | Local library, terminal and MCP composition                      |
| `typescript/src/mcp/schema.ts` | Pure schema adapter shared with the production MCP               |
| `typescript/authoring/`        | Shared prompts and examples, with sections a host can replace    |

<details>
<summary>Runtime boundaries and browser compatibility</summary>

Generated code keeps the application's browser call shape.

```js
const response = await kernel.browsers.playwright.execute(sessionId, {
  code: "return await page.title();",
  timeout_sec: 30,
});
```

Here `kernel` is a compatibility object forwarding calls to native Playwright over local process IPC. It does not load the Kernel SDK or call Kernel. Narrow credential-keyboard and browser-ownership checks still use Chromium's low-level CDP primitives where required.

This public repository is the sole source for the shared core, portable tests, authoring assets and local MCP adapters. Cloud calls the installed library directly. Its hosted MCP frontend stays in the private repository with accounts, permissions and durable jobs.

Cloud owns the REST backend, database, hosted browser and compute providers, recorder, evidence bundles, general privacy service, repair loop, credential storage and its own hosted authoring text.

Integrations run through native Playwright. The local host does not mint HTTP variants, record network traffic, produce `captures/routes.json`, or provide the hosted `SiteHttp` transport and capture replay helpers. Website requests made inside the browser remain available.

Authored operation processes, offline commands and native Playwright page-code workers run with your operating system user's filesystem and network privileges. Guardian review and file checks do not provide an OS sandbox. Clearing the worker's `process.env` hides environment variables from that API; it does not isolate host credentials or prevent access through operating system facilities.

</details>

<details>
<summary>Library and terminal use</summary>

The existing library and terminal interfaces remain available. A library session can mint and run while retaining the same signed-in browser context.

```js
import { Effect } from "effect";
import { createPomerado, makeTerminalAsker } from "pomerado";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* createPomerado({ ask: makeTerminalAsker() });
      const request = {
        url: "https://example.com",
        intent: "Read the main heading",
        input: {},
        effect: "read",
      };
      const result = yield* session.mint(request);
      if (result.artifact === undefined) throw new Error(result.summary);
      console.log(yield* session.run(result.artifact, request));
    }),
  ),
);
```

Use `makeInputAsker` to adapt your own chat callback. Its callback receives an `InputRequest` and returns raw answers keyed by question ID. `makePomeradoMcp` and `makeIntegrationMcp` expose the same local MCP modes as library functions. Their Effect scopes own cleanup.

The package exposes local APIs and direct core library entry points. Importing a core module does not start a browser, MCP listener or workspace.

- Use `pomerado`, `pomerado/runtime` and `pomerado/mcp` for local sessions, the authored browser runtime and local MCP composition.
- Use explicit `pomerado/core/*` subpaths such as `pomerado/core/mint/harness`, `pomerado/core/guardian/review` and `pomerado/core/runtime/host-execute` for hosted library composition. The export map lists supported modules.
- Use `pomerado/testing/*` for reusable test helpers and fixtures. Vitest is an optional peer for helpers that need it.
- Use `getAuthoringDirectory` and `getGuardianPolicyPath` from `pomerado/assets` for installed prompt and policy paths. These paths resolve relative to the package.
- `loadAuthoringSkills` and `loadWorkspaceGuide` from `pomerado/core/mint/skills` render each named authoring section's standalone text by default. A host that supplies its own text for those sections composes the directory first, then loads it in `"hosted"` mode, which refuses any section left uncomposed.

Run `corepack pnpm start --help` for the advanced terminal mint/run interface. Terminal mint retains its original source-artifact format. Use the MCP minting entrypoint for generated MCP packaging.

</details>

## Contributing

```sh
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
corepack pnpm exec playwright install chromium
corepack pnpm test:browser
```

This repository owns the portable tests for its shared core and local runtime, with synthetic fixtures and the existing Vitest and Playwright runners. Browser tests exercise native Playwright, minting through MCP, generated integration MCPs, authentication and autofill using local fixture sites and scripted model responses. They need no Cloud account or model API key. Tests for hosted services stay in the application repository.

Outside pull requests are not accepted yet. They open once the review and approval gate described in [CONTRIBUTING.md](CONTRIBUTING.md) is live. Issues are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes land and how to report a vulnerability privately.

Public tests use synthetic sites and data. Keep customer-specific incidents, private credentials and internal issue references out of public contributions. CI enforces this with a gitleaks secret scan and a public content scan. Run `node tools/check-public-content.ts` before you push. Link a public issue by its full URL.

- Build and test the package before publishing an explicit versioned release. The release workflow validates the packed artifact before npm publication.
- Adopt a tested release in Cloud through an exact dependency pin and locked integrity. Update the controller and sandbox images together.
- Roll Cloud back by restoring its previous package pin and matching image versions. Public commits do not update Cloud automatically.

The clone and build quickstart works independently of npm releases. Contributors can test Cloud against a locally built package before publishing a new version.

---

Copyright (c) 2026 Pomerado AI, Inc. Licensed under the MIT License (`MIT`). See [LICENSE](LICENSE).

Versions 0.1.2 and earlier were published under the GNU Affero General Public License version 3 only (`AGPL-3.0-only`).

Third-party code keeps its own license. The Guardian policy in `typescript/src/guardian/upstream-policy.md` is adapted from [OpenAI Codex](https://github.com/openai/codex) under the Apache License 2.0. Its license and notice are in [third-party/codex/](third-party/codex/) and ship with the npm package.
