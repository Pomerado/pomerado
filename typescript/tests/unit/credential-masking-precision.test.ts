import { describe, expect, it } from "vitest";
import { redactDiagnosticText } from "../../src/runtime/failure-detail.js";
import { credentials, prose, urls } from "../support/credential-masking-corpus.js";

describe("credential masking precision", () => {
  it("masks real credentials by structure and keeps prose, identifiers and URLs byte for byte", () => {
    for (const [text, secret, surfaces] of credentials) {
      if (surfaces.includes("diagnostic"))
        expect(redactDiagnosticText(text), text).not.toContain(secret);
    }
    // A comma followed by a space and no `name=` is prose, not a joined cookie.
    expect(redactDiagnosticText("Cookie: a=1, then retry")).toBe("Cookie: [redacted], then retry");
    for (const text of [...prose, ...urls]) expect(redactDiagnosticText(text), text).toBe(text);
  });
});
