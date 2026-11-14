import { rmSync } from "node:fs";

// `rm -rf` is not a command on Windows, where package scripts run in cmd.exe.
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
