import { Effect, Schema } from "effect";

/** Keyboard remains decodable for older control documents, but is temporarily unsupported. */
export type CredentialTypingMode = "paste" | "keyboard";

/** The one-use, value-free binding a Kernel focus call placed on the original field. */
interface CredentialTarget {
  /** The host-inspected popup target only; absent binds to the stable primary tab. */
  readonly targetId?: string | undefined;
  readonly bindingKey: string;
  readonly documentOrigin: string;
}

/** Inserts only into the original field; false means its document, origin or focus changed. */
export interface CredentialKeyboard {
  readonly insertText: (target: CredentialTarget, text: string) => Effect.Effect<boolean, Error>;
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
const findMarkedNode = (value: unknown, key: string) => {
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
      if (found !== undefined) throw new Error("Credential target binding ambiguous");
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
  if (!binding) return false;
  const { document, frame } = binding;
  if (!field.isConnected || field.ownerDocument !== document || document.defaultView !== frame ||
      frame.document !== document || frame.origin !== origin ||
      document.activeElement !== field || !document.hasFocus()) return false;
  return document.execCommand("insertText", false, text);
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

const findBinding = (
  cdp: PrivateCredentialCdp,
  target: CredentialTarget,
  bindingWorld: CredentialBindingWorld | undefined,
) =>
  Effect.gen(function* () {
    let found:
      { sessionId: string; backendNodeId: number; frameId: string | undefined } | undefined;
    for (const sessionId of cdp.sessions(target.targetId)) {
      const value = yield* command(cdp, sessionId, "DOM.getDocument", { depth: -1, pierce: true });
      const node = yield* Effect.try({
        try: () => findMarkedNode(value, target.bindingKey),
        catch: (error) =>
          error instanceof Error ? error : new Error("Credential target binding unavailable"),
      });
      if (node === undefined) continue;
      if (found !== undefined) return undefined;
      found = { sessionId, ...node };
    }
    if (found === undefined) return undefined;
    let executionContextId: number | undefined;
    if (bindingWorld !== undefined)
      executionContextId = yield* bindingWorld(cdp, {
        sessionId: found.sessionId,
        frameId: found.frameId,
      });
    const value = yield* command(cdp, found.sessionId, "DOM.resolveNode", {
      backendNodeId: found.backendNodeId,
      ...(executionContextId === undefined ? {} : { executionContextId }),
    });
    const { object } = yield* Effect.try({
      try: () => {
        const decoded = Schema.decodeUnknownOption(ResolvedNode)(value);
        if (decoded._tag === "None") throw new Error("Credential target binding unavailable");
        return decoded.value;
      },
      catch: (error) =>
        error instanceof Error ? error : new Error("Credential target binding unavailable"),
    });
    return object.objectId === undefined
      ? undefined
      : { sessionId: found.sessionId, objectId: object.objectId };
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
      if (bound === undefined) return false;
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
      return (
        (yield* Effect.try({
          try: () => resultOf(value),
          catch: (error) =>
            error instanceof Error ? error : new Error("Credential insertion unavailable"),
        })).value === true
      );
    }),
});
