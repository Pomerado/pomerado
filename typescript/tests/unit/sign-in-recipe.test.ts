import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  armStep,
  decodeSignInRecipe,
  makeSentTracker,
  noteFormSubmit,
  openSignInRecord,
  recordStep,
  signInRecipe,
  type SignInRequest,
} from "../../src/destinations/sign-in-recipe.js";

const steps = [
  {
    page: "https://example.test/login",
    fields: [{ selector: "#user", accepts: ["username", "email"] }],
    submit: "#next",
    submittedBy: "host",
  },
  {
    page: "https://example.test/login/password",
    fields: [{ selector: "#password", slot: "password" }],
    submit: "#sign-in",
  },
] as const;
const signedIn = { selector: "#account-menu" };

describe("decodeSignInRecipe", () => {
  it.each([
    ["version 1", { version: 1, steps, signedIn }],
    [
      "version 2 with a popup and an approval",
      {
        version: 2,
        steps: [
          { ...steps[0], popup: { opener: "primary", origin: "https://auth.example.test" } },
          { page: "https://example.test/login", fields: [], approval: "email_link" },
        ],
        signedIn,
      },
    ],
    [
      "version 1 with a private answer's question selector",
      {
        version: 1,
        steps: [
          ...steps,
          {
            page: "https://example.test/challenge",
            fields: [
              { selector: "#answer", slot: "private_answer", questionSelector: "#question" },
            ],
          },
        ],
        signedIn,
      },
    ],
    [
      "version 2 with a question selector on a secret field that is no private answer",
      {
        version: 2,
        steps: [
          {
            page: "https://example.test/login",
            fields: [{ selector: "#password", slot: "password", questionSelector: "#q" }],
            popup: { opener: "primary", origin: "https://auth.example.test" },
          },
        ],
        signedIn,
      },
    ],
    [
      "version 3, which this host wrote before it wrote question selectors in version 1 and 2",
      {
        version: 3,
        steps: [
          ...steps,
          {
            page: "https://example.test/challenge",
            fields: [
              { selector: "#answer", slot: "private_answer", questionSelector: "#question" },
            ],
          },
        ],
        signedIn,
      },
    ],
  ])("reads %s", (_name, recipe) => {
    expect(decodeSignInRecipe(JSON.stringify(recipe))).toEqual(recipe);
  });

  it("refuses a version it does not know, so a run never drops what that version adds", () => {
    expect(decodeSignInRecipe(JSON.stringify({ version: 4, steps, signedIn }))).toBe(
      "unknown_version",
    );
  });

  it.each([
    ["text that is no JSON", "{"],
    ["a recipe without steps", JSON.stringify({ version: 1, steps: [], signedIn })],
    ["a version that is no number", JSON.stringify({ version: "1", steps, signedIn })],
    ["a version 3 recipe without steps", JSON.stringify({ version: 3, steps: [], signedIn })],
    [
      "a version 3 question selector on a field that is no private answer",
      JSON.stringify({
        version: 3,
        steps: [
          {
            page: "https://example.test/login",
            fields: [{ selector: "#password", slot: "password", questionSelector: "#q" }],
          },
        ],
        signedIn,
      }),
    ],
  ])("refuses %s as invalid", (_name, text) => {
    expect(decodeSignInRecipe(text)).toBe("invalid");
  });
});

