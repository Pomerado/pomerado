// Failure modes covered: a later step reuses an answer to a question that matches by id alone or
// has another id, to one whose follow-up changed, to a code, secret, login or payment card
// question, no longer valid for the question as asked, or after the owner answered its prompt
// anew; the same question asked again, or long after the owner answered, asks the owner again; a
// reuse changes the answer's shape; a host reading kept answers back decodes one it cannot read,
// or refuses one an earlier release kept with more fields; a purchase confirm asks again for the
// same order its owner said yes to, or reuses a yes to another order, a no, another job's yes or
// a yes after a commit step ran.
import { Effect, Either, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  forgetOrderAnswers,
  forgetScriptAnswers,
  KeptScriptAnswer,
  keptScriptAnswers,
  repeatedScriptAnswers,
  reusedScriptAnswers,
  scriptQuestionKeys,
  validateKeptAnswers,
} from "../../src/mint/script-answer-reuse.js";
import type { AnsweredQuestion, QuestionDecision } from "../../src/guardian/question.js";
import type { InputRequest, ValidAnswers } from "../../src/runtime/input-request.js";

const request = (questions: InputRequest["questions"]): InputRequest => ({
  id: "request",
  source: "script",
  questions,
});
const choice = {
  id: "plan",
  type: "choice" as const,
  prompt: "Which plan do you have?",
  options: [
    { id: "gold", label: "Gold" },
    { id: "silver", label: "Silver" },
  ],
};
const plan = request([choice]);
const gold: ValidAnswers = { plan: { type: "choice", value: "gold" } };
const keys = (asked: InputRequest) =>
  Effect.runSync(scriptQuestionKeys(asked, (text) => Effect.succeed(text)));
const kept = (asked: InputRequest, answers: ValidAnswers) =>
  keptScriptAnswers([], keys(asked), answers);
const reuse = (asked: InputRequest, entries: readonly KeptScriptAnswer[]) =>
  reusedScriptAnswers(asked, keys(asked), entries);

