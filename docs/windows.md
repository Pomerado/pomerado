# Windows

Pomerado runs on Windows in two ways.

- **WSL2**, recommended. Pomerado runs inside a Linux distribution exactly as it does on Linux, and clients on either side can start it.
- **Native**, on Windows 11. Pomerado runs under Node for Windows. Building integrations also needs Git for Windows.

[Getting started](getting-started.md) covers everything else, such as the model key, the client settings and your first integration.

## WSL2

1. Install WSL2 and a distribution, such as Ubuntu, from PowerShell with `wsl --install`.
2. Inside the distribution, install Node 24.21 or a later Node 24 release.
3. Follow [Getting started](getting-started.md) inside the distribution, as on Linux. Install Chromium with its system libraries:

   ```sh
   npx -y -p pomerado playwright install --with-deps chromium
   ```

4. Keep the integrations folder on the Linux file system, such as `~/pomerado-integrations`. Folders under `/mnt/c` work, but they are much slower.

### Clients inside WSL

Claude Code, Codex or Gemini CLI running inside the distribution, and VS Code connected to it with the WSL extension, start Pomerado as on Linux. Use the commands in [Client settings](getting-started.md#client-settings).

### Clients on the Windows side

Claude Desktop, Cursor, VS Code and other clients that run on Windows start the server through `wsl.exe`, which runs the command with no shell. Replace `Ubuntu` with your distribution's name, which `wsl.exe --list` shows, and `/home/you` with your home folder in it.

```json
{
  "mcpServers": {
    "pomerado": {
      "command": "wsl.exe",
      "args": ["--distribution", "Ubuntu", "--exec", "env", "PATH=/home/you/.nvm/versions/node/v24.22.1/bin:/usr/local/bin:/usr/bin:/bin", "npx", "-y", "-p", "pomerado", "pomerado-mcp", "mint", "--root", "/home/you/pomerado-integrations"]
    }
  }
}
```

- `PATH` starts with the folder that holds your Node. Inside the distribution, `dirname "$(command -v node)"` prints it. A per-user install, such as one made with nvm, is found only this way, since neither `wsl.exe` nor a login shell loads nvm. With Node installed for the whole system in `/usr/bin`, leave out `env` and the `PATH` argument.
- With no shell, nothing expands `~`, so name the integrations folder in full.
- `wsl.exe` passes the server only the Windows variables that `WSLENV` names. To pass the key, add `"env": { "WSLENV": "OPENAI_API_KEY/u" }` to the entry and make `OPENAI_API_KEY` available to the client as the client's settings describe. Keep the key out of shared files.
- The first start after the distribution was stopped takes a few extra seconds. Raise the client's startup timeout if it gives up.

An integration you build inside WSL also gets `mcp.windows.json` beside its `mcp.json`. It holds the same server entry, started through `wsl.exe`, for clients on the Windows side. The server writes it when its environment names the distribution in `WSL_DISTRO_NAME`, as WSL sets for every process it starts, and the name holds only letters, digits, dots, dashes and underscores. Some clients start servers with a reduced environment, as Codex does. If the file is missing, write the entry yourself from `mcp.json`: the command is `wsl.exe`, and the arguments are `--distribution`, your distribution's name, `--exec`, then the command and arguments from `mcp.json`.

### Files and the browser

- A download comes back as a `file:` URL inside the distribution, such as `file:///tmp/...`. Windows apps reach it at `\\wsl.localhost\Ubuntu\tmp\...`.
- On Windows 11, WSL shows the browser window when you start the server with `--headed`.

## Native Windows

Prerequisites, beside those in [Getting started](getting-started.md#prerequisites):

- Windows 11, or Windows Server 2019 or later, as Playwright requires.
- Node 24.21 or a later Node 24 release for Windows.
- To build integrations, [Git for Windows](https://git-scm.com/download/win). The minter's offline commands run in the POSIX shell it installs, `bin\sh.exe`, which also brings the usual Unix tools. Pomerado looks for it in Git's default install folder, then beside each `git.exe` on your PATH, then in the folder of a per-user install. It runs no program to find it. Running an integration you already built needs neither Git nor a shell.
- Recommended for building integrations: [ripgrep](https://github.com/BurntSushi/ripgrep), which the minter's instructions mention. Install it with `winget install BurntSushi.ripgrep.MSVC`. Without it, a command that calls `rg` fails, and the minter still has `grep` from Git.

Install Pomerado and Chromium in PowerShell, with the commands in [Getting started](getting-started.md#install).

### Connect your client

- `npx` is a `npx.cmd` script on Windows, and some clients can't start a `.cmd` file without a shell. If yours reports `spawn npx ENOENT` or `EINVAL`, start it through `cmd`:

  ```json
  {
    "mcpServers": {
      "pomerado": {
        "command": "cmd",
        "args": ["/c", "npx", "-y", "-p", "pomerado", "pomerado-mcp", "mint", "--root", "C:\\Users\\you\\pomerado-integrations"]
      }
    }
  }
  ```

- Claude Desktop reads `%APPDATA%\Claude\claude_desktop_config.json` and writes its logs to `%APPDATA%\Claude\logs`.
- cmd.exe never expands `~`, and Windows PowerShell 5.1 doesn't expand it in a native command's arguments. Write the integrations folder out in full, such as `"$HOME\pomerado-integrations"` in PowerShell.
- For a file that holds the key, keep it under your user folder, which only your account can read by default, in place of `chmod 600`.

A built integration's `mcp.json` names your Node and the integration's launcher by absolute path, so every client starts it as is. Its README's add commands are quoted for PowerShell.

### How it differs from macOS and Linux

- Windows has no process groups. Each tool run or offline command starts with no console window, and stopping it ends its whole process tree with `taskkill /T /F`. A process a command started and left running after the command itself ended is not stopped.
- A tool run stages its files with junctions and small modules that re-export the installed SDK, where macOS and Linux use symbolic links, which Windows creates only with administrator rights or Developer Mode.

## Build from source on Windows

Clone with Git for Windows. The repository's `.gitattributes` checks text out with LF line endings, which the authoring files need, whatever `core.autocrlf` says. Run the commands in [CONTRIBUTING.md](../CONTRIBUTING.md) in PowerShell, and the CI scans, such as `bash tools/ci-scan.sh content`, in Git Bash.
