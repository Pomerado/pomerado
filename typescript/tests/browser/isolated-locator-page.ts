import { randomUUID } from "node:crypto";
import type { CDPSession, Frame, Locator, Page } from "playwright";
import { kernelPlaywrightUtilityWorld } from "../../src/destinations/cdp-contracts.js";

const boundMember = (target: object, property: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, property);
  const bound: unknown = typeof value === "function" ? value.bind(target) : value;
  return bound;
};

const runEvaluation = async (
  cdp: CDPSession,
  objectId: string,
  fn: unknown,
  arg: unknown,
): Promise<unknown> => {
  if (typeof fn !== "function") throw new Error("Fixture evaluator requires a function");
  try {
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(arg) { return (${String(fn)})(this, arg); }`,
      arguments: [{ value: arg }],
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) throw new Error("Fixture evaluation failed");
    return result.result.value;
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId });
  }
};

/** Patchright's locator evaluation defaults to an isolated world; its fourth argument selects main. */
export const isolatedLocatorPage = async (page: Page) => {
  const sessions = new Map<Frame, CDPSession>();
  const originals = new WeakMap<Page | Frame, Page | Frame>();
  const pages = new WeakMap<Page, Page>();
  const frames = new WeakMap<Frame, Frame>();
  const sessionFor = async (frame: Frame) => {
    const existing = sessions.get(frame);
    if (existing !== undefined) return existing;
    const cdp = await page
      .context()
      .newCDPSession(frame)
      .catch((error: unknown) => {
        if (
          !(error instanceof Error) ||
          !error.message.includes("does not have a separate CDP session")
        )
          throw error;
        return page.context().newCDPSession(frame.page());
      });
    sessions.set(frame, cdp);
    return cdp;
  };
  const evaluate = async (
    locator: Locator,
    frame: Frame,
    fn: unknown,
    arg: unknown,
  ): Promise<unknown> => {
    const cdp = await sessionFor(frame);
    const key = `data-fixture-${randomUUID()}`;
    await locator.evaluate((element, marker) => element.setAttribute(marker, ""), key);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const pending = [{ node: root, frameId: frameTree.frame.id }];
    let found: { backendNodeId: number; frameId: string } | undefined;
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined) break;
      const { node, frameId } = next;
      if (node.attributes?.includes(key)) found = { backendNodeId: node.backendNodeId, frameId };
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])])
        pending.push({ node: child, frameId });
      if (node.contentDocument !== undefined) {
        if (node.frameId === undefined) throw new Error("Fixture frame missing");
        pending.push({ node: node.contentDocument, frameId: node.frameId });
      }
    }
    await locator.evaluate((element, marker) => element.removeAttribute(marker), key);
    if (found === undefined) throw new Error("Fixture element missing");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: found.frameId,
      worldName: kernelPlaywrightUtilityWorld,
    });
    const { object } = await cdp.send("DOM.resolveNode", {
      backendNodeId: found.backendNodeId,
      executionContextId,
    });
    if (object.objectId === undefined) throw new Error("Fixture element unresolved");
    return runEvaluation(cdp, object.objectId, fn, arg);
  };
  const locatorView = (locator: Locator, frame: Frame): Locator =>
    new Proxy(locator, {
      get: (target, property) => {
        if (property === "evaluate")
          return (fn: unknown, arg: unknown, options: unknown, isolatedContext = true): unknown => {
            if (isolatedContext) return evaluate(target, frame, fn, arg);
            const mainEvaluate = boundMember(target, property);
            if (typeof mainEvaluate !== "function") throw new Error("Fixture evaluator missing");
            const result: unknown = Reflect.apply(mainEvaluate, target, [fn, arg, options]);
            return result;
          };
        if (property === "nth") return (index: number) => locatorView(target.nth(index), frame);
        return boundMember(target, property);
      },
    });
  const frameView = (frame: Frame): Frame => {
    const existing = frames.get(frame);
    if (existing !== undefined) return existing;
    const view = new Proxy(frame, {
      get: (target, property) => {
        if (property === "locator")
          return (selector: string) => locatorView(target.locator(selector), target);
        return boundMember(target, property);
      },
    });
    frames.set(frame, view);
    originals.set(view, frame);
    return view;
  };
  const context = page.context();
  const contextView = new Proxy(context, {
    get: (target, property) => {
      if (property === "pages") return () => target.pages().map(pageView);
      if (property === "newCDPSession")
        return (subject: Page | Frame) => target.newCDPSession(originals.get(subject) ?? subject);
      return boundMember(target, property);
    },
  });
  const pageView = (actual: Page): Page => {
    const existing = pages.get(actual);
    if (existing !== undefined) return existing;
    const view = new Proxy(actual, {
      get: (target, property) => {
        if (property === "frames") return () => target.frames().map(frameView);
        if (property === "opener")
          return async () => {
            const opener = await target.opener();
            return opener === null ? null : pageView(opener);
          };
        if (property === "context") return () => contextView;
        return boundMember(target, property);
      },
    });
    pages.set(actual, view);
    originals.set(view, actual);
    return view;
  };
  return {
    page: pageView(page),
    close: () => Promise.all([...sessions.values()].map((cdp) => cdp.detach())),
  };
};
