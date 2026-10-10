import { selectAll, selectOne as selectFirst } from "css-select";
import type { AnyNode, Document, Element } from "domhandler";
import { findAll, getOuterHTML, textContent } from "domutils";
import { Data, Effect, Either, ParseResult, Schema } from "effect";
import { parseDocument } from "htmlparser2";
import { answer, described, readText, safeMethods, unexpected } from "./http-operation.js";
import type { OperationFailure } from "./operation-failure.js";
import type { HttpFailure, SiteHttpRequest, SiteHttpService } from "./site-http.js";

/** One element of a parsed page. */
export interface HtmlNode {
  /** The element's text: entities decoded, each run of whitespace one space, trimmed. */
  readonly text: () => string;
  /** An attribute's value with entities decoded, or undefined when the element has none. */
  readonly attr: (name: string) => string | undefined;
  /** The element's own markup, the element included. */
  readonly html: () => string;
  /** Every descendant that matches a CSS selector, in document order. */
  readonly select: (css: string) => HtmlNode[];
  /** The first descendant that matches a CSS selector, or undefined when none does. */
  readonly selectOne: (css: string) => HtmlNode | undefined;
}

/** A parsed page. */
export interface HtmlDocument {
  /** Every element that matches a CSS selector, in document order. */
  readonly select: (css: string) => HtmlNode[];
  /** The first element that matches a CSS selector, or undefined when none does. */
  readonly selectOne: (css: string) => HtmlNode | undefined;
  /** The page's `<title>` text, or undefined when it has none or it is blank. */
  readonly title: () => string | undefined;
}

const collapsed = (node: AnyNode) => textContent(node).replace(/\s+/gu, " ").trim();

const node = (element: Element): HtmlNode => ({
  text: () => collapsed(element),
  attr: (name) => element.attribs[name.toLowerCase()],
  html: () => getOuterHTML(element),
  select: (css) => selectAll<AnyNode, Element>(css, element).map(node),
  selectOne: (css) => {
    const found = selectFirst<AnyNode, Element>(css, element);
    return found === null ? undefined : node(found);
  },
});

const titleOf = (document: Document) => {
  const title = selectFirst<AnyNode, Element>("title", document);
  const text = title === null ? "" : collapsed(title);
  return text === "" ? undefined : text;
};

/**
 * Parses an HTML answer into an inert tree to read with CSS selectors. Nothing on the page runs
 * and nothing is fetched. A selector the CSS engine does not support throws.
 */
export const parseHtml = (text: string): HtmlDocument => {
  const document = parseDocument(text);
  return {
    select: (css) => selectAll<AnyNode, Element>(css, document).map(node),
    selectOne: (css) => {
      const found = selectFirst<AnyNode, Element>(css, document);
      return found === null ? undefined : node(found);
    },
    title: () => titleOf(document),
  };
};

/**
 * Where a page keeps JSON: a `<script>` element by its `id`, every `<script>` of a JSON type
 * (`ld+json` is `application/ld+json`, `json` is `application/json`), or an attribute such as
 * `data-state` that holds JSON.
 */
export type EmbeddedJsonSelector =
  | { readonly id: string }
  | { readonly type: "ld+json" | "json" }
  | { readonly attribute: string };

/**
 * `embeddedJson` found no JSON where the selector points: `missing` when nothing is there or it is
 * empty, `unparsable` when it is there but is not JSON. The message names the selector and the
 * page's title.
 */
export class EmbeddedJsonFailure extends Data.TaggedError("EmbeddedJsonFailure")<{
  readonly reason: "missing" | "unparsable";
  readonly message: string;
}> {}

const selectorText = (select: EmbeddedJsonSelector) =>
  "id" in select
    ? `<script id="${select.id}">`
    : "type" in select
      ? `<script type="application/${select.type}">`
      : `[${select.attribute}]`;

/** Comment and CDATA wrappers, with an optional `//` before each marker, and a trailing `;`. */
const wrappers = [
  /^(?:\/\/[ \t]*)?<!--/u,
  /(?:\/\/[ \t]*)?-->$/u,
  /^(?:\/\/[ \t]*)?<!\[CDATA\[/u,
  /(?:\/\/[ \t]*)?\]\]>$/u,
  /;$/u,
];

const unwrapped = (text: string) => {
  let current = text.trim();
  for (let previous = ""; previous !== current; ) {
    previous = current;
    for (const wrapper of wrappers) current = current.replace(wrapper, "").trim();
  }
  return current;
};

