import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import {
  exampleOutputEvidence,
  publicationEvidenceNote,
  publicationScope,
  publicDefinition,
  reviewPublication,
  sessionEvidenceFiles,
  type PublicationCandidate,
  type PublicationReview,
} from "../../src/mint/publication-review.js";

const limit = 96 * 1024;
const Envelope = Schema.parseJson(
  Schema.Struct({
    kind: Schema.Literal("verified_example_output", "write_session_output"),
    executionId: Schema.String,
    executedEntrypoint: Schema.String,
    executedSourceDigest: Schema.optional(Schema.String),
    state: Schema.String,
    reason: Schema.optional(Schema.String),
    screenedBytes: Schema.optional(Schema.Int),
    output: Schema.optional(Schema.String),
  }),
);
/** A fake host's credential precheck: a record passes unless it holds one of `secrets`. */
const precheck =
  (...secrets: string[]) =>
  (text: string) =>
    Effect.succeed(!secrets.some((secret) => text.includes(secret)));
const source = {
  executionId: "execution_a",
  executedEntrypoint: "executed/src/tool.mjs",
  executedSourceDigest: "digest_a",
};
const evidenceFor = async (value: unknown, credentialFree = precheck("private-canary")) => {
  const { state, text } = await Effect.runPromise(
    exampleOutputEvidence(
      source,
      value === undefined ? undefined : JSON.stringify(value),
      credentialFree,
    ),
  );
  const envelope = Schema.decodeUnknownSync(Envelope)(text);
  expect(envelope.state).toBe(state);
  return { text, envelope };
};

describe("the example's output evidence", () => {
  it("binds the output to the execution and the source that ran it", async () => {
    const { text, envelope } = await evidenceFor({ heading: "Public" });
    expect(envelope).toEqual({
      kind: "verified_example_output",
      ...source,
      state: "available",
      screenedBytes: Buffer.byteLength('{"heading":"Public"}'),
      output: '{"heading":"Public"}',
    });
    // The record is indented JSON with its fields in this order.
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "kind",
      "executionId",
      "executedEntrypoint",
      "executedSourceDigest",
      "state",
      "screenedBytes",
      "output",
    ]);
    expect(text).toContain('\n  "kind": "verified_example_output",\n');
  });

  it("names a write session's step instead of a source digest", async () => {
    const { text } = await Effect.runPromise(
      exampleOutputEvidence(
        {
          kind: "write_session_output",
          executionId: "execution_b",
          executedEntrypoint: "publication/session/1/src/save.mjs",
        },
        '{"saved":true}',
        precheck(),
      ),
    );
    expect(JSON.parse(text)).toEqual({
      kind: "write_session_output",
      executionId: "execution_b",
      executedEntrypoint: "publication/session/1/src/save.mjs",
      state: "available",
      screenedBytes: 14,
      output: '{"saved":true}',
    });
  });

  it("serializes a bare string result as JSON", async () => {
    const { envelope } = await evidenceFor("plain result");
    expect(envelope.output).toBe(JSON.stringify("plain result"));
  });

  it("marks an output the host kept none of as not_retained, without output", async () => {
    const { envelope } = await evidenceFor(undefined);
    expect(envelope).toMatchObject({ state: "not_retained" });
    expect(envelope.output).toBeUndefined();
  });

  it("bounds the serialized envelope and keeps a prefix of the screened output", async () => {
    const value = { rows: Array.from({ length: 20_000 }, (_, index) => `row "${index}"\n`) };
    const { text, envelope } = await evidenceFor(value);
    const full = JSON.stringify(value);
    expect(envelope.state).toBe("truncated");
    expect(envelope.screenedBytes).toBe(Buffer.byteLength(full));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
    expect(full.startsWith(envelope.output ?? "missing")).toBe(true);
    expect((envelope.output ?? "").length).toBeGreaterThan(limit / 4);
  });

  it.each(["é", "😀"])("truncates on a code point boundary: %s", async (character) => {
    const value = character.repeat(60_000);
    const { text, envelope } = await evidenceFor(value);
    expect(envelope.state).toBe("truncated");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
    expect(envelope.output).not.toContain("�");
    expect(JSON.stringify(value).startsWith(envelope.output ?? "missing")).toBe(true);
    expect(Buffer.from(envelope.output ?? "").toString()).toBe(envelope.output);
  });

  it("withholds an output whose URL carries a secret the truncation point would split", async () => {
    const secret = `tok-${"q7".repeat(6000)}`;
    const value = {
      filler: "a".repeat(limit - 4096),
      link: `https://shop.example.com/account?session=${secret}`,
    };
    const { envelope } = await evidenceFor(value, precheck(secret));
    expect(envelope).toMatchObject({ state: "withheld", reason: "credential_precheck" });
    expect(envelope.output).toBeUndefined();
  });

  it("withholds an untruncated output that fails the credential precheck", async () => {
    const { text, envelope } = await evidenceFor(
      { link: "https://shop.example.com/?session=tok-short-canary-91" },
      precheck("tok-short-canary-91"),
    );
    expect(envelope).toMatchObject({ state: "withheld", reason: "credential_precheck" });
    expect(text).not.toContain("tok-short-canary-91");
  });

  it("checks a cut record again before it keeps it", async () => {
    const checked: string[] = [];
    const { envelope } = await evidenceFor({ rows: "r".repeat(limit) }, (text) =>
      Effect.sync(() => {
        checked.push(JSON.parse(text).state as string);
        return checked.length === 1;
      }),
    );
    expect(checked).toEqual(["available", "truncated"]);
    expect(envelope).toMatchObject({ state: "withheld", reason: "credential_precheck" });
  });
});

