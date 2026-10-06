# Getting started

This guide installs Pomerado, connects it to your MCP client and builds a first integration. Every step runs on your computer.

## Prerequisites

- macOS or Linux.
- Node 24.21 or a later Node 24 release. `node --version` should print `v24.21.0` or higher, below `v25`.
- An OpenAI API key for an account that can use `gpt-6-sol` and `gpt-6-luna`. Pomerado calls OpenAI models to build and review integrations. Your agent can run on any model.
- An MCP client that runs local stdio servers.

## Install

```sh
npx -y -p pomerado pomerado-mcp --help
npx -y -p pomerado playwright install chromium
```

- The first command downloads Pomerado into npm's cache and prints the `pomerado-mcp` usage. A cold download can take longer than some clients wait for a server to start, so run it before you connect a client.
- The second command runs the Playwright that Pomerado depends on, so it installs the matching Chromium build. Playwright may print a warning about project dependencies. The browser installs anyway.
- On Linux, run `npx -y -p pomerado playwright install --with-deps chromium` if Chromium's system libraries are missing. It asks for `sudo`.

For a fixed install path, use `npm install -g pomerado`. Then use `pomerado-mcp` in place of `npx -y -p pomerado pomerado-mcp` everywhere below.

## Connect your client

Pomerado is a standard MCP stdio server.

```json
{
  "mcpServers": {
    "pomerado": {
      "command": "npx",
      "args": ["-y", "-p", "pomerado", "pomerado-mcp", "mint", "--root", "/absolute/path/to/pomerado-integrations"]
    }
  }
}
```

- `mint` starts the server that builds integrations.
- `--root` is the folder where Pomerado saves them. It defaults to `./integrations` in the server's working folder, and clients pick that folder differently. Use an absolute path.
- The server needs `OPENAI_API_KEY` in its environment. Many clients pass servers only a short list of variables, so check your client below.
- Starting the server and listing its tools launches no browser and calls no model.

## Client settings

Each entry says how to add Pomerado, how the key reaches the server, and which timeouts apply. "Verified" means we added Pomerado with that client and saw the server connect. "From the docs" means the entry follows the client's own documentation.

Pomerado's tool calls are short. `get_job` waits at most 30 seconds. A call to a generated integration returns within 20 seconds, with the output or a job ID. A tool-call timeout of 60 seconds or more is enough. The startup timeout matters more, because a cold `npx` start downloads the package.

### Claude Code

Verified with Claude Code 2.1.291.

```sh
claude mcp add --scope user pomerado -- npx -y -p pomerado pomerado-mcp mint --root ~/pomerado-integrations
```

- Claude Code passes its own environment to stdio servers. Export `OPENAI_API_KEY` in the shell that starts `claude`.
- In a shared `.mcp.json`, reference the key as `"env": { "OPENAI_API_KEY": "${OPENAI_API_KEY}" }`. Claude Code expands it from its environment.
- Avoid `-e OPENAI_API_KEY=...`, which writes the value into Claude Code's config file.
- `MCP_TIMEOUT` sets the startup wait in milliseconds. It defaults to 30000.
- `claude mcp list` should show `pomerado` as connected.

### Codex

Verified with Codex CLI 0.160.0.

```sh
codex mcp add pomerado -- npx -y -p pomerado pomerado-mcp mint --root ~/pomerado-integrations
```

Then add two lines to the `[mcp_servers.pomerado]` section of `~/.codex/config.toml`.

```toml
[mcp_servers.pomerado]
command = "npx"
args = ["-y", "-p", "pomerado", "pomerado-mcp", "mint", "--root", "/absolute/path/to/pomerado-integrations"]
env_vars = ["OPENAI_API_KEY"]
startup_timeout_sec = 60
```

- Codex passes servers only a short list of variables, such as `PATH` and `HOME`. `env_vars` forwards `OPENAI_API_KEY` from Codex's environment by name.
- `codex mcp add` has no flag for `env_vars`. Its `--env` flag writes the value into the file, so avoid it.
- `startup_timeout_sec` defaults to 10 seconds. A cold `npx` start can take longer.
- `tool_timeout_sec` defaults to 60 seconds, which is enough.

### Gemini CLI

Verified with Gemini CLI 0.62.0.

```sh
gemini mcp add -s user -e 'OPENAI_API_KEY=$OPENAI_API_KEY' pomerado npx -y -p pomerado pomerado-mcp mint --root ~/pomerado-integrations
```

- Gemini CLI removes variables whose names contain `KEY`, `TOKEN`, `SECRET` and similar words from server environments.
- The single quotes keep `$OPENAI_API_KEY` as a reference in `~/.gemini/settings.json`. Gemini CLI fills it in from its own environment when it starts the server.
- Gemini CLI starts servers only in folders you have trusted.
- The `timeout` setting defaults to 600000 milliseconds.
- `gemini mcp list` should show `pomerado` as connected.

### Cursor

From the docs.

- Add the entry to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project.
- Add `"env": { "OPENAI_API_KEY": "${env:OPENAI_API_KEY}" }` to the entry. Cursor resolves `${env:NAME}` from its own environment.
- Cursor's docs name no timeout setting.

### VS Code

From the docs.

- Add the entry to `.mcp.json` in your workspace or to `~/.copilot/mcp-config.json`. Both use `mcpServers`.
- `code --add-mcp` adds a server to your user profile. It takes one JSON object with `name`, `command` and `args`.
- VS Code's docs say to keep API keys out of these files.
- VS Code's own `mcp.json` format, which uses `servers` in place of `mcpServers`, can ask for the key once and store it. Declare an input with `"password": true`, then reference it in the server's `env` as `"OPENAI_API_KEY": "${input:openai-key}"`.

  ```json
  {
    "inputs": [
      { "type": "promptString", "id": "openai-key", "description": "OpenAI API key", "password": true }
    ]
  }
  ```