describe("signInRecipe", () => {
  const recorded = {
    page: "https://example.test/login",
    fields: [
      {
        selector: "#user",
        slot: "email" as const,
        accepts: ["username", "email"] as const,
        available: { vault: ["username" as const], given: ["email" as const] },
      },
      { selector: "#password", slot: "password" as const },
    ],
    submit: "#sign-in",
    submittedBy: "host" as const,
  };

  it("names an identifier field by the kinds it accepts, never the kind or value this login sent", () => {
    expect(signInRecipe([recorded], signedIn)).toEqual({
      version: 1,
      steps: [
        {
          page: "https://example.test/login",
          fields: [
            { selector: "#user", accepts: ["username", "email"] },
            { selector: "#password", slot: "password" },
          ],
          submit: "#sign-in",
          submittedBy: "host",
        },
      ],
      signedIn,
    });
  });

  it("writes the lowest version that holds every step", () => {
    const approval = {
      page: "https://example.test/login",
      fields: [],
      approval: "device" as const,
    };
    const answer = {
      page: "https://example.test/challenge",
      fields: [
        {
          selector: "#answer",
          slot: "private_answer" as const,
          questionSelector: "#question",
        },
      ],
    };
    expect(signInRecipe([recorded], signedIn).version).toBe(1);
    expect(signInRecipe([recorded, approval], signedIn).version).toBe(2);
    // A question selector rides in version 1 or 2, as other hosts write it; no version 3 is written.
    expect(signInRecipe([recorded, answer], signedIn).version).toBe(1);
    expect(signInRecipe([recorded, approval, answer], signedIn).version).toBe(2);
    // A private answer without a question selector needs nothing a version 1 worker lacks.
    expect(
      signInRecipe(
        [
          recorded,
          { ...answer, fields: [{ selector: "#answer", slot: "private_answer" as const }] },
        ],
        signedIn,
      ).version,
    ).toBe(1);
  });

  it("holds no value, question text, label or after-submit control", () => {
    const recipe = signInRecipe(
      [
        {
          ...recorded,
          // What a host knows of a screen in memory, which never ships.
          fields: [
            {
              selector: "#user",
              slot: "email" as const,
              accepts: ["username", "email"] as const,
              questionSelector: "#not-a-private-answer",
              format: undefined,
            },
            {
              selector: "#answer",
              slot: "private_answer" as const,
              questionSelector: "#question",
              ...{ questionText: "First pet?", label: "Answer", value: "synthetic-answer" },
            },
          ],
          ...{ controls: [{ role: "button", name: "Continue as ada@example.test" }] },
        },
      ],
      signedIn,
    );
    const text = JSON.stringify(recipe);
    for (const held of ["First pet?", "Answer", "synthetic-answer", "controls", "ada@example.test"])
      expect(text).not.toContain(held);
    expect(text).not.toContain("#not-a-private-answer");
    expect(decodeSignInRecipe(text)).toEqual(recipe);
  });
});

