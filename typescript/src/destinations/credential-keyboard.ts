import { Effect, Option, Schema } from "effect";

/** Keyboard remains decodable for older control documents, but is temporarily unsupported. */
export type CredentialTypingMode = "paste" | "keyboard";

/** The one-use, value-free binding a Kernel focus call placed on the original field. */
interface CredentialTarget {
  /** The host-inspected popup target only; absent binds to the stable primary tab. */
  readonly targetId?: string | undefined;
  readonly bindingKey: string;
  readonly documentOrigin: string;
}

/** Why native insertion inserted nothing, as one finite cause: never the binding key, a selector or a value. */
export const InsertionRefusal = Schema.Literal(
  /** No node carries the binding's marker in the target's sessions the host could read. */
  "binding_not_found",
  /** More than one node carries it, in one session or across sessions. */
  "binding_ambiguous",
  /** The marked node no longer resolves in the private world, or the browser refused to resolve. */
  "binding_unresolved",
  /** The marked node holds no binding in the private world: page code copied the marker. */
  "binding_not_in_world",
  /** The bound field left its document. */
  "detached",
  /** The bound field moved to another document. */
  "document_changed",
  /** The bound document no longer fills the frame it was bound in. */
  "frame_changed",
  /** That frame's origin is no longer the approved one. */
  "origin_changed",
  /** Another element holds the document's focus. */
  "focus_moved",
  /** The document itself does not hold the browser's focus. */
  "document_unfocused",
  /** A private answer's observed question no longer reads as it did when the host inspected it. */
  "question_changed",
  /** The browser's native insertion inserted nothing. */
  "insertion_rejected",
);
export type InsertionRefusal = typeof InsertionRefusal.Type;
/** A native insertion's answer: inserted, or why not. */
export const CredentialInsertion = Schema.Union(Schema.Literal("inserted"), InsertionRefusal);

/** Inserts only into the original field, or refuses with the finite cause. */
export interface CredentialKeyboard {
  readonly insertText: (
    target: CredentialTarget,
    text: string,
  ) => Effect.Effect<typeof CredentialInsertion.Type, Error>;
}

/**
 * The execution context a host's page calls bound the field in, for a host whose page calls
 * evaluate in a world other than the page's main one. `frameId` is the field's frame when it is
 * not the session's own. Without it, the field resolves in the main world.
 */
export type CredentialBindingWorld = (
  cdp: PrivateCredentialCdp,
  binding: { readonly sessionId: string; readonly frameId: string | undefined },
) => Effect.Effect<number, Error>;

export interface PrivateCredentialCdp {
  readonly sessions: (targetId?: string) => readonly string[];
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) => Promise<unknown>;
}

const RemoteResult = Schema.Struct({
  result: Schema.Struct({
    objectId: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Unknown),
  }),
  exceptionDetails: Schema.optional(Schema.Unknown),
});

const NativeNode = Schema.Struct({
  backendNodeId: Schema.Number,
  frameId: Schema.optional(Schema.String),
  attributes: Schema.optional(Schema.Array(Schema.String)),
  children: Schema.optional(Schema.Array(Schema.Unknown)),
  contentDocument: Schema.optional(Schema.Unknown),
  shadowRoots: Schema.optional(Schema.Array(Schema.Unknown)),
});
const NativeDocument = Schema.Struct({ root: Schema.Unknown });
const ResolvedNode = Schema.Struct({
  object: Schema.Struct({ objectId: Schema.optional(Schema.String) }),
});

const nativeDescendants = (node: typeof NativeNode.Type, frameId: string | undefined) => {
  const descendants = [...(node.children ?? []), ...(node.shadowRoots ?? [])].map((value) => ({
    value,
    frameId,
  }));
  if (node.contentDocument !== undefined) {
    if (node.frameId === undefined) throw new Error("Credential frame unavailable");
    descendants.push({ value: node.contentDocument, frameId: node.frameId });
  }
  return descendants;
};

/** Ephemeral, bounded native traversal: exactly one opaque marker, never a selector fallback. */
const findMarkedNode = (
  value: unknown,
  key: string,
): { backendNodeId: number; frameId: string | undefined } | "binding_ambiguous" | undefined => {
  const document = Schema.decodeUnknownOption(NativeDocument)(value);
  if (document._tag === "None") throw new Error("Credential target document unavailable");
  const { root } = document.value;
  const pending: { value: unknown; frameId: string | undefined }[] = [
    { value: root, frameId: undefined },
  ];
  let found: { backendNodeId: number; frameId: string | undefined } | undefined;
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > 50_000) throw new Error("Credential target document too large");
    const next = pending.pop();
    if (next === undefined) break;
    const decoded = Schema.decodeUnknownOption(NativeNode)(next.value);
    if (decoded._tag === "None") throw new Error("Credential target node unavailable");
    const node = decoded.value;
    const attributes = node.attributes ?? [];
    for (let index = 0; index < attributes.length; index += 2) {
      if (attributes[index] !== key) continue;
      if (found !== undefined) return "binding_ambiguous";
      found = { backendNodeId: node.backendNodeId, frameId: next.frameId };
    }
    pending.push(...nativeDescendants(node, next.frameId));
  }
  return found;
};

