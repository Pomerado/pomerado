import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";
import { sourceSyntax } from "../runtime/source-syntax.js";

/*
 * What a version's live evidence is tied to: the code that runs, never the words its schemas carry
 * for readers. An edit that only rewords a description, a title or a comment, or reflows the file,
 * leaves the tested code and its results standing, on the Playwright version and the HTTP version
 * alike.
 */

/** Schema annotations written for readers; nothing a request, a page step or a parser reads. */
const annotationKeys: ReadonlySet<string> = new Set([
  "description",
  "title",
  "examples",
  "documentation",
  "$comment",
]);

/** The `type` values of a JSON schema, which mark an object literal as one. */
const jsonSchemaTypes: ReadonlySet<unknown> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/** Positions and the parent link, which say where code is, never what it does. */
const positionKeys: ReadonlySet<string> = new Set(["start", "end", "range", "loc", "parent"]);

const field = (node: unknown, key: string): unknown =>
  typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined;

const list = (node: unknown, key: string): readonly unknown[] => {
  const value = field(node, key);
  return Array.isArray(value) ? value : [];
};

const keyName = (property: unknown) => {
  if (field(property, "type") !== "Property" || field(property, "computed") === true) return "";
  const key = field(property, "key");
  const name = field(key, "type") === "Identifier" ? field(key, "name") : field(key, "value");
  return typeof name === "string" ? name : "";
};

/** A string written plainly, as an annotation's text is. */
const plainText = (value: unknown) =>
  (field(value, "type") === "Literal" && typeof field(value, "value") === "string") ||
  (field(value, "type") === "TemplateLiteral" && list(value, "expressions").length === 0);

/** An entry `codeOf` leaves out of the list that holds it. */
const dropped = Symbol("dropped");

/**
 * An `.annotations({...})` call whose object holds only annotation keys: what it is called on,
 * or `dropped` for `Schema.annotations({...})` in a pipe, which then leaves its arguments.
 */
const annotationCall = (node: unknown): unknown => {
  const callee = field(node, "callee");
  const [argument, ...rest] = list(node, "arguments");
  if (
    field(node, "type") !== "CallExpression" ||
    field(callee, "type") !== "MemberExpression" ||
    field(callee, "computed") === true ||
    field(field(callee, "property"), "name") !== "annotations" ||
    field(argument, "type") !== "ObjectExpression" ||
    rest.length > 0 ||
    !list(argument, "properties").every((property) => annotationKeys.has(keyName(property)))
  )
    return undefined;
  const object = field(callee, "object");
  return field(object, "type") === "Identifier" && field(object, "name") === "Schema"
    ? dropped
    : object;
};

/** An object literal that is a JSON schema: a `type` naming a JSON schema type, or `properties`. */
const jsonSchemaObject = (node: unknown) =>
  field(node, "type") === "ObjectExpression" &&
  list(node, "properties").some(
    (property) =>
      keyName(property) === "properties" ||
      (keyName(property) === "type" &&
        jsonSchemaTypes.has(field(field(property, "value"), "value"))),
  );

/** A JSON schema object's plain-text annotation, such as its `description`. */
const textAnnotation = (property: unknown) =>
  annotationKeys.has(keyName(property)) && plainText(field(property, "value"));

/**
 * The program's syntax tree without positions, comments and schema annotations: an annotation-
 * only `.annotations({...})` call, and a JSON schema object's plain-text annotation. Every
 * literal keeps its exact value, so text inside a string, a template or a regular expression is
 * code, and so is a property named like an annotation anywhere else, such as a selector map's.
 */
const codeOf = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(codeOf).filter((entry) => entry !== dropped);
  if (typeof node !== "object" || node === null) return node;
  const called = annotationCall(node);
  if (called !== undefined) return called === dropped ? dropped : codeOf(called);
  const schema = jsonSchemaObject(node);
  return Object.fromEntries(
    Object.entries(node).flatMap(([key, value]: [string, unknown]) =>
      positionKeys.has(key)
        ? []
        : [
            [
              key,
              codeOf(
                schema && key === "properties" && Array.isArray(value)
                  ? value.filter((property) => !textAnnotation(property))
                  : value,
              ),
            ],
          ],
    ),
  );
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The digest of one file's code (`codeOf`): a JavaScript or TypeScript file that parses, by its
 * syntax tree; any other file, one that does not parse, or one nested too deep to walk, by its
 * whole text, prefixed so the two kinds never collide.
 */
export const fileCodeDigest = (path: string, source: string): string => {
  const syntax = sourceSyntax(path);
  if (syntax === undefined) return `text:${sha256(source)}`;
  const parsed = parseSync(syntax === "typescript" ? "module.ts" : "module.js", source, {
    lang: syntax === "typescript" ? "ts" : "js",
    sourceType: "module",
  });
  if (parsed.errors.length > 0) return `text:${sha256(source)}`;
  try {
    return `code:${sha256(JSON.stringify(codeOf(parsed.program)))}`;
  } catch (error) {
    // A syntax tree too deep for the walk's stack keeps the whole text's digest.
    if (error instanceof RangeError) return `text:${sha256(source)}`;
    throw error;
  }
};

/**
 * The digest of what a set of source files' code does, without their paths, so the same step
 * copied under another name has the same digest, and an edit of comments, formatting or schema
 * annotations alone keeps it.
 */
export const codeContentDigest = (files: ReadonlyMap<string, string>) =>
  sha256(JSON.stringify([...files].map(([path, source]) => fileCodeDigest(path, source)).sort()));