describe("the public definition", () => {
  const metadata = { name: "read_reports", description: "Read reports" };
  const schemas = {
    input: { type: "object", properties: { month: { type: "string" } } },
    output: { type: "array" },
  };

  it("lists the name and description, then the schemas and declared questions", () => {
    const questions = { delivery: { type: "choice" as const, prompt: "Which speed?" } };
    const text = publicDefinition(metadata, { ...schemas, questions });
    expect(text).toBe(
      JSON.stringify(
        {
          name: "read_reports",
          description: "Read reports",
          inputSchema: schemas.input,
          outputSchema: schemas.output,
          questions,
        },
        null,
        2,
      ),
    );
    expect(publicDefinition(metadata, schemas)).not.toContain('"questions"');
  });

  // A host with fields of its own places them before the schemas or after them.
  it("places a host's own fields before or after the schemas", () => {
    const text = publicDefinition(metadata, schemas, {
      beforeSchemas: { site: "Reports" },
      afterSchemas: { variants: [] },
    });
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "name",
      "description",
      "site",
      "inputSchema",
      "outputSchema",
      "variants",
    ]);
  });
});

describe("the evidence index", () => {
  it("lists the bundle under operation/, then each publication file", () => {
    const scope = publicationScope(
      new Map([
        ["src/tool.mjs", "export const é = 1;"],
        ["src/entry.mjs", "export {};"],
      ]),
      new Map([
        ["publication/definition.json", "{}"],
        ["publication/session-output.json", "{}"],
        ["publication/session/0/src/tool.mjs", "old"],
      ]),
      new Set(["src/entry.mjs"]),
    );
    expect(scope.files).toEqual([
      {
        path: "operation/src/tool.mjs",
        byteLength: Buffer.byteLength("export const é = 1;"),
        published: true,
        current: true,
        owner: "minter",
      },
      {
        path: "operation/src/entry.mjs",
        byteLength: 10,
        published: true,
        current: true,
        owner: "host",
      },
      {
        path: "publication/definition.json",
        byteLength: 2,
        published: true,
        current: true,
        owner: "host",
      },
      {
        path: "publication/session-output.json",
        byteLength: 2,
        published: false,
        current: true,
        owner: "host",
      },
      {
        path: "publication/session/0/src/tool.mjs",
        byteLength: 3,
        published: false,
        current: false,
        owner: "host",
      },
    ]);
  });

  it("keeps each act step's entrypoint and its imports, in order, and drops what it never ran", () => {
    expect([
      ...sessionEvidenceFiles([
        {
          entrypoint: "src/read.mjs",
          files: new Map([
            ["src/read.mjs", 'import { h } from "./help.mjs";'],
            ["src/help.mjs", "export const h = 1;"],
            ["explore/unused.mjs", "export {};"],
          ]),
        },
        { entrypoint: "src/save.mjs", files: new Map([["src/save.mjs", "export {};"]]) },
      ]).keys(),
    ]).toEqual([
      "publication/session/0/src/read.mjs",
      "publication/session/0/src/help.mjs",
      "publication/session/1/src/save.mjs",
    ]);
  });

  it("tells the review what it judges a read or a write against", () => {
    const read = publicationEvidenceNote({
      kind: "read",
      entrypoint: "src/tool.mjs",
      completed: true,
    });
    expect(read).toContain("The actual completed example used executed/src/tool.mjs;");
    expect(read).not.toContain("The source changed after the example ran");
    expect(
      publicationEvidenceNote({
        kind: "read",
        entrypoint: "src/tool.mjs",
        completed: false,
        schemasReadOffline: true,
      }),
    ).toContain("The actual failed example used executed/src/tool.mjs; ");
    const write = publicationEvidenceNote({
      kind: "write",
      writeConfirmation: "readback",
      intentDerived: false,
    });
    expect(write).toContain("declared write confirmation (readback)");
    expect(write).toContain("and the caller's own input decodes against it.");
    expect(write.endsWith("Do not call for another run of the write.")).toBe(true);
  });
});