// The rule that a filled value counts as sent only once a request the host heard carried it.
describe("the seen-sent rule", () => {
  const target = {
    ownerUrl: "https://example.test/login",
    documentOrigin: "https://example.test",
    actions: ["https://example.test/session"],
    methods: ["post"],
    editable: true,
    control: "text" as const,
  };
  const inspection = {
    page: "https://example.test/login",
    siteOrigin: "https://example.test",
    targets: { fields: [target, target], submit: target },
  };
  const step = {
    fields: [
      { selector: "#password", slot: "password" as const },
      { selector: "#user", slot: "username" as const },
    ],
    submit: "#go",
  };
  const values = ["synthetic-password", "synthetic-user"];
  const signInOrigins: readonly string[] = [];
  /** Plain containment, as a stand-in for the host's matching of registered values. */
  const carries = (expected: readonly string[], texts: readonly string[]) =>
    Effect.succeed(expected.every((value) => texts.some((text) => text.includes(value))));
  const post = (body: string): SignInRequest => ({
    url: "https://example.test/session",
    method: "POST",
    channel: "navigation",
    body,
    frame: "main",
    resourceType: "document",
  });

  it("counts a secret as sent only once a form request carried it", async () => {
    const signIn = openSignInRecord();
    // The password filled, the username did not, so nothing was submitted.
    armStep(signIn, step, inspection, values, 0, signInOrigins);
    recordStep(signIn, step, {
      outcome: "filled",
      fields: [
        { slot: "password", status: "filled" },
        { slot: "username", status: "failed" },
      ],
      submit: "not_attempted",
      url: "https://example.test/login",
    });
    expect([...signIn.submittedSlots]).toEqual([]);
    // A later submit whose request carries only the username leaves the password unsent.
    const username = { fields: [{ selector: "#user", slot: "username" as const }], submit: "#go" };
    armStep(signIn, username, inspection, ["synthetic-user"], 1, signInOrigins);
    expect(
      await Effect.runPromise(
        noteFormSubmit(signIn, 2, post("username=synthetic-user&password="), carries),
      ),
    ).toEqual([]);
    expect([...signIn.submittedSlots]).toEqual(["username"]);
    // A request sent before the watch was armed counts for nothing.
    expect(
      await Effect.runPromise(
        noteFormSubmit(signIn, 1, post("password=synthetic-password"), carries),
      ),
    ).toEqual([]);
    expect(
      await Effect.runPromise(
        noteFormSubmit(signIn, 3, post("password=synthetic-password"), carries),
      ),
    ).toEqual(["password"]);
  });

  const scriptRequest = (url: string, body: string): SignInRequest => ({
    url,
    method: "POST",
    channel: "http",
    body,
    resourceType: "fetch",
  });

  it.each([
    ["the form's own origin", "https://example.test/api/login"],
    // A host on the site's registrable domain counts too, as when the sign-in page posts the login
    // to the site's own API host.
    ["an API host on the site's registrable domain", "https://api.example.test/login"],
  ])(
    "counts a script's own sign-in request to %s only when it carries every filled value",
    async (_case, url) => {
      const signIn = openSignInRecord();
      armStep(signIn, step, inspection, values, 1, signInOrigins);
      const login = "password=synthetic-password&user=synthetic-user";
      for (const [sentAt, request] of [
        // Sent before the watch was armed.
        [1, scriptRequest(url, login)],
        // Carrying only some of the filled values.
        [2, scriptRequest(url, "password=synthetic-password")],
        // Another registrable domain, and the site's own domain over plain HTTP.
        [2, scriptRequest("https://elsewhere.test/api/login", login)],
        [2, scriptRequest("http://api.example.test/login", login)],
        // A GET, a request with no body and one whose body the host could not read.
        [2, { ...scriptRequest(`${url}?${login}`, ""), method: "GET" }],
        [2, scriptRequest(url, "")],
        [2, { ...scriptRequest(url, ""), body: null, bodyUnseen: true }],
      ] as const)
        expect(await Effect.runPromise(noteFormSubmit(signIn, sentAt, request, carries))).toEqual(
          [],
        );
      expect(
        await Effect.runPromise(
          noteFormSubmit(
            signIn,
            2,
            scriptRequest(url, '{"user":"synthetic-user","pass":"synthetic-password"}'),
            carries,
          ),
        ),
      ).toEqual(["password"]);
      expect([...signIn.submittedSlots].sort()).toEqual(["password", "username"]);
    },
  );

  it("names each origin off the site that a script's request carried every filled value to, with the slots it carried, and counts nothing sent", async () => {
    const identity = "https://identity.provider.test";
    const login = '{"user":"synthetic-user","pass":"synthetic-password"}';
    const signIn = openSignInRecord();
    armStep(signIn, step, inspection, values, 1, signInOrigins);
    for (const [sentAt, request] of [
      // Sent before the watch was armed, carrying part of the login, or as a GET.
      [1, scriptRequest("https://early.test/sign-in", login)],
      [2, scriptRequest("https://partial.test/sign-in", '{"pass":"synthetic-password"}')],
      [2, { ...scriptRequest(`https://query.test/sign-in?${login}`, ""), method: "GET" }],
      // Two requests to the same identity service name its origin once, without the path.
      [2, scriptRequest(`${identity}/v1/sign-in?key=public`, login)],
      [3, scriptRequest(`${identity}/v1/token`, login)],
    ] as const)
      expect(await Effect.runPromise(noteFormSubmit(signIn, sentAt, request, carries))).toEqual(
        [],
      );
    expect([...signIn.submittedSlots]).toEqual([]);
    expect(
      [...(signIn.untrustedOrigins ?? [])].map(([origin, slots]) => [origin, [...slots].sort()]),
    ).toEqual([[identity, ["password", "username"]]]);
    // With that origin configured, the same request carries the login and names nothing.
    const trusted = openSignInRecord();
    armStep(trusted, step, inspection, values, 1, [identity]);
    expect(
      await Effect.runPromise(
        noteFormSubmit(trusted, 2, scriptRequest(`${identity}/v1/sign-in`, login), carries),
      ),
    ).toEqual(["password"]);
    expect(trusted.untrustedOrigins).toBeUndefined();
  });

  describe("an email-then-code sign-in whose page posts both screens to the site's API host", () => {
    const emailStep = { fields: [{ selector: "#email", slot: "email" as const }], submit: "#go" };
    // The code screen submits itself once the last digit is typed.
    const codeStep = { fields: [{ selector: "#code", slot: "code" as const }] };
    const screen = {
      page: "https://example.test/",
      siteOrigin: "https://example.test",
      targets: { fields: [target], submit: target },
    };
    const codeScreen = { ...screen, targets: { fields: [target], submit: null } };
    const emailRequest = (body: string) =>
      scriptRequest("https://api.example.test/auth/email/request", body);
    const verifyRequest = (body: string) =>
      scriptRequest("https://api.example.test/auth/email/verify", body);

    it("credits the email on the email request and the code on the verify request", async () => {
      const signIn = openSignInRecord();
      armStep(signIn, emailStep, screen, ["synthetic-email"], 0, signInOrigins);
      expect(
        await Effect.runPromise(
          noteFormSubmit(signIn, 1, emailRequest("email=synthetic-email"), carries),
        ),
      ).toEqual([]);
      armStep(signIn, codeStep, codeScreen, ["246810"], 2, signInOrigins);
      expect(
        await Effect.runPromise(noteFormSubmit(signIn, 3, verifyRequest("code=246810"), carries)),
      ).toEqual(["code"]);
      expect([...signIn.submittedSlots].sort()).toEqual(["code", "email"]);
    });

    it("needs the verify request to carry the email too when the email request did not", async () => {
      const signIn = openSignInRecord();
      armStep(signIn, emailStep, screen, ["synthetic-email"], 0, signInOrigins);
      expect(
        await Effect.runPromise(
          noteFormSubmit(signIn, 1, emailRequest("email=b64-opaque"), carries),
        ),
      ).toEqual([]);
      expect([...signIn.submittedSlots]).toEqual([]);
      armStep(signIn, codeStep, codeScreen, ["246810"], 2, signInOrigins);
      expect(
        await Effect.runPromise(noteFormSubmit(signIn, 3, verifyRequest("code=246810"), carries)),
      ).toEqual([]);
      expect(
        await Effect.runPromise(
          noteFormSubmit(signIn, 4, verifyRequest("email=synthetic-email&code=246810"), carries),
        ),
      ).toEqual(["code"]);
      expect([...signIn.submittedSlots].sort()).toEqual(["code", "email"]);
    });
  });

  it("holds a private answer, a date of birth or a ZIP as filled, never as pending", () => {
    const signIn = openSignInRecord();
    const extras = {
      fields: [
        { selector: "#answer", slot: "private_answer" as const },
        { selector: "#zip", slot: "zip" as const },
      ],
      submit: "#go",
    };
    armStep(signIn, extras, inspection, ["synthetic-answer", "94110"], 0, signInOrigins);
    expect([...signIn.pending.keys()]).toEqual([]);
  });

  it("checks requests in the order the host heard them, and settles once each was checked", async () => {
    const signIn = openSignInRecord();
    const checked: string[] = [];
    const slow = (expected: readonly string[], texts: readonly string[]) =>
      Effect.sleep(texts[1] === "first" ? 20 : 0).pipe(
        Effect.tap(() => Effect.sync(() => checked.push(texts[1] ?? ""))),
        Effect.zipRight(carries(expected, texts)),
      );
    const tracker = makeSentTracker(() => signIn, slow);
    armStep(signIn, step, inspection, values, tracker.sequence(), signInOrigins);
    tracker.heard(post("first"));
    tracker.heard(post("password=synthetic-password&username=synthetic-user"));
    expect(tracker.sequence()).toBe(2);
    await Effect.runPromise(tracker.settled);
    expect([...new Set(checked)]).toEqual([
      "first",
      "password=synthetic-password&username=synthetic-user",
    ]);
    expect([...signIn.submittedSlots].sort()).toEqual(["password", "username"]);
  });
});