describe("a later step's script question", () => {
  it("reuses the owner's answer in a fresh answer's shape, a refusal as a refusal", () => {
    expect(reuse(plan, kept(plan, gold))).toEqual(gold);
    const approve = request([{ id: "approve", type: "confirm", prompt: "Approve the terms?" }]);
    const declined: ValidAnswers = { approve: { type: "confirm", value: { confirmed: false } } };
    expect(reuse(approve, kept(approve, declined))).toEqual(declined);
  });

  it("reuses an answer as often as the question comes back, and keeps it until replaced", () => {
    const entries = kept(plan, gold);
    // Reusing leaves the kept answer in place, so every later ask of the same question reuses it.
    for (let ask = 0; ask < 3; ask++) expect(reuse(plan, entries)).toEqual(gold);
    // A kept answer carries no time and no step, so neither age nor the asking step ends it.
    expect(entries).toEqual([{ question: keys(plan)[0], answer: gold["plan"] }]);
    // Only a newer answer to the same prompt replaces it; another prompt's answer keeps it.
    expect(keptScriptAnswers(entries, keys(request([])), {})).toEqual(entries);
  });

  it("never keeps or reuses an answer to a code, a secret or a login", () => {
    const secrets = request([
      { id: "code", type: "secret", secretKind: "one_time_code", prompt: "Which code?" },
      { id: "pin", type: "secret", secretKind: "private_text", prompt: "What is your PIN?" },
      {
        id: "login",
        type: "credential",
        prompt: "Sign in to the site",
        fields: "username_password",
        reason: "missing_credentials",
        allowSave: false,
        siteOrigin: "https://example.com",
      },
    ]);
    const answers: ValidAnswers = {
      code: { type: "secret", value: "246810" },
      pin: { type: "secret", value: "1357" },
      login: { type: "credential", value: { username: "a", password: "b", saveLogin: false } },
    };
    expect(keys(secrets)).toEqual([undefined, undefined, undefined]);
    expect(kept(secrets, answers)).toEqual([]);
    expect(reuse(secrets, kept(secrets, answers))).toBeUndefined();
    // One protected question in a request asks the whole request again.
    const mixed = request([choice, ...secrets.questions.slice(0, 1)]);
    expect(reuse(mixed, kept(mixed, { ...gold, code: answers["code"]! }))).toBeUndefined();
  });

  it("never keeps or reuses a part of a payment card, which is asked again every time", () => {
    const card = request([
      { id: "number", type: "secret", secretKind: "card_number", prompt: "Card number?" },
      { id: "expiry", type: "secret", secretKind: "card_expiry", prompt: "Expiry?" },
      { id: "cvc", type: "secret", secretKind: "card_cvc", prompt: "Security code?" },
      { id: "zip", type: "secret", secretKind: "billing_postal_code", prompt: "Billing ZIP?" },
    ]);
    const answers: ValidAnswers = {
      number: { type: "secret", value: "4242424242424242" },
      expiry: { type: "secret", value: "12/34" },
      cvc: { type: "secret", value: "123" },
      zip: { type: "secret", value: "94110" },
    };
    expect(keys(card)).toEqual([undefined, undefined, undefined, undefined]);
    expect(kept(card, answers)).toEqual([]);
    expect(reuse(card, kept(card, answers))).toBeUndefined();
  });

  it("matches the id, type, prompt, options and a confirm's follow-up", () => {
    const entries = kept(plan, gold);
    for (const changed of [
      { ...choice, id: "tier" },
      { ...choice, type: "multi_choice" as const, minSelections: 1, maxSelections: 1 },
      { ...choice, prompt: "Which plan should the booking use?" },
      { ...choice, options: [...choice.options, { id: "bronze", label: "Bronze" }] },
      {
        ...choice,
        options: [
          { id: "gold", label: "Gold plan" },
          { id: "silver", label: "Silver" },
        ],
      },
    ])
      expect(reuse(request([changed]), entries)).toBeUndefined();
    const confirm = { id: "approve", type: "confirm" as const, prompt: "Approve the terms?" };
    const withNote = { ...confirm, followUp: { prompt: "Anything to add?" } };
    const yes: ValidAnswers = { approve: { type: "confirm", value: { confirmed: true } } };
    expect(reuse(request([withNote]), kept(request([confirm]), yes))).toBeUndefined();
    expect(reuse(request([withNote]), kept(request([withNote]), yes))).toEqual(yes);
  });

  it("asks again when the kept answer is not valid for the question as asked now", () => {
    const extras = {
      id: "extras",
      type: "multi_choice" as const,
      prompt: "Which extras?",
      options: [
        { id: "bag", label: "Bag" },
        { id: "seat", label: "Seat" },
      ],
      minSelections: 0,
      maxSelections: 2,
    };
    const both: ValidAnswers = { extras: { type: "multi_choice", value: ["bag", "seat"] } };
    const entries = kept(request([extras]), both);
    expect(reuse(request([extras]), entries)).toEqual(both);
    expect(reuse(request([{ ...extras, maxSelections: 1 }]), entries)).toBeUndefined();
  });

  it("keeps only the owner's latest answer to a prompt", () => {
    const entries = kept(plan, gold);
    expect(reuse(plan, forgetScriptAnswers(entries, [choice.prompt]))).toBeUndefined();
    expect(reuse(plan, forgetScriptAnswers(entries, ["Which seat?"]))).toEqual(gold);
    const wider = request([
      { ...choice, options: [...choice.options, { id: "bronze", label: "Bronze" }] },
    ]);
    const bronze: ValidAnswers = { plan: { type: "choice", value: "bronze" } };
    const newer = keptScriptAnswers(entries, keys(wider), bronze);
    expect(reuse(plan, newer)).toBeUndefined();
    expect(reuse(wider, newer)).toEqual(bronze);
  });

  it("reuses a purchase confirm's yes only for the same order the asking host kept it with", () => {
    const order = {
      currency: "USD",
      items: [{ name: "Synthetic drink", quantity: 1, price: "6.00" }],
      tax: "0.52",
      total: "6.82",
    };
    const place = {
      ...request([{ id: "place", type: "confirm", prompt: "Place this order?" }]),
      order,
    };
    const yes: ValidAnswers = { place: { type: "confirm", value: { confirmed: true } } };
    const no: ValidAnswers = { place: { type: "confirm", value: { confirmed: false } } };
    const keptWith = (answers: ValidAnswers) =>
      keptScriptAnswers([], keys(place), answers, order);
    expect(reuse(place, keptWith(yes))).toEqual(yes);
    // Another total, the owner's no, or a yes kept without its order, such as another job's.
    expect(reuse({ ...place, order: { ...order, total: "7.10" } }, keptWith(yes))).toBeUndefined();
    expect(reuse(place, keptWith(no))).toBeUndefined();
    expect(reuse(place, kept(place, yes))).toBeUndefined();
    // A yes to an order never answers the same question without one, nor once a commit step ran.
    expect(reuse(request(place.questions), keptWith(yes))).toBeUndefined();
    expect(reuse(place, forgetOrderAnswers(keptWith(yes)))).toBeUndefined();
  });

  it("checks kept answers by the rules of a fresh answer, for a host that keeps them itself", () => {
    expect(validateKeptAnswers(plan, gold)).toEqual(Either.right(gold));
    expect(validateKeptAnswers(plan, { plan: { type: "choice", value: "bronze" } })).toMatchObject({
      _tag: "Left",
    });
    expect(validateKeptAnswers(plan, { plan: "gold" })).toMatchObject({
      _tag: "Left",
      left: { reason: "malformed" },
    });
  });

  it("decodes only the kept answers this release reads, when a host reads them back", () => {
    const [entry] = kept(plan, gold);
    // An earlier release also kept when and in which run the owner answered; neither matters now.
    const earlier = { ...entry, executionId: "first", answeredAtMs: 0 };
    expect(
      [entry, earlier, { question: { id: "plan" } }].flatMap((candidate) =>
        Option.toArray(Schema.decodeUnknownOption(KeptScriptAnswer)(candidate)),
      ),
    ).toEqual([entry, entry]);
  });
});