/**
 * Guard and insertion share this synchronous call on the original DOM object. Native insertion
 * emits a trusted InputEvent without key events. A stale document's object cannot run on a new
 * document; a moved focus never receives a value.
 */
const atomicInsert = `function(key, origin, text) {
  const field = this;
  const binding = field[key];
  field.removeAttribute(key);
  delete field[key];
  if (!binding) return "binding_not_in_world";
  const { document, frame } = binding;
  if (!field.isConnected) return "detached";
  if (field.ownerDocument !== document) return "document_changed";
  if (document.defaultView !== frame || frame.document !== document) return "frame_changed";
  if (frame.origin !== origin) return "origin_changed";
  if (document.activeElement !== field) return "focus_moved";
  if (!document.hasFocus()) return "document_unfocused";
  if (binding.questionRequired &&
      (typeof binding.checkQuestion !== "function" || !binding.checkQuestion())) return "question_changed";
  return document.execCommand("insertText", false, text) ? "inserted" : "insertion_rejected";
}`;

const command = (
  cdp: PrivateCredentialCdp,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
) =>
  Effect.tryPromise({
    try: () => cdp.send(method, params, sessionId),
    catch: (error) =>
      error instanceof Error ? error : new Error("Credential insertion unavailable"),
  });

const resultOf = (value: unknown) => {
  const decoded = Schema.decodeUnknownOption(RemoteResult)(value);
  if (decoded._tag === "None" || decoded.value.exceptionDetails !== undefined)
    throw new Error("Credential target binding unavailable");
  return decoded.value.result;
};

/**
 * The one field the target's binding marks, resolved in its world, or why not, sending no value.
 * A session whose document the browser refuses to read, such as a third-party frame's, is skipped:
 * when it held the field, the binding is not found, and a marker copied elsewhere holds no binding
 * in the private world. A node the browser refuses to resolve is unresolved.
 */
const findBinding = (
  cdp: PrivateCredentialCdp,
  target: CredentialTarget,
  bindingWorld: CredentialBindingWorld | undefined,
) =>
  Effect.gen(function* () {
    let found:
      { sessionId: string; backendNodeId: number; frameId: string | undefined } | undefined;
    for (const sessionId of cdp.sessions(target.targetId)) {
      const read = yield* Effect.either(
        command(cdp, sessionId, "DOM.getDocument", { depth: -1, pierce: true }),
      );
      if (read._tag === "Left") continue;
      const node = yield* Effect.try({
        try: () => findMarkedNode(read.right, target.bindingKey),
        catch: (error) =>
          error instanceof Error ? error : new Error("Credential target binding unavailable"),
      });
      if (node === undefined) continue;
      if (node === "binding_ambiguous" || found !== undefined) return "binding_ambiguous" as const;
      found = { sessionId, ...node };
    }
    if (found === undefined) return "binding_not_found" as const;
    let executionContextId: number | undefined;
    if (bindingWorld !== undefined)
      executionContextId = yield* bindingWorld(cdp, {
        sessionId: found.sessionId,
        frameId: found.frameId,
      });
    const resolved = yield* Effect.either(
      command(cdp, found.sessionId, "DOM.resolveNode", {
        backendNodeId: found.backendNodeId,
        ...(executionContextId === undefined ? {} : { executionContextId }),
      }),
    );
    const objectId =
      resolved._tag === "Left"
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(ResolvedNode)(resolved.right))?.object
            .objectId;
    return objectId === undefined
      ? ("binding_unresolved" as const)
      : { sessionId: found.sessionId, objectId };
  });

/**
 * The credential-only native DOM reads and Runtime calls on the private socket resolve the original
 * field binding, insert atomically into that remote object, then release it. No parameters enter
 * recorder history or logs, and the secret is an argument, never Kernel REST script text.
 */
export const makeCredentialKeyboard = (
  cdp: PrivateCredentialCdp,
  // error-reporting-allow: typed-recovery releasing the temporary DOM object cannot undo inserted credentials; the owned browser context also releases it when closed
  release: (effect: Effect.Effect<unknown, Error>) => Effect.Effect<void> = Effect.ignore,
  bindingWorld?: CredentialBindingWorld,
): CredentialKeyboard => ({
  insertText: (target, text) =>
    Effect.gen(function* () {
      const bound = yield* findBinding(cdp, target, bindingWorld);
      if (typeof bound === "string") return bound;
      const value = yield* command(cdp, bound.sessionId, "Runtime.callFunctionOn", {
        objectId: bound.objectId,
        functionDeclaration: atomicInsert,
        arguments: [
          { value: target.bindingKey },
          { value: target.documentOrigin },
          { value: text },
        ],
        returnByValue: true,
      }).pipe(
        Effect.ensuring(
          release(
            command(cdp, bound.sessionId, "Runtime.releaseObject", { objectId: bound.objectId }),
          ),
        ),
      );
      const answer = yield* Effect.try({
        try: () => resultOf(value).value,
        catch: (error) =>
          error instanceof Error ? error : new Error("Credential insertion unavailable"),
      });
      // An answer outside the finite set leaves whether the value landed unknown.
      return yield* Schema.decodeUnknown(CredentialInsertion)(answer).pipe(
        Effect.mapError((cause) => new Error("Credential insertion unavailable", { cause })),
      );
    }),
});
