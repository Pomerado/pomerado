import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { describe, expect, it } from "vitest";

// Evaluates every job's runs-on in .github/workflows with GitHub's own expression library, for
// pull requests from forks, outside authors and maintainers, and for pushes. A fork's pull request
// can edit its own copy of a workflow, so this checks the routes this repository's copy picks, not
// a security boundary; check.yml's header says what the boundary is. Each case evaluates every job
// of every workflow, including workflows the event doesn't start, so a route holds wherever it is.

const workflows = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const repository = "Pomerado/pomerado";
const githubHosted = "ubuntu-latest";
const fallback = "blacksmith-4vcpu-ubuntu-2404";
const variables = {
  CI_RUNNER_MAINTAINER: "maintainer-runner",
  CI_RUNNER_TRUSTED: "trusted-runner",
  CI_MAINTAINERS: '["listed-maintainer", "other-maintainer"]',
};
const associations = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "NONE",
] as const;

interface Job {
  readonly workflow: string;
  readonly job: string;
  /** The runs-on value, with any folded lines joined. */
  readonly runsOn: string;
  readonly usesEnvironment: boolean;
}

/** Each job's runs-on and whether it names an environment, read line by line. */
function jobsOf(workflow: string, text: string): Job[] {
  const jobs: Job[] = [];
  const lines = text.split("\n");
  let inJobs = false;
  let current: { job: string; runsOn?: string; usesEnvironment: boolean } | undefined;
  const flush = () => {
    if (current?.runsOn !== undefined)
      jobs.push({ workflow, job: current.job, runsOn: current.runsOn, usesEnvironment: current.usesEnvironment });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^\S/.test(line)) {
      flush();
      current = undefined;
      inJobs = line.startsWith("jobs:");
      continue;
    }
    if (!inJobs) continue;
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      flush();
      current = { job: job[1] ?? "", usesEnvironment: false };
      continue;
    }
    if (current === undefined) continue;
    if (/^ {4}environment:/.test(line)) current.usesEnvironment = true;
    const runsOn = /^ {4}runs-on:\s*(.*)$/.exec(line);
    if (!runsOn) continue;
    const value = (runsOn[1] ?? "").trim();
    if (value !== ">-" && value !== ">") {
      current.runsOn = value;
      continue;
    }
    const folded: string[] = [];
    while (/^ {6,}\S/.test(lines[index + 1] ?? "")) folded.push((lines[++index] ?? "").trim());
    current.runsOn = folded.join(" ");
  }
  flush();
  return jobs;
}

const allJobs = readdirSync(workflows)
  .filter((name) => name.endsWith(".yml"))
  .flatMap((name) => jobsOf(name, readFileSync(join(workflows, name), "utf8")));

/** Converts plain JSON into the library's data, through JSON.parse with its reviver. */
const toData = (value: unknown) => JSON.parse(JSON.stringify(value), data.reviver) as data.Dictionary;

/** The runner a runs-on value picks for the given contexts. */
function runnerFor(runsOn: string, contexts: { github: unknown; vars: unknown }): string {
  const expression = /^\$\{\{([\s\S]*)\}\}$/.exec(runsOn);
  if (!expression) return runsOn;
  const lexed = new Lexer(expression[1] ?? "").lex();
  const parsed = new Parser(lexed.tokens, ["github", "vars"], []).parse();
  return new Evaluator(parsed, toData(contexts)).evaluate().coerceString();
}

interface Run {
  readonly repository?: string;
  readonly event: string;
  readonly ref?: string;
  readonly headRepository?: string;
  readonly association?: string;
  readonly login?: string;
  /** The account whose push started the run; the author by default. */
  readonly actor?: string;
  /** The account that started this attempt, such as a re-run; the actor by default. */
  readonly triggeringActor?: string;
  readonly vars?: Readonly<Record<string, string>>;
}

const contextsOf = (run: Run) => ({
  github: {
    repository: run.repository ?? repository,
    event_name: run.event,
    ref: run.ref ?? "refs/heads/main",
    actor: run.actor ?? run.login ?? "someone",
    triggering_actor: run.triggeringActor ?? run.actor ?? run.login ?? "someone",
    event:
      run.event === "pull_request"
        ? {
            pull_request: {
              head: { repo: { full_name: run.headRepository ?? repository } },
              author_association: run.association ?? "NONE",
              user: { login: run.login ?? "someone" },
            },
          }
        : {},
  },
  vars: run.vars ?? variables,
});

/** Every distinct runner the run's jobs pick, across every workflow. */
const runnersFor = (run: Run, jobs: readonly Job[] = allJobs) =>
  new Set(jobs.map((job) => runnerFor(job.runsOn, contextsOf(run))));

const routed = allJobs.filter((job) => job.runsOn.includes("${{"));

