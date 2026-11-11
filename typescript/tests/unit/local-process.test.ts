import { Effect, Exit, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { createLocalProcess, type LocalProcess } from "../../src/execution/local-process.js";
import { hostPlatform, type LocalPlatform } from "../../src/execution/local-platform.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ended = async (pid: number) => {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
};
/** Ends a process a test started, if it still runs. */
const reap = (pid: number) => () => {
  if (alive(pid)) process.kill(pid, "SIGKILL");
};

const idle = "setInterval(() => {}, 1000)";
/** Starts an idle Node process that shares this one's output, prints its ID, then runs `then`. */
const parent = (then: string) =>
  [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(idle)}], { stdio: "inherit" });`,
    'process.stdout.write(child.pid + "\\n");',
    then,
  ].join("\n");

const start = async (script: string, platform?: LocalPlatform) => {
  const scope = await Effect.runPromise(Scope.make());
  cleanup.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const local: LocalProcess = await Effect.runPromise(
    createLocalProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      environment: {},
      ...(platform === undefined ? {} : { platform }),
    }).pipe(Scope.extend(scope)),
  );
  const pid = local.child.pid;
  if (pid === undefined) throw new Error("The command did not start");
  cleanup.push(reap(pid));
  return { local, pid };
};

const firstLine = (local: LocalProcess) =>
  new Promise<number>((resolve) => {
    let text = "";
    local.child.stdout?.on("data", (bytes: Buffer) => {
      text += bytes.toString("utf8");
      if (text.includes("\n")) resolve(Number(text.split("\n")[0]));
    });
  });

/** A Windows host as the process layer sees it, recording each system program it runs. */
const windowsPlatform = (taskkill: (pid: number) => number | null) => {
  const runs: (readonly [string, readonly string[]])[] = [];
  const platform: LocalPlatform = {
    windows: true,
    environment: { SystemRoot: "C:\\Windows" },
    run: async (file, args) => {
      runs.push([file, args]);
      return { exitCode: taskkill(Number(args[1])), stdout: "" };
    },
  };
  return { platform, runs };
};

// Runs on every platform: process groups on macOS and Linux, taskkill on Windows.
it("stops a command and every process it started", async () => {
  const { local, pid } = await start(parent(idle));
  const started = await firstLine(local);
  cleanup.push(reap(started));
  expect(alive(started)).toBe(true);

  await Effect.runPromise(local.close);

  expect(await ended(pid)).toBe(true);
  expect(await ended(started)).toBe(true);
});

it.skipIf(process.platform === "win32")(
  "starts each command as the leader of its own process group on macOS and Linux",
  async () => {
    const { pid } = await start(idle, hostPlatform);
    expect(() => process.kill(-pid, 0)).not.toThrow();
  },
);

// Windows has no process groups, so the next tests run the Windows path on any platform with
// taskkill emulated: it ends the command by its ID.
it.skipIf(process.platform === "win32")(
  "on Windows stops a running command with taskkill over its tree and no process group",
  async () => {
    const { platform, runs } = windowsPlatform((pid) => {
      process.kill(pid, "SIGKILL");
      return 0;
    });
    const { local, pid } = await start(idle, platform);
    expect(() => process.kill(-pid, 0)).toThrow();

    await Effect.runPromise(local.close);

    expect(runs).toEqual([["C:\\Windows\\System32\\taskkill.exe", ["/pid", String(pid), "/T", "/F"]]]);
    expect(await Effect.runPromise(local.result)).toMatchObject({ signal: "SIGKILL" });
  },
);

it.skipIf(process.platform === "win32")(
  "on Windows still ends the command when taskkill cannot",
  async () => {
    const { platform, runs } = windowsPlatform(() => 1);
    const { local, pid } = await start(idle, platform);

    await Effect.runPromise(local.close);

    expect(runs).toHaveLength(1);
    expect(await ended(pid)).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "on Windows kills nothing by ID once the command has ended, and its leftover output does not hold the close",
  async () => {
    const { platform, runs } = windowsPlatform(() => 0);
    const { local, pid } = await start(parent("child.unref();"), platform);
    const leftover = await firstLine(local);
    cleanup.push(reap(leftover));
    expect(await ended(pid)).toBe(true);

    await Effect.runPromise(local.close);

    expect(runs).toEqual([]);
    expect(await Effect.runPromise(local.result)).toMatchObject({ exitCode: 0 });
  },
);
