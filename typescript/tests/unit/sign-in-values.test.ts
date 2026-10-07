import { Effect } from "effect";
import { expect, it } from "vitest";
import { Unanswered } from "../../src/destinations/sign-in-recipe.js";
import {
  InputRequestFailure,
  type InputAsker,
  type Question,
} from "../../src/runtime/input-request.js";
import { askingValueHooks, makeSignInValues } from "../../src/runtime/sign-in-values.js";

const site = "example.test";
const siteOrigin = "https://www.example.test";
/** The values of one build, asking through `ask`, with what each ask registered. */
const values = (ask: InputAsker = () => Effect.dieMessage("The owner was asked")) => {
  const registered: string[] = [];
  const hooks = askingValueHooks({
    ask,
    register: (value) => {
      registered.push(value);
    },
    site,
    siteOrigin,
  });
  return { values: makeSignInValues(hooks, site), registered };
};
/** Answers each question with the next of `answers`, keeping each question it was asked. */
const answering = (answers: readonly string[], asked: Question[] = []): InputAsker => {
  const queue = [...answers];
  return (request) =>
    Effect.sync(() => {
      asked.push(...request.questions);
      const value = queue.shift() ?? "";
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          { type: question.type === "text" ? ("text" as const) : ("secret" as const), value },
        ]),
      );
    });
};
const login = (username: string) => ({ username, password: "synthetic-password" });
const phoneStep = { fields: [{ selector: "#tel", slot: "phone" as const }] };

it.each(["fresh", "repeated"] as const)(
  "keeps a rejected recovery code out of a %s correction",
  async (answer) => {
    let asked = 0;
    const ask: InputAsker = () =>
      Effect.sync(() => {
        asked += 1;
        return {
          recovery_code: {
            type: "secret" as const,
            value: answer === "fresh" && asked === 2 ? "fresh-recovery" : "rejected-recovery",
          },
        };
      });
    const corrections = { recovery_code: 0 };
    const result = await Effect.runPromise(
      values(ask).values.valuesFor(
        { fields: [{ selector: "#recovery", slot: "recovery_code" }] },
        {
          credentials: login("primary-owner"),
          rejected: { recovery_code: new Set(["rejected-recovery"]) },
          corrections,
        },
      ),
    );
    if (answer === "fresh") expect(result).toMatchObject({ values: ["fresh-recovery"] });
    else expect(result).toBeInstanceOf(Unanswered);
    expect(asked).toBe(2);
    expect(corrections.recovery_code).toBe(2);
  },
);

it("replaces a rejected email-shaped username in an email field without changing the login", async () => {
  const rejected = "old@example.test";
  const asked: Question[] = [];
  const { values: autofill } = values(answering(["corrected@example.test"], asked));
  const corrections = { email: 0 };
  const credentials = login(rejected);
  const step = { fields: [{ selector: "#email", slot: "email" as const }] };
  for (let round = 0; round < 2; round++)
    expect(
      await Effect.runPromise(
        autofill.valuesFor(step, {
          credentials,
          rejected: { email: new Set([rejected]) },
          corrections,
        }),
      ),
    ).toMatchObject({ values: ["corrected@example.test"] });
  expect(asked.map((question) => question.prompt)).toEqual([
    `What's the email address for your ${site} account?`,
  ]);
  expect(corrections.email).toBe(1);
  expect(credentials).toEqual(login(rejected));
});

it("bounds rejected answers without filling the rejected value", async () => {
  let asked = 0;
  const again = values((request) =>
    Effect.sync(() => {
      asked += 1;
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          { type: "text" as const, value: "+1 415 555 0142" },
        ]),
      );
    }),
  ).values;
  const corrections = { phone: 0 };
  expect(
    await Effect.runPromise(
      again.valuesFor(phoneStep, {
        credentials: login("primary-owner"),
        rejected: { phone: new Set(["+1 415 555 0142"]) },
        corrections,
      }),
    ),
  ).toBeInstanceOf(Unanswered);
  expect(asked).toBe(2);
  expect(corrections.phone).toBe(2);
});