describe("CI runner routing", () => {
  it("finds the routed check and browser jobs", () => {
    expect(routed.map((job) => `${job.workflow}:${job.job}`).toSorted()).toEqual([
      "check.yml:browser",
      "check.yml:check",
    ]);
  });

  it("runs every job of a fork's pull request on a GitHub-hosted runner, whoever opened it", () => {
    for (const association of associations) {
      for (const vars of [variables, {}]) {
        expect(
          runnersFor({ event: "pull_request", headRepository: "someone/pomerado", association, vars }),
        ).toEqual(new Set([githubHosted]));
      }
    }
  });

  it("runs a pull request from a branch here by anyone CI_MAINTAINERS doesn't list on a GitHub-hosted runner", () => {
    // An owner or member who isn't listed included: a self-hosted maintainer runner admits only
    // the accounts its own configuration lists.
    for (const association of associations) {
      expect(runnersFor({ event: "pull_request", association })).toEqual(new Set([githubHosted]));
    }
  });

  it("runs a listed maintainer's pull request on a GitHub-hosted runner when an unlisted account pushed or re-ran it", () => {
    for (const run of [
      { actor: "someone" },
      { triggeringActor: "someone" },
      { actor: "someone", triggeringActor: "listed-maintainer" },
    ]) {
      expect(
        runnersFor({ event: "pull_request", association: "OWNER", login: "listed-maintainer", ...run }),
      ).toEqual(new Set([githubHosted]));
    }
  });

  it("runs every job of a listed maintainer's pull request from a fork on a GitHub-hosted runner", () => {
    for (const association of associations) {
      expect(
        runnersFor({ event: "pull_request", headRepository: "listed-maintainer/pomerado", association, login: "listed-maintainer" }),
      ).toEqual(new Set([githubHosted]));
    }
  });

  it("runs a pull request from a branch here by a login CI_MAINTAINERS lists on the maintainer runner", () => {
    const { CI_MAINTAINERS: _, ...unlisted } = variables;
    const { CI_RUNNER_MAINTAINER: __, ...noRunner } = variables;
    for (const association of associations) {
      for (const job of routed) {
        const run = { event: "pull_request", association, login: "listed-maintainer" };
        expect(runnerFor(job.runsOn, contextsOf(run))).toBe("maintainer-runner");
        // A push or re-run by another listed maintainer keeps the route.
        for (const others of [{ actor: "other-maintainer" }, { triggeringActor: "other-maintainer" }]) {
          expect(runnerFor(job.runsOn, contextsOf({ ...run, ...others }))).toBe("maintainer-runner");
        }
        expect(runnerFor(job.runsOn, contextsOf({ ...run, vars: unlisted }))).toBe(githubHosted);
        expect(runnerFor(job.runsOn, contextsOf({ ...run, vars: noRunner }))).toBe(fallback);
      }
    }
  });

  it("runs a push to main's browser jobs on the trusted runner", () => {
    const browser = routed.filter((job) => job.job === "browser");
    expect(browser).toHaveLength(1);
    for (const job of browser) {
      expect(runnerFor(job.runsOn, contextsOf({ event: "push" }))).toBe("trusted-runner");
      expect(runnerFor(job.runsOn, contextsOf({ event: "push", vars: {} }))).toBe(fallback);
      // The maintainer runner never takes a trusted run.
      expect(runnerFor(job.runsOn, contextsOf({ event: "push", vars: { CI_RUNNER_MAINTAINER: "x" } }))).toBe(
        fallback,
      );
    }
  });

  it("builds the tarball a push to main publishes on a GitHub-hosted runner", () => {
    // check.yml's check job packs the tarball the release workflow publishes.
    const builder = routed.filter((job) => job.workflow === "check.yml" && job.job === "check");
    expect(builder).toHaveLength(1);
    for (const vars of [variables, {}]) {
      expect(runnersFor({ event: "push", vars }, builder)).toEqual(new Set([githubHosted]));
    }
  });

  it("runs a push to another branch, a merge queue run and any run of another repository on a GitHub-hosted runner", () => {
    expect(runnersFor({ event: "push", ref: "refs/heads/feature" })).toEqual(new Set([githubHosted]));
    // A merge queue has no route of its own yet, so it gets no self-hosted runner.
    expect(runnersFor({ event: "merge_group" })).toEqual(new Set([githubHosted]));
    for (const event of ["push", "merge_group", "pull_request"]) {
      expect(
        runnersFor({ repository: "someone/pomerado", event, headRepository: "someone/pomerado", association: "OWNER" }),
      ).toEqual(new Set([githubHosted]));
    }
  });

  it("runs every job that names an environment, and so holds its secrets, on a GitHub-hosted runner", () => {
    const withSecrets = allJobs.filter((job) => job.usesEnvironment);
    expect(withSecrets.length).toBeGreaterThan(0);
    for (const run of [
      { event: "push" },
      { event: "workflow_dispatch" },
      { event: "pull_request", association: "OWNER" },
    ]) {
      expect(runnersFor(run, withSecrets)).toEqual(new Set([githubHosted]));
    }
  });

  it("never routes on text a pull request controls", () => {
    // A pull request's author names its branch, title, labels and body, and so could set each to a
    // runner label. Neither a fork nor a non-maintainer here can steer the route with them.
    const steering = "maintainer-runner";
    for (const [headRepository, association] of [
      ...associations.map((name) => ["someone/pomerado", name] as const),
      ...associations.map((name) => [repository, name] as const),
    ]) {
      const run = { event: "pull_request", headRepository, association };
      const contexts = contextsOf(run);
      const event = contexts.github.event as { pull_request: Record<string, unknown> };
      Object.assign(event.pull_request, {
        title: steering,
        body: steering,
        labels: [{ name: steering }, { name: "trusted-runner" }],
        head: { ...(event.pull_request["head"] as object), ref: steering, label: steering },
      });
      const github = { ...contexts.github, head_ref: steering, base_ref: "main" };
      for (const job of routed) {
        expect(runnerFor(job.runsOn, { github, vars: contexts.vars })).toBe(githubHosted);
      }
    }
  });
});
