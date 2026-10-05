import { Schema } from "effect";

/** Patchright's existing isolated locator-evaluation world, also used by private native typing. */
export const kernelPlaywrightUtilityWorld = "utility";

/** The DevTools messages the browser recorder reads. Each is decoded before it is trusted. */
const Id = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256));
const TargetInfo = Schema.Struct({
  targetId: Id,
  type: Schema.String,
  url: Schema.String,
  browserContextId: Schema.optionalWith(Id, { exact: true }),
  /** A dedicated worker's owning frame. */
  parentFrameId: Schema.optionalWith(Id, { exact: true }),
});
export const Attached = Schema.Struct({
  sessionId: Id,
  targetInfo: TargetInfo,
  waitingForDebugger: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export const TargetResult = Schema.Struct({ targetInfo: TargetInfo });
export const TargetsResult = Schema.Struct({ targetInfos: Schema.Array(TargetInfo) });
export const Detached = Schema.Struct({ sessionId: Id });
export const TargetDestroyed = Schema.Struct({ targetId: Id });
/**
 * Chromium's renderer termination status (`crashed`, `killed`, `oom`, ...) and exit code, which
 * tell a renderer that ran out of memory from one killed or crashed for another reason.
 */
export const TargetCrashed = Schema.Struct({
  targetId: Id,
  status: Schema.optionalWith(Schema.String, { exact: true }),
  errorCode: Schema.optionalWith(Schema.Int, { exact: true }),
});
export const CloseResult = Schema.Struct({ success: Schema.Boolean });

const Response = Schema.Struct({ status: Schema.Int.pipe(Schema.between(100, 599)) });
export const NetworkRequest = Schema.Struct({
  requestId: Id,
  frameId: Schema.optionalWith(Id, { exact: true }),
  type: Schema.optionalWith(Schema.String, { exact: true }),
  request: Schema.Struct({
    url: Schema.String,
    urlFragment: Schema.optionalWith(Schema.String, { exact: true }),
    method: Schema.String.pipe(Schema.maxLength(32)),
    postData: Schema.optionalWith(Schema.String, { exact: true }),
    hasPostData: Schema.optionalWith(Schema.Boolean, { exact: true }),
    postDataEntries: Schema.optionalWith(Schema.Array(Schema.Unknown), { exact: true }),
  }),
  redirectResponse: Schema.optionalWith(Response, { exact: true }),
  // Read on its own, so an initiator of an unexpected shape never loses the request.
  initiator: Schema.optionalWith(Schema.Unknown, { exact: true }),
});
export type NetworkRequest = typeof NetworkRequest.Type;
export const NetworkResponse = Schema.Struct({ requestId: Id, response: Response });
export const NetworkCompletion = Schema.Struct({ requestId: Id });

interface FrameTree {
  readonly frame: {
    readonly id: string;
    readonly parentId?: string;
    readonly url?: string;
    readonly urlFragment?: string;
  };
  readonly childFrames?: readonly FrameTree[];
}
const FrameTree: Schema.Schema<FrameTree> = Schema.suspend(() =>
  Schema.Struct({
    frame: Schema.Struct({
      id: Id,
      parentId: Schema.optionalWith(Id, { exact: true }),
      url: Schema.optionalWith(Schema.String, { exact: true }),
      urlFragment: Schema.optionalWith(Schema.String, { exact: true }),
    }),
    childFrames: Schema.optionalWith(Schema.Array(FrameTree), { exact: true }),
  }),
);
export const FrameTreeResult = Schema.Struct({ frameTree: FrameTree });
export const FrameAttached = Schema.Struct({ frameId: Id, parentFrameId: Id });
export const FrameNavigated = Schema.Struct({
  frame: Schema.Struct({
    id: Id,
    parentId: Schema.optional(Id),
    url: Schema.optional(Schema.String),
    urlFragment: Schema.optional(Schema.String),
  }),
});
export const NavigatedWithinDocument = Schema.Struct({ frameId: Id, url: Schema.String });
export const FrameDetached = Schema.Struct({
  frameId: Id,
  reason: Schema.optional(Schema.Literal("remove", "swap")),
});