it("fills a username slot with the login's username, even one that looks like a phone number", async () => {
  expect(
    await Effect.runPromise(
      values().values.valuesFor(
        { fields: [{ selector: "#user", slot: "username" }] },
        { credentials: login("+1 415 555 0100") },
      ),
    ),
  ).toMatchObject({ values: ["+1 415 555 0100"] });
});

it("asks for an identifier the login does not hold once in a build, masked before it is filled", async () => {
  const asked: Question[] = [];
  const { values: autofill, registered } = values(answering(["+1 415 555 0142"], asked));
  for (let round = 0; round < 2; round++)
    expect(
      await Effect.runPromise(
        autofill.valuesFor(phoneStep, { credentials: login("synthetic-user") }),
      ),
    ).toMatchObject({ values: ["+1 415 555 0142"] });
  expect(asked).toEqual([
    {
      id: "phone",
      type: "text",
      maxLength: 320,
      prompt: `What's the phone number for your ${site} account?`,
    },
  ]);
  expect(registered).toEqual(["+1 415 555 0142"]);
  expect(autofill.given()).toEqual({ phone: "+1 415 555 0142" });
});

it("sends an email-shaped username into an email-only field without asking", async () => {
  const { values: autofill } = values();
  const resolved = autofill.resolve(
    { fields: [{ selector: "#email", accepts: ["email"] }] },
    login("owner@example.test"),
  );
  expect(resolved.fields).toEqual([{ selector: "#email", accepts: ["email"], slot: "email" }]);
  expect(
    await Effect.runPromise(
      autofill.valuesFor(resolved, { credentials: login("owner@example.test") }),
    ),
  ).toMatchObject({ values: ["owner@example.test"] });
});

it("sends the username into a field that takes a username or an email once the login is given", () => {
  const { values: autofill } = values();
  const request = { fields: [{ selector: "#user", accepts: ["username", "email"] as const }] };
  // Before the owner gave the login, nothing is held: the field names its first other kind.
  expect(autofill.resolve(request, undefined).fields[0]?.slot).toBe("email");
  expect(autofill.resolve(request, login("ada")).fields[0]?.slot).toBe("username");
});

it("asks again when the answer to a phone-only field is no phone number", async () => {
  let asked = 0;
  const answers = ["not a number", "+1 415 555 0142"];
  const { values: autofill } = values((request) =>
    Effect.sync(() => {
      asked += 1;
      const value = answers.shift() ?? "";
      return Object.fromEntries(
        request.questions.map((question) => [question.id, { type: "text" as const, value }]),
      );
    }),
  );
  expect(
    await Effect.runPromise(
      autofill.valuesFor(phoneStep, { credentials: login("synthetic-user") }),
    ),
  ).toMatchObject({ values: ["+1 415 555 0142"] });
  expect(asked).toBe(2);
});

it("stops asking a phone-only field after three answers that are no phone number", async () => {
  let asked = 0;
  const { values: autofill, registered } = values((request) =>
    Effect.sync(() => {
      asked += 1;
      return Object.fromEntries(
        request.questions.map((question) => [
          question.id,
          { type: "text" as const, value: "not a number" },
        ]),
      );
    }),
  );
  const filled = await Effect.runPromise(
    autofill.valuesFor(phoneStep, { credentials: login("synthetic-user") }),
  );
  expect(asked).toBe(3);
  expect(filled).toEqual(new Unanswered("answer_kind"));
  expect(autofill.given()).toEqual({});
  expect(registered).toEqual([]);
});

// A username of digits is often a member number, not the login's phone number, so a phone-only
// field asks the owner instead of typing the username.
it("asks for the phone number of a login whose username is all digits, and fills nothing unanswered", async () => {
  const asked: string[] = [];
  const { values: autofill, registered } = values((request) =>
    Effect.suspend(() => {
      asked.push(...request.questions.map((question) => question.id));
      return Effect.fail(new InputRequestFailure({ code: "NoResponse" }));
    }),
  );
  const resolved = autofill.resolve(
    { fields: [{ selector: "#tel", accepts: ["phone"] }] },
    login("4155550142"),
  );
  const filled = await Effect.runPromise(
    autofill.valuesFor(resolved, { credentials: login("4155550142") }),
  );
  expect(asked).toEqual(["phone"]);
  expect(filled).toBeInstanceOf(Unanswered);
  expect(autofill.given()).toEqual({});
  expect(registered).toEqual([]);
});

