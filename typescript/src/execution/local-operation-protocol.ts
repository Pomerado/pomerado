import { Schema } from "effect";
import { InputRequest } from "../runtime/input-request.js";
import { DialogReport } from "../runtime/kernel-operation.js";

const Id = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200));
export const LocalOperationStart = Schema.Struct({
  kind: Schema.Literal("start"),
  entrypoint: Schema.String,
  input: Schema.Unknown,
  retainedOutput: Schema.optionalWith(Schema.Struct({ value: Schema.Unknown }), { exact: true }),
  sessionId: Schema.String,
  siteOrigin: Schema.optionalWith(Schema.String, { exact: true }),
  siteDomain: Schema.optionalWith(Schema.String, { exact: true }),
  timeoutMs: Schema.Number.pipe(Schema.positive(), Schema.finite()),
  mode: Schema.Literal("run", "contract"),
  validateInput: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export const LocalOperationReply = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("reply"), id: Id, value: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal("failure"),
    id: Id,
    error: Schema.String,
    code: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);
const JournalFields = {
  effect: Schema.Literal("not_started", "may_have_dispatched", "verified"),
  confirmation: Schema.optionalWith(Schema.Literal("message", "readback"), { exact: true }),
  commits: Schema.Array(
    Schema.Struct({ name: Schema.String, state: Schema.Literal("not_sent", "sent", "confirmed") }),
  ),
};
const WriteDeclaration = Schema.Struct({
  confirmation: Schema.Literal("message", "readback", "unverifiable"),
  commits: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});
export const LocalOperationMessage = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("execute"),
    id: Id,
    sessionId: Schema.String,
    body: Schema.Struct({
      code: Schema.String.pipe(Schema.maxLength(1_048_576)),
      timeout_sec: Schema.optionalWith(Schema.Int.pipe(Schema.between(1, 300)), { exact: true }),
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("ask"), id: Id, request: InputRequest }),
  Schema.Struct({ kind: Schema.Literal("dialog"), id: Id, report: DialogReport }),
  Schema.Struct({ kind: Schema.Literal("cancel"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("journal"), ...JournalFields }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    output: Schema.optionalWith(Schema.Unknown, { exact: true }),
    inputSchema: Schema.Unknown,
    outputSchema: Schema.Unknown,
    write: Schema.optionalWith(WriteDeclaration, { exact: true }),
    inputDecodes: Schema.optionalWith(Schema.Literal(true), { exact: true }),
    ...JournalFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    error: Schema.String,
    code: Schema.optionalWith(Schema.String, { exact: true }),
    tag: Schema.optionalWith(Schema.String, { exact: true }),
    ...JournalFields,
  }),
);
export type LocalOperationMessage = typeof LocalOperationMessage.Type;
export type LocalOperationResult = Extract<LocalOperationMessage, { readonly kind: "result" }>;