- VS Code's docs name no timeout setting.

### Claude Desktop

From the docs.

- Add the entry to `claude_desktop_config.json`. On macOS it is in `~/Library/Application Support/Claude/`.
- Claude Desktop passes servers a limited set of variables and documents no way to reference one. A key in the entry's `env` block is stored as plain text in that file.
- Claude Desktop documents no timeout setting.

## Check the connection

- Your client's list command, or its MCP panel, should show `pomerado` as connected.
- Ask your agent which Pomerado tools it has. It should list `mint`, `get_job`, `provide_input` and `cancel_job`.

## Build your first integration

Ask your agent for a read-only integration.

> Use Pomerado to create an integration named example_reader that reads the main heading from https://example.com. Keep it read-only.

Your agent calls `mint` with arguments like these.

```json
{ "name": "example_reader", "url": "https://example.com", "intent": "Read the main heading", "effect": "read", "input": {} }
```

`mint` returns at once with a job ID and the next call to make.

```json
{ "job_id": "…", "status": "running", "next": { "tool": "get_job", "arguments": { "job_id": "…" } } }
```

Your agent then calls `get_job`. Each call waits up to 30 seconds and returns the same shape while the job runs. A finished job looks like this.

```json
{
  "job_id": "…",
  "status": "completed",
  "output": {
    "build": "published",
    "integration": {
      "directory": "/absolute/path/to/pomerado-integrations/example_reader",
      "configPath": "/absolute/path/to/pomerado-integrations/example_reader/mcp.json",
      "launcherPath": "/absolute/path/to/pomerado-integrations/example_reader/mcp.mjs"
    }
  }
}
```

- `"build": "published"` means Pomerado ran the task, Guardian approved the source, and the integration is saved.
- `"build": "incomplete"` comes with a `summary` and saves nothing. The folder is removed, so you can retry with the same name.
- A `"status": "failed"` job carries an `error`. See [Troubleshooting](#troubleshooting).

To use the integration, follow the steps in the README's [Use your integration](../README.md#use-your-integration).

1. Open `example_reader/README.md` and run the add command for your client.
2. Give the new server `OPENAI_API_KEY` the same way as Pomerado.
3. Reload your client and ask your agent to use `example_reader`.

The call returns JSON that matches the output schema in `example_reader/pomerado.json`.

## Answer questions and sign in

When a job needs something from you, `get_job` returns `"status": "input_required"`.

```json
{
  "job_id": "…",
  "status": "input_required",
  "pending_input": {
    "id": "…",
    "source": "agent",
    "questions": [{ "id": "note", "type": "text", "prompt": "Which note should go with this entry?" }],
    "expires_at": "…"
  },
  "next": { "tool": "provide_input", "arguments": { "job_id": "…", "request_id": "…" } }
}
```

- Your agent asks you and sends your answers through `provide_input`, keyed by question ID.
- Questions can be a choice, several choices, text, a confirmation, a secret or a login.
- A question expires after 10 minutes. After that, `provide_input` refuses answers to it.
- For a login, Pomerado finds the sign-in form, asks for the username and password, and types them into the page.
- For a one-time code, Pomerado asks you for the code. It reads no SMS or authenticator app for you.
- Answers, passwords included, pass through your MCP client and its model provider. Pomerado saves none of them.

## Server options

- Add `--headed` to the `mint` arguments to watch Chromium work.
- Add `--endpoint` and a native Playwright WebSocket URL to attach to a browser server you run. The server must support `chromium.connect()` at the same Playwright version. A Chromium remote debugging URL for `connectOverCDP()` won't work.
- To test an attached browser, start a local Playwright browser server from a clone of this repository. Use the endpoint it prints.

```sh
node --input-type=module -e 'import { chromium } from "playwright"; const server = await chromium.launchServer({ headless: true }); console.log(server.wsEndpoint());'
```

Pomerado owns its browser context on an attached server. Closing a job closes that context and leaves the server and other clients' contexts alone.

## Troubleshooting

- A mint finishes within seconds with `"build": "incomplete"` and the summary "Minting stopped before publication". This is what happens when the server has no `OPENAI_API_KEY`. Check [Client settings](#client-settings) for your client.
- An error says "Model provider authentication failed". OpenAI rejected the key the server sent. Check that the key is current.
- A mint ends with a summary saying the account's model quota is spent. Add credit or raise the limit on your OpenAI account, then mint again.
- A job fails with "Model provider quota or rate limit was reached". Your OpenAI account hit a rate limit or quota. Wait, or check its limits, then try again.
- A job fails at once with "Operation failed. Check the local model, browser and integration configuration." This is what happens when Chromium is missing. Run `npx -y -p pomerado playwright install chromium`.
- The client reports a closed connection or a startup timeout. Check `node --version`, run `npx -y -p pomerado pomerado-mcp --help` once to fill npm's cache, and raise the client's startup timeout.
- `pomerado-mcp` exits at once with no output. Versions 0.1.2 and earlier don't start through `npx` or a global install. Use `pomerado@latest` in the `-p` argument.
- A call fails with "The server is busy". The server runs one job at a time. Wait for the job or cancel it with `cancel_job`.
- A call fails with "Unknown or expired job". The server restarted, or the job ended more than 15 minutes ago. Restarting loses running jobs but keeps saved integrations.
- A tool call times out in your client. Pomerado's calls return within about 30 seconds, so raise the client's tool-call timeout to 60 seconds or more.