describe("reviewPublication", () => {
  const definition = publicDefinition(
    { name: "book_table", description: "Book a table" },
    {
      input: {
        type: "object",
        properties: { date: { type: "string" }, partySize: { type: "integer" } },
      },
      output: { type: "object" },
    },
  );
  const candidate: PublicationCandidate = {
    entrypoint: "src/tool.mjs",
    files: new Map([["src/tool.mjs", "export default 1;"]]),
    definition,
    evidence: {
      files: new Map([["publication/example-output.json", "{}"]]),
      hostWritten: new Set(),
    },
    baseline: new Map([["src/tool.mjs", "export default 0;"]]),
    notes: "Evidence note.",
    inputSchema: JSON.parse(definition).inputSchema as unknown,
    write: false,
  };
  /** A fake host's review hook that records each request and allows it. */
  const recordingReview = () => {
    const requests: Parameters<PublicationReview>[0][] = [];
    const review: PublicationReview = (request) =>
      Effect.sync(() => {
        requests.push(request);
        return `review_${requests.length}`;
      });
    return { requests, review };
  };

  it("reviews the bundle against the definition first, then the host's evidence", async () => {
    const { requests, review } = recordingReview();
    expect(await Effect.runPromise(reviewPublication(review, candidate))).toBe("review_1");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({
      entrypoint: "src/tool.mjs",
      files: candidate.files,
      notes: "Evidence note.",
      baseline: candidate.baseline,
      allowedEffects: [
        "Publish the current operation bundle, including the files the host adds to it, and the public definition only; do not execute the business action again.",
      ],
    });
    expect([...(request?.evidence.files ?? [])]).toEqual([
      ["publication/definition.json", definition],
      ["publication/example-output.json", "{}"],
    ]);
  });

  it("passes the review's denial through as it came", async () => {
    const denial = new MintFailure({
      code: "ReviewDenied",
      review: { outcome: "deny", reason: "privacy", reviewId: "review_x", rationale: "No." },
    });
    const failure = await Effect.runPromise(
      Effect.flip(reviewPublication(() => Effect.fail(denial), candidate)),
    );
    expect(failure).toBe(denial);
  });

  it("returns an intent-derived key the schema does not list as input feedback once Guardian allows", async () => {
    const { requests, review } = recordingReview();
    const failure = await Effect.runPromise(
      Effect.flip(
        reviewPublication(review, {
          ...candidate,
          intentDerivedInput: { date: "Friday", venue: "Corner", seating: "patio" },
        }),
      ),
    );
    expect(requests).toHaveLength(1);
    const start = Buffer.byteLength(definition.slice(0, definition.indexOf('"inputSchema"')));
    expect(failure.review).toEqual({
      outcome: "deny",
      reason: "input_feedback",
      reviewId: "review_1",
      rationale:
        'The example ran with "venue", "seating" in its exampleInput, which the input schema does not list, so the tool fixes that value itself. Make each an input property.',
      findings: [
        {
          path: "publication/definition.json",
          byteStart: start,
          byteEnd: start + '"inputSchema"'.length,
          category: "example_input",
        },
      ],
    });
    expect(definition.slice(start, start + 13)).toBe('"inputSchema"');
  });

  it("names the write session in a write's input feedback", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        reviewPublication(recordingReview().review, {
          ...candidate,
          write: true,
          intentDerivedInput: { note: "kept" },
        }),
      ),
    );
    expect(failure.review?.rationale).toMatch(/^The write session ran with "note" in/u);
  });

  // An Effect identifier annotation or Schema.Class publishes its input schema as a root $ref,
  // and a union as anyOf; either lists the example's keys. A no-input tool's empty properties
  // lists none of them.
  it.each([
    {
      root: "a $ref",
      input: {
        $ref: "#/$defs/Reservation",
        $defs: {
          Reservation: {
            type: "object",
            properties: { venue: { type: "string" }, date: { type: "string" } },
          },
        },
      },
      feedback: false,
    },
    {
      root: "an anyOf",
      input: {
        anyOf: [
          { type: "object", properties: { venue: { type: "string" } } },
          { type: "object", properties: { date: { type: "string" } } },
        ],
      },
      feedback: false,
    },
    {
      root: "an unresolvable $ref",
      input: { $ref: "#/$defs/Missing" },
      feedback: false,
    },
    {
      root: "no properties at all",
      input: { type: "object" },
      feedback: false,
    },
    {
      root: "an empty properties",
      input: { type: "object", properties: {}, additionalProperties: false },
      feedback: true,
    },
  ])("checks an intent-derived example's keys against $root input root", async (row) => {
    const result = await Effect.runPromise(
      Effect.either(
        reviewPublication(recordingReview().review, {
          ...candidate,
          inputSchema: row.input,
          intentDerivedInput: { venue: "Corner", date: "Friday" },
        }),
      ),
    );
    expect(result._tag === "Left" && result.left.review?.reason === "input_feedback").toBe(
      row.feedback,
    );
  });

  it("checks nothing for an example that ran the caller's own input", async () => {
    expect(
      await Effect.runPromise(
        reviewPublication(recordingReview().review, {
          ...candidate,
          inputSchema: { type: "object", properties: {} },
        }),
      ),
    ).toBe("review_1");
  });
});
