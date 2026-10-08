---
name: testing
description: Choose meaningful parser, saved HTTP, static DOM and authorized live checks.
---

# Test the contract you authored

Use execute with purpose=test, target, relative entrypoint/test file, fixtureRefs,
caseFilter, maxWorkers and timeoutSeconds. Fixtures are host-authorized immutable
inputs. Offline cases may use isolated workers; a live test is one read-only flow. It starts
like the example: the site origin page, with the session saved right after sign-in for a
signed-in read. A read proves its operation with purpose=example and iterates from that
clean start; running the example or a live test again is normal for a read. A write
happens once, in its act session (the writes skill), so a write build tests only
offline: pureFiles, savedDOM and savedHTTP.

An entry page with a saved signed-in session is not a signed-out browser. These example and live
tests verify business navigation and results after authentication; they do not prove that the
recorded sign-in works from the published `loginUrl`. For autofill, follow the auth skill's entry
recording guidance: required navigation from that URL must precede the credential screens in the
recorded steps, not just in an exploration script or the business script (which runs after sign-in).
Report sign-in replay as unverified unless a separate registered run actually starts signed out
at that URL and completes the recorded steps. Do not clear a live session or repeat a write merely to test this.

A read may run up to two live tests per attempt with an input you choose instead of
the caller's: set `testInput` to the tool's input as JSON text, with purpose `test`
and target `liveBrowser`. Use them to show the tool works for other values its schema
accepts, such as another route, two travellers and another cabin. For a detail read, spend
one on another record whose page differs, such as a product with options or a listing with
another layout. Pick public values
the site offers (places, dates, counts, listed options), never a person's, account's
or record's name, number or code. The operation checks the input against its input
schema before it touches the site, and a failed check still counts. Guardian reviews
it as a read. Run them before your first `finish_build`, since a publication that
succeeds ends live execution. If a test shows the schema must widen, widen it in source;
publication reads the schemas from current source, and only a changed flow needs a fresh
example (publication skill). Check `testInput` against the
schema yourself first: a failed test of `src/tool-http.mjs` marks the HTTP version's
latest live test failed, and it is dropped. The example uses the caller's input, or your `exampleInput` when that input is empty, and offline tests always use the caller's input.<!-- pomerado:section testing.offline-fixtures -->

- pureFiles: parsers/calculation with ordinary files and meaningful assertions.<!-- pomerado:section testing.saved-targets -->
- liveBrowser: authorized fresh observation for real-site behavior. Optional read
  smoke checks do not grant purchases, cart additions, uploads, holds or autosave.

Choose cases that catch actual risk: applied filters, account scope, IDs, units,
authoritative empty versus absent/loading data, private-input variation, partial
coverage, schema failures, variants and changed terms. Avoid assertions that merely
copy implementation expressions. No required matrix, count or promotion tier.
Report actual passed/failed/skipped/unsupported counts and missing evidence; an
all-skipped suite proves nothing. Never fabricate absent response bodies or assets.

The platform supplies compilation and runners. If a requested runner/fixture mode
is unavailable, report unsupported and preserve the exact gap. Do not install an
alternate network-enabled runner or silently call production from an offline test.

<!-- pomerado:section testing.capture-evidence --><!-- pomerado:section testing.later-cases -->
