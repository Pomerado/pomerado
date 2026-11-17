import { describe, expect, it } from "vitest";
import { codeContentDigest, fileCodeDigest } from "../../src/mint/code-digest.js";

/*
 * What a version's live evidence is keyed on. Ways this fails:
 * - a file holding a BigInt literal throws while it is serialized, so every step's digest is
 *   lost and its results never go stale after a real edit;
 * - an edit of a BigInt's or a regular expression's value keeps the digest;
 * - a comment-only edit changes it.
 */
const digest = (source: string) => codeContentDigest(new Map([["src/tool.mjs", source]]));

describe("fileCodeDigest", () => {
  it("keys a file holding BigInt and regular expression literals on their values", () => {
    const source = "const limit = 10n;\nconst price = /\\$(\\d+)/g;\nexport default limit;\n";
    expect(fileCodeDigest("src/tool.mjs", source)).toMatch(/^code:/);
    expect(digest(source)).toBe(digest(`// The page's price.\n${source}`));
    expect(digest(source)).not.toBe(digest(source.replace("10n", "11n")));
    expect(digest(source)).not.toBe(digest(source.replace("/g", "/gi")));
    expect(digest(source)).not.toBe(digest(source.replace("\\d+", "\\d*")));
  });
});
