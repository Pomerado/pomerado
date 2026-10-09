import { readFileSync } from "node:fs";

/**
 * Hosts compose the package through its `./core/*` exports and refuse a package whose host
 * protocol (`pomerado.hostProtocol` in package.json, 1 when absent) they don't support. So a
 * release that removes a `./core/*` export must raise that number. This check compares the
 * package with the versions npm publishes under `canary` and `latest`, and fails when one of
 * them has a `./core/*` export this package lacks and an equal or higher host protocol.
 *
 * It runs before the unit tests, in every Check run. A release run (a canary version, or CI on
 * anything but a pull request) fails when npm can't be read. A pull request or a local run warns
 * and goes on, since the release run checks the same tree again before it publishes.
 */

interface Manifest {
  readonly version?: unknown;
  readonly exports?: unknown;
  readonly pomerado?: unknown;
}

const hostProtocol = (manifest: Manifest): number => {
  const declared: unknown =
    typeof manifest.pomerado === "object" && manifest.pomerado !== null
      ? Reflect.get(manifest.pomerado, "hostProtocol")
      : undefined;
  return typeof declared === "number" && Number.isInteger(declared) && declared >= 1 ? declared : 1;
};

const coreExports = (manifest: Manifest) =>
  typeof manifest.exports === "object" && manifest.exports !== null
    ? Object.keys(manifest.exports).filter((key) => key.startsWith("./core/"))
    : [];

/** What `current` breaks for hosts of `previous` without raising its host protocol, if anything. */
export const hostProtocolFindings = (current: Manifest, previous: Manifest): string[] => {
  const kept = new Set(coreExports(current));
  const removed = coreExports(previous).filter((key) => !kept.has(key));
  const before = hostProtocol(previous);
  const now = hostProtocol(current);
  if (now < before)
    return [`hostProtocol ${now} is lower than ${before} in pomerado@${String(previous.version)}`];
  if (removed.length === 0 || now > before) return [];
  return [
    `${removed.join(", ")} ${removed.length === 1 ? "is" : "are"} exported by pomerado@${String(previous.version)} and not here, so raise "pomerado": { "hostProtocol" } in package.json above ${before}`,
  ];
};

const published = async (registry: string, tag: string): Promise<Manifest> => {
  const response = await fetch(`${registry.replace(/\/$/u, "")}/pomerado/${tag}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`npm answered ${response.status} for pomerado@${tag}`);
  const manifest: unknown = await response.json();
  if (typeof manifest !== "object" || manifest === null)
    throw new Error(`npm sent no manifest for pomerado@${tag}`);
  return manifest;
};

if (import.meta.main) {
  const current = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;
  const version = typeof current.version === "string" ? current.version : "";
  const release =
    /-canary\.\d+$/u.test(version) ||
    (process.env["CI"] !== undefined &&
      process.env["GITHUB_EVENT_NAME"] !== undefined &&
      process.env["GITHUB_EVENT_NAME"] !== "pull_request");
  const registry = process.env["npm_config_registry"] ?? "https://registry.npmjs.org";
  try {
    const findings: string[] = [];
    const compared: string[] = [];
    for (const tag of ["canary", "latest"]) {
      const previous = await published(registry, tag);
      compared.push(`pomerado@${String(previous.version)} (${tag})`);
      findings.push(...hostProtocolFindings(current, previous));
    }
    if (findings.length > 0) {
      for (const finding of findings) process.stderr.write(`Host protocol check: ${finding}\n`);
      process.exitCode = 1;
    } else
      process.stdout.write(
        `Host protocol check: hostProtocol ${hostProtocol(current)} keeps every ./core/* export of ${compared.join(" and ")}, or raises the protocol.\n`,
      );
  } catch (error) {
    const message = `Host protocol check could not read the published package from npm: ${String(error)}`;
    if (release) {
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    } else
      process.stdout.write(
        `${process.env["CI"] === undefined ? "" : "::warning::"}${message}. Skipped here; the release run fails on it.\n`,
      );
  }
}