it("asks for a date of birth once, as a real date, masked in each whole-date layout", async () => {
  const asked: Question[] = [];
  const { values: autofill, registered } = values(answering(["1990/4/7", "1990-04-07"], asked));
  const step = { fields: [{ selector: "#dob", slot: "date_of_birth" as const }] };
  for (let round = 0; round < 2; round++)
    expect(
      await Effect.runPromise(autofill.valuesFor(step, { credentials: login("synthetic-user") })),
    ).toMatchObject({ values: ["1990-04-07"] });
  expect(asked).toEqual([
    {
      id: "date_of_birth",
      type: "secret",
      secretKind: "private_text",
      prompt: `What's the date of birth on your ${site} account? Enter it as YYYY-MM-DD.`,
    },
  ]);
  for (const layout of ["1990/4/7", "1990-04-07", "04/07/1990", "07.04.1990", "19900407"])
    expect(registered).toContain(layout);
});

it("asks for a ZIP and a recovery code in the site's own words", async () => {
  const asked: Question[] = [];
  const { values: autofill } = values(answering(["94110", "rc-1234-5678"], asked));
  expect(
    await Effect.runPromise(
      autofill.valuesFor(
        {
          fields: [
            { selector: "#zip", slot: "zip" },
            { selector: "#recovery", slot: "recovery_code" },
          ],
        },
        { credentials: login("synthetic-user") },
      ),
    ),
  ).toMatchObject({ values: ["94110", "rc-1234-5678"] });
  expect(asked.map((question) => question.prompt)).toEqual([
    `What's the ZIP or postal code on your ${site} account?`,
    `Enter one of your ${site} recovery codes.`,
  ]);
});

it("asks for a new code once the site rejected the last, twice at most, never filling a rejected one", async () => {
  const asked: Question[] = [];
  const { values: autofill } = values(answering(["111111", "222222"], asked));
  const step = { fields: [{ selector: "#code", slot: "code" as const }] };
  const codeRequests = { current: 0 };
  expect(
    await Effect.runPromise(
      autofill.valuesFor(step, {
        credentials: login("synthetic-user"),
        code: { again: "rejected", rejected: new Set(["111111"]), requests: codeRequests },
      }),
    ),
  ).toMatchObject({ values: ["222222"] });
  expect(asked.map((question) => question.prompt)).toEqual([
    `The site did not accept the last code, so it needs a new one. Enter the sign-in code ${site} sent you.`,
    `The site did not accept the last code, so it needs a new one. Enter the sign-in code ${site} sent you.`,
  ]);
  expect(codeRequests.current).toBe(2);
  expect(
    await Effect.runPromise(
      autofill.valuesFor(step, {
        credentials: login("synthetic-user"),
        code: { again: "rejected", rejected: new Set(["111111"]), requests: codeRequests },
      }),
    ),
  ).toEqual(new Unanswered("code_corrections_exhausted"));
});

it("asks for a private answer with the question the screen shows, each time", async () => {
  const asked: Question[] = [];
  const { values: autofill, registered } = values(answering(["first", "second"], asked));
  const step = { fields: [{ selector: "#answer", slot: "private_answer" as const }] };
  for (const question of ["First pet?", "First school?"])
    await Effect.runPromise(
      autofill.valuesFor(step, {
        credentials: login("synthetic-user"),
        questions: [{ questionText: question, label: "Answer" }],
      }),
    );
  expect(asked.map((question) => question.prompt)).toEqual([
    `First pet? (${siteOrigin})`,
    `First school? (${siteOrigin})`,
  ]);
  expect(registered).toEqual(["first", "second"]);
});
