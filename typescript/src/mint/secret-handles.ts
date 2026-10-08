import { Option, Schema } from "effect";
import type { ValidAnswer, ValidAnswers } from "../runtime/input-request.js";
import { isAuthoredSourcePath, operationSourceFiles } from "./operation-source.js";
import { handlePlacements } from "./secret-handle-sinks.js";
import type { Quote } from "./secret-handle-sinks.js";

/**
 * A `secret` answer to the minter's own `request_input` reaches the model as a handle,
 * `{{secret.sN}}`, never as the value. The host keeps the value for the attempt and
 * fills each handle into a live execution's authored source only after Guardian review, so the
 * model, its history, Guardian, traces and published source only ever hold the handle. The broker,
 * where the asker registered the value, masks it in anything the execution returns.
 *
 * A handle is filled only where `secret-handle-sinks.ts` places it; any other occurrence refuses
 * the execution. This keeps the value out of the model's transcript and blocks accidental leaks;
 * code written to recover the value can still do so, and Guardian's handle rule is the backstop.
 */

/** Anything shaped like a handle, issued or not. */
const handleShape = /\{\{\s*secret\.[^{}]*\}\}/gu;
const issuedShape = /^\{\{secret\.s[1-9]\d*\}\}$/u;

/** Whether text holds a handle or anything shaped like one. */
export const holdsSecretHandle = (text: string) => /\{\{\s*secret\./u.test(text);

/**
 * The first file that publishing these entrypoints would ship and that holds a handle. Published
 * source asks for a secret at run time through a declared question; it never holds a handle.
 */
export const publishedHandlePath = (
  files: ReadonlyMap<string, string>,
  entrypoints: readonly string[],
) =>
  [...operationSourceFiles(files, entrypoints)].find(([, source]) =>
    holdsSecretHandle(source),
  )?.[0];

/** Whether a model-visible secret answer is a handle this module issues, never a value. */
export const isSecretHandle = (value: string) => issuedShape.test(value);

/** The rule a misplaced handle's refusal states after its file and line. */
const misplacedHandleRule =
  "a secret handle may only be the whole string passed as the value to fill, type or pressSequentially, or a field of a request to this site, in code that never reads a typed field back (inputValue, evaluate), reads its own source, or redefines JSON, a global, a prototype or a page, keyboard or Kernel method; anything else is refused";

/**
 * The value as it must be written where the handle stood: escaped for the Playwright literal it
 * fills, then for the file's literal that carries that code, so a quote, backslash, `$` or line
 * break in a caller's answer can neither break either literal nor inject code.
 */
const escapedFor = (quote: Quote, value: string) => {
  const escaped = JSON.stringify(value).slice(1, -1);
  if (quote === '"') return escaped;
  return escaped.replace(quote === "'" ? /'/gu : /[`$]/gu, (character) => `\\${character}`);
};

export const SecretHandlesSnapshot = Schema.Array(
  Schema.Tuple(Schema.String.pipe(Schema.pattern(/^\{\{secret\.s[1-9]\d*\}\}$/u)), Schema.String),
).pipe(
  Schema.filter((values) => new Set(values.map(([handle]) => handle)).size === values.length, {
    message: () => "duplicate secret handle",
  }),
);
export type SecretHandlesSnapshot = typeof SecretHandlesSnapshot.Type;

export interface SecretHandles {
  readonly snapshot: () => SecretHandlesSnapshot;
  /** The answers as the model receives them: each `secret` value replaced by a new handle. */
  readonly issue: (answers: ValidAnswers) => ValidAnswers;
  /**
   * The model's answers a checkpoint kept for `answers`: each kept `secret` value must be a handle
   * issued for that same answer's value. Undefined when any is not.
   */
  readonly kept: (answers: ValidAnswers, kept: unknown) => ValidAnswers | undefined;
  /** Handle-shaped text in the authored source that this attempt never issued. */
  readonly unissued: (files: ReadonlyMap<string, string>) => readonly string[];
  /** The first authored file and line holding a handle anywhere but a site-input sink. */
  readonly misplaced: (
    files: ReadonlyMap<string, string>,
    siteOrigin: string | undefined,
  ) => { readonly path: string; readonly line: number } | undefined;
  /**
   * A copy of the files with every issued handle that sits in a sink replaced by its value. A file
   * holding a handle anywhere else is left as written, so no value is placed outside a sink.
   */
  readonly fill: (
    files: ReadonlyMap<string, string>,
    siteOrigin: string | undefined,
  ) => Map<string, string>;
}

/** One attempt's handles. Values live only in this closure, for the attempt's lifetime. */
export const makeSecretHandles = (initial: SecretHandlesSnapshot = []): SecretHandles => {
  const values = new Map<string, string>(initial);
  let next = Math.max(0, ...initial.map(([handle]) => Number(handle.slice(10, -2)))) + 1;
  return {
    snapshot: () => [...values],
    issue: (answers) => {
      const issued: Record<string, ValidAnswer> = {};
      for (const [id, answer] of Object.entries(answers)) {
        if (answer.type !== "secret") {
          issued[id] = answer;
          continue;
        }
        // Numbered per attempt, so two requests, or two questions sharing an id, never collide.
        const handle = `{{secret.s${next++}}}`;
        values.set(handle, answer.value);
        issued[id] = { type: "secret", value: handle };
      }
      return issued;
    },
    kept: (answers, kept) => {
      const decoded = Schema.decodeUnknownOption(
        Schema.Record({ key: Schema.String, value: Schema.Struct({ value: Schema.Unknown }) }),
      )(kept);
      if (Option.isNone(decoded)) return undefined;
      const restored: Record<string, ValidAnswer> = {};
      for (const [id, answer] of Object.entries(answers)) {
        const handle = decoded.value[id]?.value;
        if (answer.type !== "secret") restored[id] = answer;
        else if (typeof handle === "string" && values.get(handle) === answer.value)
          restored[id] = { type: "secret", value: handle };
        else return undefined;
      }
      return restored;
    },
    unissued: (files) => {
      const unknown = new Set<string>();
      for (const [path, source] of files)
        if (isAuthoredSourcePath(path))
          for (const [handle] of source.matchAll(handleShape))
            if (!values.has(handle)) unknown.add(handle);
      return [...unknown];
    },
    misplaced: (files, siteOrigin) => {
      for (const [path, source] of files) {
        if (!isAuthoredSourcePath(path)) continue;
        const analysis = handlePlacements(path, source, siteOrigin);
        if ("line" in analysis) return { path, line: analysis.line };
      }
      return undefined;
    },
    fill: (files, siteOrigin) =>
      new Map(
        [...files].map(([path, source]) => {
          if (!isAuthoredSourcePath(path) || values.size === 0) return [path, source];
          const analysis = handlePlacements(path, source, siteOrigin);
          if ("line" in analysis) return [path, source];
          let filled = source;
          for (const placement of analysis.placements.toSorted((a, b) => b.start - a.start)) {
            const value = values.get(placement.handle);
            if (value === undefined) continue;
            const [inner, outer] = placement.quotes;
            filled =
              filled.slice(0, placement.start) +
              escapedFor(outer, escapedFor(inner, value)) +
              filled.slice(placement.start + placement.handle.length);
          }
          return [path, filled];
        }),
      ),
  };
};

/**
 * Why a live step is refused before review for its handles, if it is. A handle this attempt never
 * issued could only fill in wrong. An example runs the source that publishes, and published
 * source never holds a handle, so an example is not spent on source that could never publish. A
 * filled value must go nowhere but the site, so a handle outside a site-input sink is refused
 * with its file and line. Offline steps never receive a value and run the handle text as
 * written, and a sign-in step fills its fields itself.
 */
export const secretHandleRefusal = (
  handles: Pick<SecretHandles, "unissued" | "misplaced">,
  files: ReadonlyMap<string, string>,
  step: { readonly purpose: string; readonly target: string; readonly entrypoint: string },
  siteOrigin: string | undefined,
): string | undefined => {
  if (step.target !== "liveBrowser" || step.purpose === "authenticate") return undefined;
  const unissued = handles.unissued(files);
  if (unissued.length > 0)
    return `The source names ${unissued.slice(0, 4).join(", ")}, which no request_input secret answer in this attempt returned. Use only a handle an answer gave you, exactly as given. Nothing was executed.`;
  const published =
    step.purpose === "example" ? publishedHandlePath(files, [step.entrypoint]) : undefined;
  if (published !== undefined)
    return `${published} holds a secret handle. An example runs the source you publish, and published source never holds one; move exploration that uses a handle out of src/. Declare the value as a secret question in the operation's questions and read it with ask at run time, as .agents/caller-input/SKILL.md shows, then run the example again. Nothing was executed.`;
  const misplaced = handles.misplaced(files, siteOrigin);
  return misplaced === undefined
    ? undefined
    : `${misplaced.path} line ${misplaced.line}: ${misplacedHandleRule}. Write the handle as the whole string literal in the Playwright code of a kernel.browsers.playwright.execute call, such as page.getByLabel("Code").fill("{{secret.s1}}"). Nothing was executed.`;
};
