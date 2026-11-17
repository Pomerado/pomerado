import { Cause, Effect, Either, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { InputAnswers, InputRequest } from "../../src/runtime/input-request.js";
import {
  makeScriptInput,
  type ScriptOption,
  type ScriptQuestionDeclarations,
} from "../../src/runtime/script-input.js";
import { asksAsDeclared } from "../../src/execution/declared-questions.js";
import {
  keptScriptAnswers,
  reusedScriptAnswers,
  scriptQuestionKeys,
} from "../../src/mint/script-answer-reuse.js";

const questions: ScriptQuestionDeclarations = {
  pick: { type: "choice", prompt: "Which entry?" },
  picks: { type: "multi_choice", prompt: "Which entries?" },
};

/** Asks one choice with `options`, answers it with `answer`, and returns what each side saw. */
const ask = (
  options: ReadonlyArray<ScriptOption>,
  answer: (request: InputRequest) => InputAnswers = (request) => {
    const first = request.questions[0];
    return { pick: first?.type === "choice" ? (first.options[0]?.id ?? "") : "" };
  },
  id: "pick" | "picks" = "pick",
) => {
  const sent: InputRequest[] = [];
  const result = Effect.runSync(
    Effect.either(
      makeScriptInput(questions, (request) =>
        Effect.sync(() => {
          sent.push(request);
          return answer(request);
        }),
      ).ask({ [id]: { options } }),
    ),
  );
  const question = sent[0]?.questions[0];
  const offered =
    question?.type === "choice" || question?.type === "multi_choice" ? question.options : undefined;
  return { result, offered };
};

const picked = (optionId: string) => () => ({ pick: optionId });

describe("a script question's options", () => {
  it("accepts a long value and returns it unchanged", () => {
    const value = `entry:${"v".repeat(994)}`;
    const { result, offered } = ask([
      { value, label: "First" },
      { value: "second", label: "Second" },
    ]);
    expect(value).toHaveLength(1000);
    expect(offered?.map((option) => option.label)).toEqual(["First", "Second"]);
    expect(result).toEqual(Either.right({ pick: value }));
  });

  it("shortens a long label to 255 characters and an ellipsis", () => {
    const label = "Synthetic note ".repeat(20);
    const { result, offered } = ask([{ value: "first", label }]);
    expect(label).toHaveLength(300);
    expect(offered?.[0]?.label).toBe(`${label.slice(0, 255)}…`);
    expect(offered?.[0]?.label).toHaveLength(256);
    expect(result).toEqual(Either.right({ pick: "first" }));
  });

  it("keeps a label of exactly 256 characters as it is", () => {
    const label = "x".repeat(256);
    expect(ask([{ value: "first", label }]).offered?.[0]?.label).toBe(label);
  });

  it("never splits a character written as a surrogate pair", () => {
    // 254 letters put the pair at code units 254 and 255, across the 255 cut.
    const label = `${"a".repeat(254)}😀${"b".repeat(50)}`;
    const shown = ask([{ value: "first", label }]).offered?.[0]?.label;
    expect(shown).toBe(`${"a".repeat(254)}…`);
    expect(shown?.isWellFormed()).toBe(true);
  });

  it("shortens long labels of a multiple choice too", () => {
    const label = "y".repeat(400);
    const { result, offered } = ask(
      [
        { value: "first", label },
        { value: "second", label: "Second" },
      ],
      () => ({ picks: ["o1", "o2"] }),
      "picks",
    );
    expect(offered?.map((option) => option.label)).toEqual([`${"y".repeat(255)}…`, "Second"]);
    expect(result).toEqual(Either.right({ picks: ["first", "second"] }));
  });

  it("tells apart two labels that read the same once shortened, by the value behind each", () => {
    const shared = "Same opening words ".repeat(14);
    const options = [
      { value: "first", label: `${shared} then the first ending` },
      { value: "second", label: `${shared} then the second ending` },
    ];
    const { result, offered } = ask(options, picked("o2"));
    expect(offered).toEqual([
      { id: "o1", label: `${shared.slice(0, 255)}…` },
      { id: "o2", label: `${shared.slice(0, 255)}…` },
    ]);
    expect(result).toEqual(Either.right({ pick: "second" }));
  });

  it("tells the host which option is the caller's no to the write", () => {
    const { result, offered } = ask(
      [
        { value: "place", label: "Place order" },
        { value: "stop", label: "Stop", declines: true },
      ],
      picked("o2"),
    );
    expect(offered).toEqual([
      { id: "o1", label: "Place order" },
      { id: "o2", label: "Stop", declines: true },
    ]);
    expect(result).toEqual(Either.right({ pick: "stop" }));
  });

  it("still refuses an empty value or label, a repeated value, and a field options don't take", () => {
    const refused = Either.left(expect.objectContaining({ code: "InvalidOptions" }));
    const long = "z".repeat(300);
    expect(ask([{ value: "", label: "Empty value" }]).result).toEqual(refused);
    expect(ask([{ value: "first", label: "" }]).result).toEqual(refused);
    expect(
      ask([
        { value: "same", label: "First" },
        { value: "same", label: "Second" },
      ]).result,
    ).toEqual(refused);
    expect(
      ask([
        { value: long, label: "First" },
        { value: long, label: "Second" },
      ]).result,
    ).toEqual(refused);
    expect(
      ask([{ value: "first", label: "First", note: "extra" } as unknown as ScriptOption]).result,
    ).toEqual(refused);
  });
});

describe("a script question that can't be asked", () => {
  /** The failure's message, or undefined when the question was asked. */
  const refusal = (
    options: ReadonlyArray<unknown>,
    id: "pick" | "picks" = "pick",
  ): string | undefined => {
    const { result } = ask(options as ReadonlyArray<ScriptOption>, undefined, id);
    if (Either.isRight(result)) return undefined;
    expect(result.left).toMatchObject({ _tag: "ScriptInputFailure", code: "InvalidOptions" });
    return result.left.message;
  };
  const first = { value: "entry-first-7f3a", label: "First entry 7f3a" };
  const second = { value: "entry-second-9c1d", label: "Second entry 9c1d" };

  it.each([
    [
      "an empty value",
      [first, { value: "", label: "Third entry 2b6e" }],
      "Script question pick could not be asked because option 2 has an empty value.",
    ],
    [
      "an empty label",
      [{ value: "entry-third-2b6e", label: "" }, second],
      "Script question pick could not be asked because option 1 has an empty label.",
    ],
    [
      "a repeated value",
      [first, second, { value: first.value, label: "Third entry 2b6e" }],
      "Script question pick could not be asked because option 3 repeats another option's value.",
    ],
    [
      "a field options don't take",
      [first, { ...second, note: "Extra note 4d8f" }],
      "Script question pick could not be asked because option 2 has a field options do not take.",
    ],
  ])("names the question and the option with %s", (_, options, message) => {
    expect(refusal(options)).toBe(message);
  });

  it("says the same for a multiple choice", () => {
    expect(refusal([first, second, { ...first, label: "Again" }], "picks")).toBe(
      "Script question picks could not be asked because option 3 repeats another option's value.",
    );
  });

  it("names the first option that fails", () => {
    expect(refusal([first, { value: "", label: "" }, { value: "", label: "Third" }])).toBe(
      "Script question pick could not be asked because option 2 has an empty value.",
    );
  });

  it("never says an option's value or label", () => {
    const extra = { value: "entry-extra-5e0b", label: "Extra entry 5e0b", note: "Note 6a2c" };
    const cases = [
      [first, { value: "", label: "Empty value 1f9e" }],
      [first, { value: "entry-empty-label-3d7c", label: "" }],
      [first, second, { value: second.value, label: "Repeat 8b4a" }],
      [first, extra],
    ];
    for (const options of cases) {
      const message = refusal(options);
      expect(message).toMatch(/^Script question pick could not be asked because option \d /);
      const said = options.flatMap((option) => Object.values(option)).filter((text) => text !== "");
      for (const text of said) expect(message).not.toContain(text);
    }
  });

  it.each([
    [
      "a masked label over 64 characters",
      [first, { ...second, accountSpecific: true, maskedLabel: "Masked 3e8f ".repeat(7).trim() }],
      "Script question pick could not be asked because option 2's maskedLabel is 83 characters; the limit is 64.",
    ],
    [
      "an empty masked label",
      [{ ...first, accountSpecific: true, maskedLabel: "" }, second],
      "Script question pick could not be asked because option 1's maskedLabel is empty.",
    ],
    [
      "a value that is not text",
      [first, { value: 5, label: "Number value" }],
      "Script question pick could not be asked because option 2's value must be text.",
    ],
    [
      "a missing label",
      [first, { value: "entry-third-2b6e" }],
      "Script question pick could not be asked because option 2's label is missing.",
    ],
    [
      "a flag that is not a boolean",
      [first, { ...second, declines: "yes" }],
      "Script question pick could not be asked because option 2's declines must be true or false.",
    ],
    [
      "an option that is text",
      [first, "entry-text"],
      "Script question pick could not be asked because option 2 must be an object.",
    ],
    [
      "an option that is a list",
      [first, ["entry-list"]],
      "Script question pick could not be asked because option 2 must be an object.",
    ],
    [
      "no options at all",
      [],
      "Script question pick could not be asked because options is empty.",
    ],
    [
      "more than 50 options",
      Array.from({ length: 51 }, (_, index) => ({ value: `v${index}`, label: `L${index}` })),
      "Script question pick could not be asked because options has 51 entries; the limit is 50.",
    ],
  ])("names the field and the rule for %s", (_, options, message) => {
    expect(refusal(options)).toBe(message);
  });

  it("never says a masked label, value or label it refuses", () => {
    const masked = "Masked label 8c1f ".repeat(5);
    const message = refusal([first, { ...second, accountSpecific: true, maskedLabel: masked }]);
    expect(message).toMatch(/maskedLabel is 90 characters; the limit is 64\.$/);
    for (const text of [masked, masked.trim(), "8c1f", second.value, second.label])
      expect(message).not.toContain(text);
  });

  /** The failure's message for an ask that is refused before it reaches the caller. */
  const refused = (
    declared: ScriptQuestionDeclarations,
    asked: Parameters<ReturnType<typeof makeScriptInput>["ask"]>[0],
  ) => {
    const result = Effect.runSync(
      Effect.either(makeScriptInput(declared, () => Effect.succeed({})).ask(asked)),
    );
    if (Either.isRight(result)) throw new Error("the ask was not refused");
    expect(result.left).toMatchObject({ _tag: "ScriptInputFailure", code: "InvalidOptions" });
    return result.left.message;
  };

  it.each([
    [
      "a choice given no options",
      { pick: {} },
      "Script question pick could not be asked because it has no options.",
    ],
    [
      "options that are not a list",
      { pick: { options: "entry-text" } },
      "Script question pick could not be asked because options must be a list.",
    ],
    [
      "options given to a text question",
      { note: { options: [first] } },
      "Script question note could not be asked because a text question takes no options.",
    ],
    [
      "a label given to a question that is not a site field",
      { pick: { label: "Engraving", options: [first] } },
      "Script question pick could not be asked because only a site field takes a label.",
    ],
    [
      "a site field with an empty label",
      { extra: { label: "  " } },
      "Script question extra could not be asked because its label is missing or empty.",
    ],
    [
      "more selections needed than options offered",
      { three: { options: [first, second] } },
      "Script question three could not be asked because minSelections is 3 but at most 2 can be selected.",
    ],
    [
      "a hand-off asked with another question",
      { handoff: {}, note: {} },
      "Script questions handoff, note could not be asked because the request breaks the rule that a browser hand-off is the only question of a script's or the host's request.",
    ],
  ])("names the rule for %s", (_, asked, message) => {
    const declared: ScriptQuestionDeclarations = {
      ...questions,
      note: { type: "text", prompt: "Any note?" },
      extra: { type: "site_field" },
      three: { type: "multi_choice", prompt: "Which three?", minSelections: 3 },
      handoff: { type: "browser_handoff", prompt: "Review the form." },
    };
    expect(refused(declared, asked as never)).toBe(message);
  });

  it("names the limit for more than eight questions in one ask", () => {
    const ids = Array.from({ length: 9 }, (_, index) => `q${index + 1}`);
    const declared = Object.fromEntries(
      ids.map((id) => [id, { type: "text" as const, prompt: "Which entry?" }]),
    );
    expect(refused(declared, ids)).toBe(
      `Script questions ${ids.join(", ")} could not be asked because questions has 9 entries; the limit is 8.`,
    );
  });

  it("no longer fails on a label over 256 characters, which reaches the caller shortened", () => {
    expect(refusal([{ value: "first", label: "l".repeat(400) }])).toBeUndefined();
  });

  it("prints its message where Effect renders the failure", () => {
    const exit = Effect.runSyncExit(
      makeScriptInput(questions, () => Effect.succeed({})).ask({
        pick: { options: [first, { value: "", label: "Third entry 2b6e" }] },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const printed = Cause.pretty(exit.cause);
      expect(printed).toContain(
        "ScriptInputFailure: Script question pick could not be asked because option 2 has an empty value.",
      );
      expect(printed).not.toContain("An error has occurred");
    }
  });
});

describe("a site-field question's label", () => {
  const declared: ScriptQuestionDeclarations = {
    extra: { type: "site_field" },
    pick: { type: "choice", prompt: "Which entry?" },
  };
  /** What the script input sends for `asked`, or why it sent nothing. */
  const sent = (asked: Parameters<ReturnType<typeof makeScriptInput>["ask"]>[0]) => {
    const requests: InputRequest[] = [];
    const result = Effect.runSync(
      Effect.either(
        makeScriptInput(declared, (request) =>
          Effect.sync(() => {
            requests.push(request);
            const [question] = request.questions;
            return { extra: question?.type === "choice" ? (question.options[0]?.id ?? "") : "J.D." };
          }),
        ).ask(asked),
      ),
    );
    return { result, question: requests[0]?.questions[0] };
  };

  it("asks the page's label as the prompt and returns the answer, or the picked option's value", () => {
    expect(sent({ extra: { label: "  Engraving text " } })).toEqual({
      result: Either.right({ extra: "J.D." }),
      question: { id: "extra", type: "text", prompt: "Engraving text" },
    });
    const { result } = sent({ extra: { label: "Engraving", options: [{ value: "initials-value", label: "Initials" }] } });
    expect(result).toEqual(Either.right({ extra: "initials-value" }));
  });

  // A form's own question can have a long label and long choices, such as legal wording. The
  // caller reads the label whole, and the full text of a choice cut to fit its label.
  it("asks a long label whole, with each option cut to fit its label in full after it", () => {
    const label = "Synthetic consent wording ".repeat(20).trim();
    const long = "Synthetic choice wording ".repeat(15).trim();
    const saved = "Synthetic saved detail ".repeat(15).trim();
    expect(sent({ extra: { label: "x".repeat(2100) } }).question?.prompt).toBe(`${"x".repeat(1999)}…`);
    expect(
      sent({
        extra: {
          label,
          options: [
            { value: "short", label: "Short choice" },
            { value: "long", label: long },
            // Its label shows only on the protected page, so the prompt never repeats it.
            { value: "saved", label: saved, accountSpecific: true, maskedLabel: "Saved detail" },
          ],
        },
      }).question,
    ).toEqual({
      id: "extra",
      type: "choice",
      prompt: `${label}\n\nOption 2 in full: ${long}`,
      options: [
        { id: "o1", label: "Short choice" },
        { id: "o2", label: `${long.slice(0, 255)}…` },
        { id: "o3", label: `${saved.slice(0, 255)}…`, accountSpecific: true, maskedLabel: "Saved detail" },
      ],
    });
    const short = sent({ extra: { label: "Engraving", options: [{ value: "a", label: "Initials" }] } });
    expect(short.question).toEqual({ id: "extra", type: "choice", prompt: "Engraving", options: [{ id: "o1", label: "Initials" }] });
  });

  it("refuses a missing or empty label, and a label on a question that is not a site field", () => {
    const refused = Either.left(expect.objectContaining({ code: "InvalidOptions" }));
    expect(sent("extra").result).toEqual(refused);
    expect(sent({ extra: { label: "   " } }).result).toEqual(refused);
    expect(
      sent({ pick: { label: "Engraving", options: [{ value: "a", label: "A" }] } as never }).result,
    ).toEqual(refused);
  });
});

describe("a purchase confirm's order", () => {
  it("reaches the request in fixed words while the account option stays masked, and nothing else does", () => {
    const declared: ScriptQuestionDeclarations = {
      confirm_order: { type: "choice", prompt: "Place this order?" },
      note: { type: "text", prompt: "Any note?" },
    };
    const options: ReadonlyArray<ScriptOption> = [
      {
        value: "place",
        label: "Synthetic Street 1 | Card 0000",
        accountSpecific: true,
        maskedLabel: "Saved card",
      },
      { value: "cancel", label: "Cancel" },
    ];
    const order = {
      currency: "USD",
      items: [{ name: "Synthetic cable", quantity: 2, price: "4.50" }],
      shipping: "0.00",
      tax: "0.81",
      total: "9.81",
    };
    const asked = (given: unknown) => {
      const sent: InputRequest[] = [];
      const result = Effect.runSync(
        Effect.either(
          makeScriptInput(declared, (request) =>
            Effect.sync(() => {
              sent.push(request);
              return { confirm_order: "o1" };
            }),
          ).ask({ confirm_order: { options, order: given } } as never),
        ),
      );
      return { result, request: sent[0] };
    };

    const { result, request } = asked(order);
    expect(result).toEqual(Either.right({ confirm_order: "place" }));
    if (request === undefined) throw new Error("the order was not asked");
    expect(request.notice).toBe(
      'Order: 2 × "Synthetic cable" at 4.50 USD each. Shipping: 0.00 USD. Tax: 0.81 USD. Total: 9.81 USD.',
    );
    expect(request.questions[0]).toMatchObject({
      options: [
        { id: "o1", accountSpecific: true, maskedLabel: "Saved card" },
        { id: "o2", label: "Cancel" },
      ],
    });
    expect(asksAsDeclared(request, declared)).toBe(true);
    const added = { ...request, notice: `${request.notice} Ship to Synthetic Street 1.` };
    expect(asksAsDeclared(added, declared)).toBe(false);
    const note = { id: "note", type: "text", prompt: "Any note?" } as const;
    expect(asksAsDeclared({ ...request, questions: [note] }, declared)).toBe(false);

    // A purchase confirm is asked again, the identical order included: one yes buys once.
    const keys = Effect.runSync(scriptQuestionKeys(request, Effect.succeed));
    const yes = { confirm_order: { type: "choice" as const, value: "o1" } };
    expect(reusedScriptAnswers(request, keys, keptScriptAnswers([], keys, yes))).toBeUndefined();

    const refused = asked({ ...order, address: "Synthetic Street 1" });
    expect(refused.result).toEqual(Either.left(expect.objectContaining({ code: "InvalidOptions" })));
    expect(refused.request).toBeUndefined();
  });

  describe("that can't be asked", () => {
    const declared: ScriptQuestionDeclarations = {
      confirm_order: { type: "choice", prompt: "Place this order?" },
      confirm_again: { type: "confirm", prompt: "Place it now?" },
      note: { type: "text", prompt: "Any note?" },
    };
    const options = [
      { value: "place", label: "Place order" },
      { value: "cancel", label: "Cancel", declines: true },
    ];
    const order = {
      currency: "USD",
      items: [{ name: "Synthetic cable", quantity: 2, price: "4.50" }],
      total: "9.00",
    };
    /** The failure's message for an ask whose order is refused. */
    const refusal = (asked: unknown) => {
      const result = Effect.runSync(
        Effect.either(makeScriptInput(declared, () => Effect.succeed({})).ask(asked as never)),
      );
      if (Either.isRight(result)) throw new Error("the order was not refused");
      expect(result.left).toMatchObject({ _tag: "ScriptInputFailure", code: "InvalidOptions" });
      return result.left.message;
    };
    const because = (reason: string) =>
      `Script question confirm_order could not be asked because ${reason}.`;

    it.each([
      [
        "a field an order does not take",
        { ...order, address: "Synthetic Street 1" },
        because("order has a field it does not take: address"),
      ],
      [
        "a field an item does not take",
        { ...order, items: [{ ...order.items[0], sku: "SKU-0000" }] },
        because("order.items[0] has a field it does not take: sku"),
      ],
      [
        "a field whose name is not a plain name",
        { ...order, "Synthetic Street 1": true },
        because("order has a field it does not take"),
      ],
      ["a missing total", { currency: "USD", items: order.items }, because("order.total is missing")],
      [
        "an amount that is not decimal text",
        { ...order, total: "$9.00" },
        because("order.total must be a string matching the pattern ^\\d{1,9}(?:\\.\\d{1,3})?$"),
      ],
      [
        "an amount that is a number",
        { ...order, items: [{ ...order.items[0], price: 4.5 }] },
        because("order.items[0].price must be text"),
      ],
      [
        "a unit it does not know",
        { ...order, items: [{ ...order.items[0], unit: "stone" }] },
        because(
          'order.items[0].unit must be one of "g", "kg", "mg", "oz", "lb", "ml", "L", "fl oz", "pt", "qt", "gal", "mm", "cm", "m", "in", "ft", "yd"',
        ),
      ],
      [
        "an item with neither a price nor a line total",
        { ...order, items: [{ name: "Synthetic cable", quantity: 2 }] },
        because(
          "order.items breaks the rule that each item has a price or line total, and a whole quantity unless a unit",
        ),
      ],
      [
        "more than 20 items",
        { ...order, items: Array.from({ length: 21 }, () => order.items[0]) },
        because("order.items has 21 entries; the limit is 20"),
      ],
      ["an order that is not an object", "Synthetic order", because("order must be an object")],
    ])("names the field and the rule for %s", (_, given, message) => {
      expect(refusal({ confirm_order: { options, order: given } })).toBe(message);
    });

    it("names the one-order rule", () => {
      expect(
        refusal({ confirm_order: { options, order }, confirm_again: { order } }),
      ).toBe(
        "Script question confirm_again could not be asked because only one question in an ask may carry an order.",
      );
      expect(refusal({ note: { order } })).toBe(
        "Script question note could not be asked because a text question takes no order; only a choice or a confirm does.",
      );
    });

    it("never says an item's name or an amount it refuses", () => {
      const message = refusal({
        confirm_order: {
          options,
          order: { ...order, items: [{ name: "Synthetic name 4c2d", quantity: 2, price: "$4.50" }] },
        },
      });
      expect(message).toMatch(/^Script question confirm_order could not be asked because order\.items\[0\]\.price /);
      for (const text of ["4c2d", "$4.50"]) expect(message).not.toContain(text);
    });
  });
});