const scriptType = (element: Element) =>
  (element.attribs["type"] ?? "").split(";")[0]?.trim().toLowerCase();

/** The raw texts the selector points at, in document order. */
const candidates = (document: Document, select: EmbeddedJsonSelector) => {
  if ("id" in select)
    return findAll(
      (element) => element.name === "script" && element.attribs["id"] === select.id,
      document,
    ).map((element) => textContent(element));
  if ("type" in select)
    return findAll(
      (element) =>
        element.name === "script" && scriptType(element) === `application/${select.type}`,
      document,
    ).map((element) => textContent(element));
  const name = select.attribute.toLowerCase();
  return findAll((element) => element.attribs[name] !== undefined, document).map(
    (element) => element.attribs[name] ?? "",
  );
};

/**
 * The JSON a page embeds where `select` points. Script text loses surrounding whitespace,
 * `<!-- -->` and `<![CDATA[ ]]>` wrappers and a trailing `;`; an attribute's entities are decoded.
 * An `id` or `attribute` selector gives the first value that parses; a `type` selector gives an
 * array of every block of that type that parses, each as written (an `@graph` stays as it is).
 * Fails with an `EmbeddedJsonFailure` that names the selector and the page's title.
 */
export const embeddedJson = (
  text: string,
  select: EmbeddedJsonSelector,
): Either.Either<unknown, EmbeddedJsonFailure> => {
  const document = parseDocument(text);
  const title = titleOf(document);
  const page =
    title === undefined
      ? "the page, which has no title"
      : `the page ${JSON.stringify(title.slice(0, 200))}`;
  const where = `${selectorText(select)} in ${page}`;
  const found = candidates(document, select);
  const present = found.map(unwrapped).filter((value) => value !== "");
  if (present.length === 0)
    return Either.left(
      new EmbeddedJsonFailure({
        reason: "missing",
        message: `${where} is ${found.length === 0 ? "missing" : "empty"}.`,
      }),
    );
  const parsed: unknown[] = [];
  let firstError: unknown;
  for (const value of present) {
    try {
      parsed.push(JSON.parse(value));
    } catch (error) {
      firstError ??= error;
    }
  }
  if (parsed.length === 0)
    return Either.left(
      new EmbeddedJsonFailure({
        reason: "unparsable",
        message: `${where} is not JSON: ${
          firstError instanceof Error ? firstError.message : String(firstError)
        }`,
      }),
    );
  return Either.right("type" in select ? parsed : parsed[0]);
};

/**
 * JSON a page embeds, decoded with `schema`: `readText`, then `embeddedJson` at `select`. When a
 * safe read's answer did not come over the page's fetch and lacks the block, as a page that fills
 * it in only for a browser does, it reads once more over the page's fetch
 * (`requires: ["page-environment"]`) where the host can carry it. Each failure is an
 * `OperationFailure` of class `parsing` that names the selector, the page's title, and the URL,
 * status and transport of the answer it read.
 */
export const readEmbeddedJson = <A, I, R>(
  http: SiteHttpService,
  request: SiteHttpRequest,
  select: EmbeddedJsonSelector,
  schema: Schema.Schema<A, I, R>,
): Effect.Effect<A, HttpFailure | OperationFailure, R> =>
  Effect.gen(function* () {
    let read = yield* readText(http, request);
    let found = embeddedJson(read.text, select);
    if (
      Either.isLeft(found) &&
      found.left.reason === "missing" &&
      read.response.transport !== "page-fetch" &&
      safeMethods.has(request.method) &&
      request.requires?.includes("page-environment") !== true &&
      http.capabilities.includes("page-environment")
    ) {
      read = yield* readText(http, {
        ...request,
        requires: [...(request.requires ?? []), "page-environment"],
      });
      found = embeddedJson(read.text, select);
    }
    const { response } = read;
    if (Either.isLeft(found))
      return yield* Effect.fail(
        unexpected(
          `${found.left.message} ${described(request, response)}`,
          answer("parsing", request, response),
          found.left,
        ),
      );
    return yield* Schema.decodeUnknown(schema)(found.right).pipe(
      Effect.mapError((error) =>
        unexpected(
          `${request.method} ${response.requestUrl} answered ${selectorText(select)} JSON that does not match the schema: ${ParseResult.TreeFormatter.formatErrorSync(error)}`,
          answer("parsing", request, response),
          error,
        ),
      ),
    );
  });
