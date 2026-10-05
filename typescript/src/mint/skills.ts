import { Effect } from "effect";
import { file } from "@openai/agents/sandbox";
import type { SkillDescriptor } from "@openai/agents/sandbox";
import { readScopedFile } from "../filesystem/read.js";
import { MintFailure } from "./contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";

const catalog = [
  {
    name: "core",
    description: "Operation SDK, intake, ownership and execution targets",
    references: [
      "parser.ts",
      "native-page.ts",
      "navigation.ts",
      "selection.ts",
      "native-dialog.ts",
    ],
  },
  {
    name: "auth",
    description: "Discover an evidenced login entry and sign in through the host",
    references: ["auth-entry.ts"],
  },
  {
    name: "testing",
    description: "Meaningful offline/live checks and honest missing evidence",
    references: ["captured-parser.ts"],
  },
  {
    name: "pagination",
    description: "Warm state and fresh reconstruction for scoped read cursors",
    references: ["pagination.ts"],
  },
  {
    name: "recovery",
    description: "Deterministic variants and residual recovery without repeated writes",
    references: ["variants.ts"],
  },
  {
    name: "forms",
    description: "Native/custom selection, resolvers, staged forms and expected terms",
    references: [
      "dates-and-dropdowns.ts",
      "custom-selection.ts",
      "dialog-picker.ts",
      "dates-and-files.ts",
    ],
  },
  {
    name: "writes",
    description:
      "Perform a write once as a live act session, confirm it, then compose and publish its script without running it again",
    references: ["write-session.ts", "write-readback.ts"],
  },
  {
    name: "captcha",
    description:
      "Check Kernel CAPTCHA state on demand; explorations wait and report, operation code reports ChallengeFailure",
    references: [],
  },
  {
    name: "browser-recovery",
    description:
      "When the browser, not your code, is at fault: ask for a new browser with request_browser_recovery, and what a new browser cannot fix",
    references: [],
  },
  {
    name: "caller-input",
    description:
      "Ask the run's caller mid-run for what only they know: a choice only the page offers, or a code the site sends",
    references: ["caller-choice.ts", "caller-code.ts"],
  },
  {
    name: "http-mcp",
    description: "Browser-bound HTTP extraction and coherent public operation design",
    references: ["http-version.ts", "kernel-page-fetch.ts"],
  },
  {
    name: "publication",
    description:
      "Read before the first finish_build: what publication checks, private values never to publish, and how to act on each rejection",
    references: [],
  },
] as const;

/**
 * The host-owned workspace guide, relative to the authoring directory. `AGENTS.md` is the
 * always-on context: the host installs it at the workspace root and gives the same text to the
 * minting model as its instructions, so it holds regardless of the agent runtime. The README and
 * its reference sections are read on demand. Each path is installed at the same path under the
 * workspace root, without the `workspace/` prefix.
 */
const workspaceGuideFiles = [
  "README.md",
  "reference/offline-commands.md",
  "reference/captures.md",
  "reference/fixtures.md",
  "reference/maintenance.md",
] as const;

export interface WorkspaceGuide {
  /** The workspace `AGENTS.md`, which is also the minting model's instructions. */
  readonly instructions: string;
  /** Workspace-relative path to content, `AGENTS.md` included. */
  readonly files: ReadonlyMap<string, string>;
}

export type AuthoringMode = "hosted" | "standalone";

const standaloneSkills = new Set(["core", "auth", "pagination", "forms", "writes", "caller-input"]);

/** These two composition sections keep shared browser instructions and examples identical. */
const authoringText = (text: string, mode: AuthoringMode): string => {
  const rendered = text.replace(
    /<!-- pomerado:(hosted|standalone):start\n([\s\S]*?)\npomerado:\1:end -->(?:\n(?=$))?/g,
    (_match: string, selected: string, content: string) => (selected === mode ? content : ""),
  );
  if (rendered.includes("<!-- pomerado:"))
    throw new Error("Malformed authoring composition section");
  return rendered;
};

const readGuideFile = (directory: string, path: string, mode: AuthoringMode) =>
  Effect.tryPromise({
    try: async () =>
      authoringText(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readScopedFile(directory, `workspace/${path}`),
        ),
        mode,
      ),
    catch: (error) =>
      new MintFailure({
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "readScopedFile",
          phase: "workspace_guide",
          error,
          context: { path },
        }),
        code: "Unavailable",
      }),
  });

/** Pass the trusted installed authoring directory explicitly; it is not a model-selected path. */
export const loadWorkspaceGuide = (
  directory: string,
  mode: AuthoringMode = "hosted",
): Effect.Effect<WorkspaceGuide, MintFailure> =>
  Effect.gen(function* () {
    const instructions = yield* readGuideFile(directory, "AGENTS.md", mode);
    const files = new Map([["AGENTS.md", instructions]]);
    for (const path of mode === "hosted" ? workspaceGuideFiles : ["README.md"])
      files.set(path, yield* readGuideFile(directory, path, mode));
    return { instructions, files };
  });

/** Pass the trusted installed authoring directory explicitly; it is not a model-selected path. */
export const loadAuthoringSkills = (
  directory: string,
  mode: AuthoringMode = "hosted",
): Effect.Effect<readonly SkillDescriptor[], MintFailure> =>
  Effect.tryPromise({
    try: async () =>
      Promise.all(
        catalog
          .filter((entry) => mode === "hosted" || standaloneSkills.has(entry.name))
          .map(async (entry): Promise<SkillDescriptor> => {
            const references: Record<string, ReturnType<typeof file>> = {};
            for (const name of entry.references)
              references[name] = file({
                content: await readScopedFile(directory, `examples/${name}`),
              });
            return {
              name: entry.name,
              description:
                mode === "standalone" && entry.name === "writes"
                  ? "Perform an authorized write once, confirm it, then return its integration without running it again"
                  : entry.description,
              content: new TextEncoder().encode(
                authoringText(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    await readScopedFile(directory, `${entry.name}/SKILL.md`),
                  ),
                  mode,
                ),
              ),
              references,
            };
          }),
      ),
    catch: (error) =>
      new MintFailure({
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "readScopedFile",
          phase: "authoring_skills",
          error,
          context: { skillCount: catalog.length },
        }),
        code: "Unavailable",
      }),
  });

export const loadStandaloneAuthoring = (directory: string) =>
  Effect.gen(function* () {
    const guide = yield* loadWorkspaceGuide(directory, "standalone");
    const skills = yield* loadAuthoringSkills(directory, "standalone");
    return { ...guide, skills };
  });
