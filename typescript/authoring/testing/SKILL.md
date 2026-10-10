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

## Test a read signed out as much as it needs

Where the host offers `live_tests`, a read signed out has no limit on live tests, and the host runs
them for you in parallel. Testing is your job, not the caller's: never wait to be told to try another record, retailer or value.

Plan the tests at the start. As soon as you know the page and its inputs, write the tool's input
and output schemas in the entrypoint (the run code can come later) and call `live_tests` with
action `plan`. It returns the checklist the host derives from the schemas:
- `repeat_example`: the example's input, run 3 times or more, each from a fresh browser;
- `input:<field>` for each input: each value of a short list, three spread values of a long one,
  the non-default side of a switch, or another value the site offers;
- `all_inputs` (every optional input at once) and `combination` (controls that share a panel,
  a drawer or a reload);
- `unoffered_value`: a value the site does not list at all, expecting `invalid_input` that lists
  the page's choices. An option the page lists but greys out, such as a sold-out size, is offered:
  a read returns it as unavailable data;
- for a list: `no_results` (expecting `empty`, never a throw) and `next_page`;
- for a details read: `other_record`, two or more records from a listing you opened whose pages
  differ from the example's (options, a single option, a grouped or multi-item page, sold out,
  another layout or type);
- `other_value:<field>` for an input that picks a retailer, store, seller or region: a second one,
  end to end;
- when location is an input: `location_applied` (another location, read back as applied) and
  `location_impossible` (one the site cannot apply, expecting a loud failure, never results for
  another place).

Write `test/cases.json`:

```json
{
  "cases": [
    { "id": "repeat-1", "covers": ["repeat_example"], "input": { "query": "desk lamp" }, "expect": "result" },
    { "id": "sort-price", "covers": ["input:sort", "combination"], "input": { "query": "desk lamp", "sort": "price_low", "in_stock": true }, "expect": "result" },
    { "id": "nothing", "covers": ["no_results", "input:max_price"], "input": { "query": "desk lamp", "max_price": 1 }, "expect": "empty" },
    { "id": "page-2", "covers": ["next_page"], "input": { "query": "desk lamp" }, "expect": "result", "next_page": true }
  ],
  "skipped": [
    { "item": "location_impossible", "status": "not_applicable", "reason": "The site ships one catalog everywhere and has no location control." }
  ]
}
```

`expect` is `result`, `empty`, `invalid_input` or `error` (a loud failure). Use real values the
site offers, which you saw while exploring: listed options, places, dates, counts, records and
retailers the site lists. Never use a person's, account's or record's name, number or code, and
never the caller's own values beyond the example's input. Say why for every item you skip: an
item the site cannot have is `not_applicable`, and a choice the caller declined is `declined`.
Never leave an item out silently.

Run them with `live_tests` action `run` (`cases` null runs them all; `maxWorkers` up to 3). One
Guardian review covers the batch; each case starts like the example, on its own fresh browser
where the host has them, and you get every result: its status, what it returned, and a failure's
error with the source line that threw. Name cases in action `plan` to read their full outputs,
and check what they mean: every item matches the filters, the order follows the sort, the applied
location is the one asked for, page 2 differs from page 1. A failing case is a bug in the tool:
fix the code at that line, never drop the input or narrow the schema to pass. A run that returns
partly filled results, or passes only when run again, is missing a wait for content: fix the wait,
not the retry. Refine the cases once the example passes (its receipt carries the plan again), and
add any case that catches a real risk.

Results count only for the source and the case as they ran: an edit makes them stale. Finish in
this order: make your last edit, run the cases again, run the example last, then call
`finish_build`. Publication review reads the host's record of your cases (`publication/tests.json`),
not your account of them, and judges missing, failing and stale items. Deleting or changing a
case after it failed does not hide the failure: the record keeps its last result as retired. When
`live_tests` answers `no_time`, run the example last and publish; the record says time ran out.

A signed-in read tests one input at a time instead: up to four live tests per attempt with an
input you choose (`testInput`, the tool's input as JSON text, with purpose `test` and target
`liveBrowser`), spent on the riskiest controls and a record whose page differs. When the host offers no
`live_tests`, a read signed out tests the same way, one input at a time; the host may limit how many.

The example uses the caller's input, or your `exampleInput` when that input is empty, and offline
tests always use the caller's input. If a test shows the schema must widen, widen it in source;
publication reads the schemas from current source, and only a changed flow needs a fresh example
(publication skill). A live test of `src/tool-http.mjs` counts for the HTTP version only for the
source it ran (HTTP skill).<!-- pomerado:section testing.offline-fixtures -->

- pureFiles: parsers/calculation with ordinary files and meaningful assertions.<!-- pomerado:section testing.saved-targets -->
- liveBrowser: authorized fresh observation for real-site behavior. Optional read
  smoke checks do not grant purchases, cart additions, uploads, holds or autosave.

Choose cases that catch actual risk: applied filters, account scope, IDs, units,
authoritative empty versus absent/loading data, private-input variation, partial
coverage, schema failures, variants and changed terms. Avoid assertions that merely
copy implementation expressions. The checklist is the floor; add any case that catches a real
risk.
Report actual passed/failed/skipped/unsupported counts and missing evidence; an
all-skipped suite proves nothing. Never fabricate absent response bodies or assets.

The platform supplies compilation and runners. If a requested runner/fixture mode
is unavailable, report unsupported and preserve the exact gap. Do not install an
alternate network-enabled runner or silently call production from an offline test.

<!-- pomerado:section testing.capture-evidence --><!-- pomerado:section testing.later-cases -->