describe("a browser hand-off", () => {
  it("is never answered from a kept answer: each one asks the person again", () => {
    const review = request([
      {
        id: "review_claim",
        type: "browser_handoff",
        prompt: "Check the claim form, then mark this step done.",
        show_inputs: [],
      },
    ]);
    const done: ValidAnswers = {
      review_claim: { type: "browser_handoff", value: { done: true } },
    };
    expect(keys(review)).toEqual([undefined]);
    expect(kept(review, done)).toEqual([]);
    expect(
      reusedScriptAnswers(review, keys(review), [
        {
          question: { id: "review_claim", type: "confirm", prompt: "Check the claim form." },
          answer: { type: "browser_handoff", value: { done: true } },
        },
      ]),
    ).toBeUndefined();
  });
});

describe("a script question Guardian rewords as a repeat of the owner's earlier answer", () => {
  // The owner's yes to the agent's own question, before a step's script asks its purchase choice.
  const approval: AnsweredQuestion = {
    id: "approve_payment",
    question: "May the tool place this order with your saved card if its total is within your limit?",
    answer: { confirmed: true },
  };
  const pay = {
    ...request([
      {
        id: "payment",
        type: "choice",
        prompt: "Pay with your saved card, or do not place the order?",
        options: [
          { id: "card", label: "Visa ending 4242", accountSpecific: true, maskedLabel: "Saved card" },
          { id: "stop", label: "Do not place the order", declines: true },
        ],
      },
    ]),
    order: { currency: "USD", items: [{ name: "Synthetic drink", quantity: 1, price: "6.82" }], total: "6.82" },
  } satisfies InputRequest;
  const repeat = (
    answers: QuestionDecision["answers"],
    answeredBy: readonly string[] = ["approve_payment"],
  ): QuestionDecision => ({
    outcome: "reword",
    rationale: "The owner already approved this payment.",
    label: "repeat",
    answers,
    answeredBy,
  });
  const card = repeat([{ question: "payment", option: "Saved card", confirmed: null }]);
  const live = () => true;
  const paid: ValidAnswers = { payment: { type: "choice", value: "card" } };

  it("takes the option the repeat names when it rests on the owner's yes", () => {
    expect(repeatedScriptAnswers(pay, card, [approval], live)).toEqual(paid);
    // By its full label as well as its masked one, ignoring case and spacing.
    const full = repeat([{ question: "payment", option: " visa ending 4242", confirmed: null }]);
    expect(repeatedScriptAnswers(pay, full, [approval], live)).toEqual(paid);
    const confirm = request([{ id: "approve", type: "confirm", prompt: "Accept the terms?" }]);
    const yes = repeat([{ question: "approve", option: null, confirmed: true }]);
    expect(repeatedScriptAnswers(confirm, yes, [approval], live)).toEqual({
      approve: { type: "confirm", value: { confirmed: true } },
    });
  });

  it("asks the owner when the review names no answer, another label, or an answer it can't check", () => {
    const named = (decision: QuestionDecision, answered = [approval]) =>
      repeatedScriptAnswers(pay, decision, answered, live);
    expect(named({ ...card, label: "already_authorized" })).toBeUndefined();
    expect(named({ ...card, outcome: "allow_business" })).toBeUndefined();
    expect(named(repeat(undefined))).toBeUndefined();
    expect(named(repeat([{ question: "payment", option: "Saved card", confirmed: null }], []))).toBeUndefined();
    // An id the owner never answered, or an answer the owner replaced since.
    expect(named(repeat(card.answers, ["approve_other"]))).toBeUndefined();
    const replaced = { id: "approve_again", question: approval.question, answer: { confirmed: true } };
    expect(named(card, [approval, replaced])).toBeUndefined();
    // No option or more than one by that label, another question's answer, or a missing one.
    expect(named(repeat([{ question: "payment", option: "Gift card", confirmed: null }]))).toBeUndefined();
    expect(named(repeat([{ question: "other", option: "Saved card", confirmed: null }]))).toBeUndefined();
    expect(named(repeat([{ question: "payment", option: null, confirmed: true }]))).toBeUndefined();
  });

  it("never answers a purchase with a no, a decline, a yes it may have spent, or a text", () => {
    const declined = { ...approval, answer: { confirmed: false } };
    expect(repeatedScriptAnswers(pay, card, [declined], live)).toBeUndefined();
    const stop = repeat([{ question: "payment", option: "Do not place the order", confirmed: null }]);
    expect(repeatedScriptAnswers(pay, stop, [approval], live)).toBeUndefined();
    expect(repeatedScriptAnswers(pay, card, [approval], () => false)).toBeUndefined();
    const chosen: AnsweredQuestion = { id: "card_choice", question: "Which card?", answer: "Saved card" };
    expect(repeatedScriptAnswers(pay, repeat(card.answers, ["card_choice"]), [chosen], live)).toBeUndefined();
    // Without an order, an earlier choice settles a choice, but a yes never rests on a no.
    const { order: _order, ...unpaid } = pay;
    expect(repeatedScriptAnswers(unpaid, repeat(card.answers, ["card_choice"]), [chosen], live)).toEqual(paid);
    expect(repeatedScriptAnswers(unpaid, card, [declined], live)).toBeUndefined();
  });

  it("never answers a code, a secret, a text or a multiple choice", () => {
    const code = request([
      { id: "code", type: "secret", secretKind: "one_time_code", prompt: "What code did the site send?" },
    ]);
    const note = request([{ id: "note", type: "text", prompt: "Any delivery note?" }]);
    for (const asked of [code, note])
      expect(
        repeatedScriptAnswers(
          asked,
          repeat([{ question: asked.questions[0]?.id ?? "", option: "481516", confirmed: true }]),
          [approval],
          live,
        ),
      ).toBeUndefined();
  });
});
