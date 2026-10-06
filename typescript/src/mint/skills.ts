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
    name: "pagination",
    description: "Warm state and fresh reconstruction for scoped read cursors",
    references: ["pagination.ts"],
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
      "Perform an authorized write once, confirm it, then return its integration without running it again",
    references: ["write-session.ts", "write-readback.ts"],
  },
  {
    name: "caller-input",
    description:
      "Ask the run's caller mid-run for what only they know: a choice only the page offers, or a code the site sends",
    references: ["caller-choice.ts", "caller-code.ts"],
  },
] as const;

/**
 * The host-owned workspace guide, relative to the authoring directory. `AGENTS.md` is the
 * always-on context: the host installs it at the workspace root and gives the same text to the
 * minting model as its instructions, so it holds regardless of the agent runtime. The README is
 * read on demand. Each path is installed at the same path under the workspace root, without the
 * `workspace/` prefix.
 */
const workspaceGuideFiles = ["README.md"] as const;

export interface WorkspaceGuide {
  /** The workspace `AGENTS.md`, which is also the minting model's instructions. */
  readonly instructions: string;
  /** Workspace-relative path to content, `AGENTS.md` included. */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * `standalone` renders each named section's own text. `hosted` is for a host that composed the
 * directory with its own text for every section first, so any section left is an error.
 */
export type AuthoringMode = "hosted" | "standalone";

/**
 * A named section is `<!-- pomerado:section ID -->`, or `<!-- pomerado:section ID:start`, its
 * standalone text and `pomerado:section ID:end -->`. A section that ends the file also takes the
 * file's final newline.
 */
const section =
  /<!-- pomerado:section ([a-z0-9.-]+)(?: -->|:start\n([\s\S]*?)\npomerado:section \1:end -->)(?:\n(?=$))?/g;

const authoringText = (text: string, mode: AuthoringMode): string => {
  if (mode === "hosted") {
    if (text.includes("<!-- pomerado:"))
      throw new Error("Hosted authoring has a section the host did not compose");
    return text;
  }
  const rendered = text.replace(
    section,
    (_match: string, _id: string, content?: string) => content ?? "",
  );
  if (rendered.includes("<!-- pomerado:")) throw new Error("Malformed authoring section");
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
  mode: AuthoringMode = "standalone",
): Effect.Effect<WorkspaceGuide, MintFailure> =>
  Effect.gen(function* () {
    const instructions = yield* readGuideFile(directory, "AGENTS.md", mode);
    const files = new Map([["AGENTS.md", instructions]]);
    for (const path of workspaceGuideFiles)
      files.set(path, yield* readGuideFile(directory, path, mode));
    return { instructions, files };
  });

/** Pass the trusted installed authoring directory explicitly; it is not a model-selected path. */
export const loadAuthoringSkills = (
  directory: string,
  mode: AuthoringMode = "standalone",
): Effect.Effect<readonly SkillDescriptor[], MintFailure> =>
  Effect.tryPromise({
    try: async () =>
      Promise.all(
        catalog.map(async (entry): Promise<SkillDescriptor> => {
          const references: Record<string, ReturnType<typeof file>> = {};
          for (const name of entry.references)
            references[name] = file({
              content: await readScopedFile(directory, `examples/${name}`),
            });
          return {
            name: entry.name,
            description: entry.description,
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
