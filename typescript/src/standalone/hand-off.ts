import { Effect } from "effect";
import { fileFormat } from "../runtime/files.js";
import {
  InputRequestFailure,
  isBrowserHandoff,
  type InputAsker,
  type InputRequest,
} from "../runtime/input-request.js";

/** The longest input value the local host shows beside a hand-off; a longer one ends in "…". */
const shownValueLength = 200;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether the input schema's top-level property `name` holds a file anywhere in its schema. */
const holdsFile = (inputSchema: unknown, name: string) => {
  const properties = isRecord(inputSchema) ? inputSchema["properties"] : undefined;
  const property = isRecord(properties) ? properties[name] : undefined;
  return JSON.stringify(property ?? {}).includes(`"format":${JSON.stringify(fileFormat)}`);
};

/**
 * The inputs a hand-off names, as the local host shows them: each plain text, number or yes/no
 * value the run's input holds, never a file and never a list or an object.
 */
const shownLines = (
  names: readonly string[],
  input: unknown,
  inputSchema: unknown,
): readonly string[] =>
  names.flatMap((name) => {
    const value = isRecord(input) && Object.hasOwn(input, name) ? input[name] : undefined;
    if (inputSchema === undefined || holdsFile(inputSchema, name)) return [];
    if (typeof value === "boolean") return [`${name}: ${value ? "yes" : "no"}`];
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))
      return [];
    const text = String(value).replace(/\s+/gu, " ").trim();
    if (text === "") return [];
    return [
      `${name}: ${text.length > shownValueLength ? `${text.slice(0, shownValueLength - 1)}…` : text}`,
    ];
  });

/** The run's inputs a hand-off shows beside the browser, as its notice; none when it shows none. */
const handOffNotice = (request: InputRequest, input: unknown, inputSchema: unknown) => {
  const names = request.questions.flatMap((question) =>
    question.type === "browser_handoff" ? question.show_inputs : [],
  );
  const lines = shownLines(names, input, inputSchema);
  return lines.length === 0 ? undefined : ["This run's inputs:", ...lines].join("\n");
};

/**
 * The local host's asker for a run that may hand its browser to a person. The local browser is the
 * person's own window, so a hand-off asks through `ask`, whose surface tells the person to use it,
 * with a notice that shows the inputs the question names. A browser with no visible window can't
 * be handed to anyone, so the hand-off fails as `Unavailable` and nobody is asked. Every other
 * request goes to `ask` unchanged.
 */
export const localHandOffAsker =
  (
    ask: InputAsker,
    options: {
      /** Whether the run's browser shows a window a person can use. */
      readonly visible: boolean;
      /** The run's input, from which the shown inputs are read. */
      readonly input?: unknown;
      /** The tool's input JSON Schema; without it no input value is shown. */
      readonly inputSchema?: unknown;
    },
  ): InputAsker =>
  (request, bounds) => {
    if (!isBrowserHandoff(request)) return ask(request, bounds);
    if (!options.visible)
      return Effect.fail(
        new InputRequestFailure({ code: "Unavailable", operation: "browser_handoff_headless" }),
      );
    const notice = handOffNotice(request, options.input, options.inputSchema);
    return ask(
      notice === undefined || request.notice !== undefined ? request : { ...request, notice },
      bounds,
    );
  };

/** Whether the local host's browser options give a window a person can use. */
export const visibleBrowser = (
  browser: { readonly headless?: boolean; readonly endpoint?: string } | undefined,
) => browser?.endpoint !== undefined || browser?.headless === false;
