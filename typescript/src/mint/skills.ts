import { Effect } from "effect";
import { file } from "@openai/agents/sandbox";
import type { SkillDescriptor } from "@openai/agents/sandbox";
import { readScopedFile } from "../filesystem/read.js";
import { MintFailure } from "./contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { hostedFeaturesPreamble } from "../hosted-features.js";

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
    name: "search",
    description:
      "Read before settling a search or listing tool's inputs: the site's own filters, sort and location, applied and read back, and honest empty results",
    references: [],
  },
  {
    name: "auth",
    description: "Discover an evidenced login entry and sign in through the host",
    references: ["auth-entry.ts"],
  },
  {
    name: "testing",
    description: "Meaningful offline/live checks and honest missing evidence",
    references: [],
  },
  {
    name: "pagination",
    description:
      "Read before settling the schema of any tool that returns a list: page size, the cursor, numbered pages, next links, load more, infinite scroll, the site's own list API, changed lists and when to stop",
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
    name: "cart",
    description:
      "Read before building any tool that reads, adds to, changes or checks out a cart: sign in first, read the cart before and after, quantity, account values and site limits",
    references: [],
  },
  {
    name: "caller-input",
    description:
      "Ask the run's caller mid-run for what only they know: a choice only the page offers, or a code the site sends",
    references: ["caller-choice.ts", "caller-code.ts"],
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
 * minting model as its instructions, so it holds regardless of the agent runtime. The README is
 * read on demand. Each path is installed at the same path under the workspace root, without the
 * `workspace/` prefix.
 */
const workspaceGuideFiles = [{ path: "README.md", sectionKey: "guide" }] as const;

export interface WorkspaceGuide {
  /** The workspace `AGENTS.md`, which is also the minting model's instructions. */
  readonly instructions: string;
  /** Workspace-relative path to content, `AGENTS.md` included. */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * Turns one authoring file's text into what the minter reads. `sectionKey` is the file's key, such
 * as `core` for `core/SKILL.md`. The default renders each named section's standalone text. A host
 * that composed the directory with its own text supplies a render that checks that text instead.
 */
export type AuthoringRender = (text: string, sectionKey: string) => string;

/**
 * A named section is `<!-- pomerado:section ID -->`, or `<!-- pomerado:section ID:start`, its
 * standalone text and `pomerado:section ID:end -->`. A section that ends the file also takes the
 * file's final newline. Each ID starts with its file's key, such as `core.` in `core/SKILL.md`.
 */
const section =
  /<!-- pomerado:section ([a-z0-9.-]+)(?: -->|:start\n([\s\S]*?)\npomerado:section \1:end -->)(?:\n(?=$))?/g;
/**
 * Anything left that reads as a marker, in any case or spacing, is malformed: a broken section, or
 * a 0.1.1 block such as `pomerado:hosted:end -->`. Authoring text never says `pomerado:` itself.
 */
const sectionTrace = /pomerado:/i;
const fence = /^\s*(`{3,}|~{3,})/;

/** A section marker belongs to the file's own text, never to a fenced example. */
const refuseFencedSections = (text: string) => {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const marker = fence.exec(line)?.[1];
    if (marker === undefined) {
      if (open !== undefined && sectionTrace.test(line))
        throw new Error("Authoring section inside a code fence");
    } else if (open === undefined) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = undefined;
  }
};

const standaloneText: AuthoringRender = (text, sectionKey) => {
  refuseFencedSections(text);
  const seen = new Set<string>();
  const rendered = text.replace(section, (_match: string, id: string, content?: string) => {
    if (!id.startsWith(`${sectionKey}.`))
      throw new Error(`Authoring section ${id} is not one of ${sectionKey}'s`);
    if (seen.has(id)) throw new Error(`Authoring section ${id} appears twice`);
    seen.add(id);
    return content ?? "";
  });
  if (sectionTrace.test(rendered)) throw new Error("Malformed authoring section");
  return rendered;
};

const readGuideFile = (
  directory: string,
  path: string,
  sectionKey: string,
  render: AuthoringRender,
) =>
  Effect.tryPromise({
    try: async () =>
      render(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readScopedFile(directory, `workspace/${path}`),
        ),
        sectionKey,
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
  render: AuthoringRender = standaloneText,
): Effect.Effect<WorkspaceGuide, MintFailure> =>
  Effect.gen(function* () {
    const instructions = yield* readGuideFile(directory, "AGENTS.md", "agents", render);
    const files = new Map([["AGENTS.md", instructions]]);
    for (const { path, sectionKey } of workspaceGuideFiles)
      files.set(path, yield* readGuideFile(directory, path, sectionKey, render));
    return { instructions, files };
  });

/** Pass the trusted installed authoring directory explicitly; it is not a model-selected path. */
export const loadAuthoringSkills = (
  directory: string,
  render: AuthoringRender = standaloneText,
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
              render(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  await readScopedFile(directory, `${entry.name}/SKILL.md`),
                ),
                entry.name,
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

/**
 * The local host's authoring: standalone text, with the hosted features its minter is to ignore on
 * top of `AGENTS.md`, both as instructions and as the workspace file.
 */
export const loadStandaloneAuthoring = (directory: string) =>
  Effect.gen(function* () {
    const guide = yield* loadWorkspaceGuide(directory);
    const skills = yield* loadAuthoringSkills(directory);
    if (hostedFeaturesPreamble === "") return { ...guide, skills };
    const instructions = `${hostedFeaturesPreamble}\n\n${guide.instructions}`;
    const files = new Map(
      [...guide.files].map(([path, text]) => [path, path === "AGENTS.md" ? instructions : text]),
    );
    return { instructions, files, skills };
  });
