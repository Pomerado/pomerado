import { createHash } from "node:crypto";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  acceptedConfirmsKept,
  confirmActionUnmatched,
  expectedConfirmDigest,
  expectedConfirmLimit,
  keepAcceptedConfirm,
  makeExpectedConfirms,
  observedConfirmOf,
  recordConfirmSteps,
  type ObservedConfirm,
} from "../../src/browser/dialogs/expected.js";
import type { ExpectedConfirm } from "../../src/browser/dialogs/contracts.js";

const confirm = { type: "confirm" as const, candidateActionId: "place-order" };
const facts = { message: "Place this order?", pageUrl: "https://shop.example/cart?step=2" };

describe("observedConfirmOf", () => {
  it("keeps a confirm's normalized message, page origin and step", () => {
    expect(
      observedConfirmOf(confirm, { ...facts, message: "  Place\n this  order? " }),
    ).toEqual({ message: "Place this order?", origin: "https://shop.example", step: "place-order" });
  });

  it("never observes a popup a run could not expect", () => {
    const cases = [
      [{ ...confirm, type: "alert" as const }, facts],
      [{ ...confirm, type: "prompt" as const }, facts],
      [{ ...confirm, candidateActionId: null }, facts],
      [{ ...confirm, candidateActionId: "place order" }, facts],
      [{ ...confirm, candidateActionId: "x".repeat(101) }, facts],
      [confirm, { ...facts, pageUrl: "http://shop.example/cart" }],
      [confirm, { ...facts, pageUrl: "not a url" }],
      [confirm, { ...facts, message: " \n " }],
      [confirm, { ...facts, message: "x".repeat(2_001) }],
    ] as const;
    for (const [event, shown] of cases) expect(observedConfirmOf(event, shown)).toBeUndefined();
    expect(observedConfirmOf(confirm, { ...facts, message: "x".repeat(2_000) })).toBeDefined();
  });
});

describe("expectedConfirmDigest", () => {
  it("is the SHA-256 of the versioned message, origin and step, never the text itself", () => {
    const popup = { message: "Place this order?", origin: "https://shop.example", step: "s" };
    expect(expectedConfirmDigest(popup)).toEqual({
      digest: createHash("sha256")
        .update(JSON.stringify(["pomerado.expected_confirm.v1", popup.message, popup.origin, "s"]))
        .digest("hex"),
    });
    expect(JSON.stringify(expectedConfirmDigest(popup))).not.toContain("Place");
  });
});

describe("makeExpectedConfirms", () => {
  const record = expectedConfirmDigest({
    message: "Place this order?",
    origin: "https://shop.example",
    step: "place-order",
  });

  it("takes a matching popup once per record, whatever its whitespace", () => {
    const pool = makeExpectedConfirms([record]);
    expect(pool.take(confirm, { ...facts, message: "Place  this order?" })).toEqual(record);
    expect(pool.take(confirm, facts)).toBeUndefined();
    const twice = makeExpectedConfirms([record, record]);
    expect(twice.take(confirm, facts)).toEqual(record);
    expect(twice.take(confirm, facts)).toEqual(record);
  });

  it("matches no other message, case, origin, step or type", () => {
    const pool = makeExpectedConfirms([record]);
    expect(pool.take(confirm, { ...facts, message: "place this order?" })).toBeUndefined();
    expect(pool.take(confirm, { ...facts, message: "Place this order now?" })).toBeUndefined();
    expect(pool.take(confirm, { ...facts, pageUrl: "https://other.example/cart" })).toBeUndefined();
    expect(pool.take({ ...confirm, candidateActionId: "remove-item" }, facts)).toBeUndefined();
    expect(pool.take({ ...confirm, type: "alert" }, facts)).toBeUndefined();
    expect(pool.take(confirm, facts)).toEqual(record);
  });
});

describe("recording accepted confirms", () => {
  it("keeps only accepted confirms a run could expect, up to the limit", () => {
    const live: ObservedConfirm[] = [];
    keepAcceptedConfirm(live, { event: confirm, facts, decision: { choice: "dismiss" } });
    keepAcceptedConfirm(live, {
      event: { ...confirm, type: "alert" },
      facts,
      decision: { choice: "accept" },
    });
    keepAcceptedConfirm(live, { event: confirm, facts, decision: { choice: "accept" } });
    expect(live).toEqual([
      { message: "Place this order?", origin: "https://shop.example", step: "place-order" },
    ]);
    for (let index = 0; index < expectedConfirmLimit + 5; index += 1)
      keepAcceptedConfirm(live, { event: confirm, facts, decision: { choice: "accept" } });
    expect(live).toHaveLength(expectedConfirmLimit);
  });

  it("keeps a write's confirms unless screening finds a registered secret or fails", async () => {
    const accepted = [
      { message: "Place this order?", origin: "https://shop.example", step: "a" },
      { message: "Charge card 4242?", origin: "https://shop.example", step: "b" },
      { message: "Unscreened?", origin: "https://shop.example", step: "c" },
    ];
    const unscreened: string[] = [];
    const kept = (write: boolean) =>
      Effect.runPromise(
        acceptedConfirmsKept({
          write,
          accepted,
          screen: (message) =>
            message.includes("4242")
              ? Effect.fail("invalid_text")
              : message.startsWith("Unscreened")
                ? Effect.fail("closed_scope")
                : Effect.void,
          unscreened: (error) =>
            Effect.sync(() => {
              unscreened.push(error);
            }),
        }),
      );
    expect(await kept(false)).toEqual([]);
    expect(unscreened).toEqual([]);
    expect(await kept(true)).toEqual([accepted[0]]);
    expect(unscreened.toSorted()).toEqual(["closed_scope", "invalid_text"]);
  });

  it("adds a step's kept confirms to its write session as digests and step names", () => {
    const session = { acceptedConfirms: [] as ExpectedConfirm[], confirmSteps: new Set<string>() };
    const confirms = [
      { message: "Place this order?", origin: "https://shop.example", step: "place-order" },
      { message: "Really place it?", origin: "https://shop.example", step: "place-order" },
    ];
    recordConfirmSteps(session, confirms);
    expect(session.acceptedConfirms).toEqual(confirms.map(expectedConfirmDigest));
    expect([...session.confirmSteps]).toEqual(["place-order"]);
  });
});

describe("confirmActionUnmatched", () => {
  const check = (steps: readonly string[], sources: readonly string[]) =>
    Effect.runPromise(Effect.either(confirmActionUnmatched(steps, sources)));

  it("passes a composed write that names each confirm step as a quoted literal", async () => {
    expect(await check([], [])).toEqual(Either.right(undefined));
    expect(
      await check(
        ["place-order", "pay", "confirm_gift"],
        [`decideDialog({ step: "place-order" })`, "const step = 'pay';", "`confirm_gift`"],
      ),
    ).toEqual(Either.right(undefined));
  });

  it("refuses a composed write that does not, naming each missing step", async () => {
    const refused = await check(["place-order", "pay"], ["decideDialog({ step: placeOrder })"]);
    expect(Either.isLeft(refused) && refused.left).toMatchObject({
      _tag: "MintFailure",
      code: "PublicationUnavailable",
      reason: "confirm_action_unmatched",
      confirmActionIds: ["place-order", "pay"],
    });
  });
});
