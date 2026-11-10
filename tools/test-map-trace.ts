/**
 * Preloaded into every Node process of a test map run (`NODE_OPTIONS=--import`), it records each
 * file the process loads as a module or reads, stats or lists through `node:fs`. tools/test-map.ts
 * runs one test file at a time with this preload, so everything a process records belongs to that
 * test file, whichever process recorded it: the test runner, its workers, or a CLI a test spawns.
 *
 * It does nothing unless TEST_MAP_OUT names the folder to write to. Each process appends one path
 * per line, the first time it sees the path, to its own file there, so a process that is killed
 * still leaves what it recorded. Only paths under TEST_MAP_ROOT are kept. A child process or worker
 * thread started with an environment or options of its own, such as only PATH, still gets this
 * preload and its settings, so a built CLI a test spawns that way is recorded too. Reads by
 * processes that aren't Node, such as git, a shell or the browser, are not recorded.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import workerThreads, { threadId, type WorkerOptions } from "node:worker_threads";

const out = process.env["TEST_MAP_OUT"];
const root = process.env["TEST_MAP_ROOT"];

if (out !== undefined && out !== "" && root !== undefined && root !== "") {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const preload = `--import ${import.meta.url}`;
  const writeSync = fs.writeSync.bind(fs);
  const readlink = fs.readlinkSync.bind(fs);
  const handle = fs.openSync(
    join(out, `${process.pid}-${threadId}-${Math.random().toString(36).slice(2)}.txt`),
    "a",
  );
  const seen = new Set<string>();

  /**
   * Records a path, a `file:` URL or a Buffer path. A folder listing ends in `/`, and a listing of
   * a whole tree in `/**`. Recording never throws, so a traced call fails only as it would untraced.
   */
  const record = (target: unknown, kind: "file" | "dir" | "tree" = "file"): void => {
    try {
      let path: string;
      if (typeof target === "string") path = target;
      else if (target instanceof URL) {
        if (target.protocol !== "file:") return;
        path = fileURLToPath(target);
      } else if (Buffer.isBuffer(target)) path = target.toString();
      else return;
      // resolve() also normalizes an absolute path and drops a trailing slash.
      let absolute = resolve(path);
      // A path below an open folder's descriptor, as scoped reads open files on Linux.
      const below = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/u.exec(absolute);
      if (below !== null)
        absolute = resolve(readlink(`/proc/self/fd/${below[1] ?? ""}`) + (below[2] ?? ""));
      // A listing of the root itself is recorded only as the whole tree, `**`.
      if (`${absolute}/` === prefix && kind === "tree") absolute = `${absolute}/**`;
      else if (!absolute.startsWith(prefix)) return;
      const suffix =
        kind === "dir" ? "/" : kind === "tree" && !absolute.endsWith("/**") ? "/**" : "";
      const relative = absolute.slice(prefix.length) + suffix;
      if (relative.startsWith("node_modules/") || relative.includes("/node_modules/")) return;
      if (seen.has(relative)) return;
      seen.add(relative);
      writeSync(handle, `${relative}\n`);
    } catch {
      // A path this can't resolve is one the call itself rejects or can't find.
    }
  };

  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) record(new URL(url));
      return nextLoad(url, context);
    },
  });

  type Target = Record<string | symbol, unknown>;
  type Callable = (this: unknown, ...args: unknown[]) => unknown;
  /** Replaces `target[name]` with `wrapped`, keeping the original's own properties. */
  const replace = (target: Target, name: string, original: Callable, wrapped: Callable) => {
    const properties = Object.getOwnPropertyDescriptors(original) as Record<
      string | symbol,
      PropertyDescriptor
    >;
    // Node's own promisified form calls the original directly, so a wrapper sets its own.
    for (const key of ["length", "name", "prototype", promisify.custom]) delete properties[key];
    Object.defineProperties(wrapped, properties);
    target[name] = wrapped;
  };
  const isRecursive = (options: unknown) =>
    typeof options === "object" && options !== null && Reflect.get(options, "recursive") === true;
  const statSync = fs.statSync.bind(fs);
  const readdirSync = fs.readdirSync.bind(fs);
  /** Records every file below a copied folder, which Node's copy reads out of sight. */
  const recordCopy = (source: unknown): void => {
    try {
      const path =
        source instanceof URL ? fileURLToPath(source) : typeof source === "string" ? source : "";
      if (path === "" || !resolve(path).startsWith(prefix) || !statSync(path).isDirectory()) return;
      for (const entry of readdirSync(path, { recursive: true, encoding: "utf8" }))
        record(join(path, entry));
    } catch {
      // The copy itself reports a source it can't read.
    }
  };
  const wrap = (target: Target, names: readonly string[], kind: "file" | "dir"): void => {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== "function") continue;
      replace(target, name, original as Callable, function (this: unknown, ...args: unknown[]) {
        record(args[0], kind === "dir" && isRecursive(args[1]) ? "tree" : kind);
        if (name === "cp" || name === "cpSync") recordCopy(args[0]);
        return Reflect.apply(original as Callable, this, args);
      });
    }
  };

  const fileReads = [
    "readFileSync",
    "readFile",
    "openSync",
    "open",
    "createReadStream",
    "statSync",
    "stat",
    "lstatSync",
    "lstat",
    "existsSync",
    "accessSync",
    "access",
    "realpathSync",
    "copyFileSync",
    "copyFile",
    "cpSync",
    "cp",
  ];
  const folderReads = ["readdirSync", "readdir", "opendirSync", "opendir"];
  const callbackFs = fs as unknown as Target;
  const promiseFs = fs.promises as unknown as Target;
  wrap(callbackFs, fileReads, "file");
  wrap(callbackFs, folderReads, "dir");
  wrap(promiseFs, fileReads, "file");
  wrap(promiseFs, folderReads, "dir");

  /** An environment a caller chose, with this preload and its settings added; its own win. */
  const traced = (env: Record<string, string | undefined>) => {
    const own = env["NODE_OPTIONS"];
    const nodeOptions =
      own === undefined || own === "" ? preload : own.includes(preload) ? own : `${own} ${preload}`;
    return { TEST_MAP_OUT: out, TEST_MAP_ROOT: root, ...env, NODE_OPTIONS: nodeOptions };
  };
  /** Adds the preload to the options argument of a child process call that sets `env`. */
  const withTracing = (args: unknown[]): unknown[] => {
    const index = args.findLastIndex(
      (arg) => typeof arg === "object" && arg !== null && !Array.isArray(arg),
    );
    const options = index === -1 ? undefined : (args[index] as { env?: unknown });
    if (options === undefined || typeof options.env !== "object" || options.env === null)
      return args;
    const copy = [...args];
    copy[index] = { ...options, env: traced(options.env as Record<string, string | undefined>) };
    return copy;
  };
  const childProcesses = childProcess as unknown as Target;
  for (const name of [
    "spawn",
    "spawnSync",
    "fork",
    "execFile",
    "execFileSync",
    "exec",
    "execSync",
  ]) {
    const original = childProcesses[name];
    if (typeof original !== "function") continue;
    replace(childProcesses, name, original as Callable, function (this: unknown, ...args) {
      return Reflect.apply(original as Callable, this, withTracing(args));
    });
    // exec and execFile promisify to { stdout, stderr } through their own custom form.
    const custom = Reflect.get(original, promisify.custom) as Callable | undefined;
    if (typeof custom === "function")
      Object.defineProperty(childProcesses[name], promisify.custom, {
        value: function (this: unknown, ...args: unknown[]) {
          return Reflect.apply(custom, this, withTracing(args));
        },
      });
  }

  // A worker thread given its own execArgv or environment still loads this preload.
  const OriginalWorker = workerThreads.Worker;
  class TracedWorker extends OriginalWorker {
    constructor(filename: string | URL, options?: WorkerOptions) {
      const execArgv = options?.execArgv;
      const env: unknown = options?.env;
      super(filename, {
        ...options,
        ...(execArgv === undefined ? {} : { execArgv: [...execArgv, ...preload.split(" ")] }),
        ...(typeof env === "object" && env !== null && env !== (workerThreads.SHARE_ENV as unknown)
          ? { env: { TEST_MAP_OUT: out, TEST_MAP_ROOT: root, ...(env as object) } }
          : {}),
      });
    }
  }
  (workerThreads as unknown as Target)["Worker"] = TracedWorker;
  syncBuiltinESMExports();
}
