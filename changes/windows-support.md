---
section: Other changes
---

- Pomerado runs on Windows: in WSL2, and natively on Windows 11. Natively, tool runs and offline commands start with no console window and stop by ending their process tree, runs stage without symbolic links, so they need no administrator rights or Developer Mode, and offline commands while minting run in the `sh.exe` Git for Windows installs. An integration built inside WSL also gets `mcp.windows.json`, a server entry that starts it through `wsl.exe` for clients on the Windows side. A built integration's README quotes its add commands for PowerShell on Windows, and failure details trim Windows paths from stack frames as they trim POSIX ones. [Windows](docs/windows.md) has the setup.
  - A checkout of this repository uses LF line endings on every platform, and the build cleans `dist` with Node, so it builds on Windows too.
