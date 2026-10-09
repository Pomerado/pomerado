---
name: http-mcp
description: Build the http implementation beside the playwright script from the routes the Playwright flow recorded, test it, and know what the host publishes and runs first.
---

# Two implementations: playwright and http

Every mint publishes the Playwright script, `src/tool.mjs`, and an HTTP implementation,
`src/tool-http.mjs`, of the same operation. Build them in that order:

1. Run the Playwright flow first: a read explores and runs its example, and a write
   performs its act session (the writes skill). Clicking through the real site is how
   you learn which requests make the operation work.
2. Read `captures/routes.json` (`reference/captures.md` in the workspace has the details).
   The host rewrites it after every capture publication. It is valid JSON: a header line,
   then one route per line in time order, one per recorded exchange across exploration,
   tests, the example or act session and HTTP relay runs, labelled with the execution that
   first recorded it. The header has `version: 2`, `complete`, `routeCount` and counts by
   label, resource type, status class and site versus other sites. `complete` is false
   while the sessions in `deferredSessions` wait for a later publication. Each route holds
   names, states and references, never a value: its order, time and duration, label,
   session and request ID, channel, method, origin, path, `query` and `requestHeaders`
   names, status, content type, resource type, owner, document scope and frame. Its
   `requestBody` and `responseBody` are `{state, reason, path, bytes, sourceBytes}`, with
   no inline text. `capture` names the session's `network.ndjson`, and
   `record: {offset, length}` points at the exchange's line there, which holds its exact
   URL and header values. Search the index with `rg` or `jq` in an offline command, then
   read a body file or record with `read_source` and an offset and limit; `retain_capture`
   a body you need that wasn't saved. Use each route's method to avoid unintended writes:
   only GET, HEAD and OPTIONS are safe to replay without working out what they change.
3. Work out the data requests, their order and what each call must obtain fresh:
   session cookies, CSRF values, nonces, IDs from earlier responses or the page.
   Temporal proximity to a click is a lead, not proof of causality. When the data isn't
   in the page's HTML, search the captures for one of the example's IDs (a product ID, an
   order number): the response that holds it is the request to call.
4. Write `src/tool-http.mjs` in the object form, never as a Kernel script. Start from
   `references/http-version.ts`: `defineHttpOperation({ ...contract, run: (input, http) =>
   Effect.gen(...) })`, or `defineOperation({ ...contract, run: (input) =>
   Effect.gen(function* () { const http = yield* SiteHttp; ... }) })`, both from
   `../../runtime/index.js`. Reuse the Playwright version's contract, so both versions
   share it: `import tool from "./tool.mjs"` and pass `name: tool.name, input: tool.input,
   output: tool.output`. The two-argument `defineOperation(contract, async (context) =>
   ...)` is a Kernel script: it has no `SiteHttp`, and the host refuses it in a
   `*-http.mjs` file before it runs, saying how to write it instead.
   `readJson(http, request, schema)` answers the decoded value, and `readText(http, request)`
   answers `{ text, response }`, so destructure it for an HTML or text body:
   `const { text } = yield* readText(http, request)`.
5. Test it, as below. A read gets one live test; a write iterates offline until it works.

Preserve semantics: method, query and body roles, redirects, account, ordering and
response meaning. Compare IDs, filters, units, freshness, coverage and empty or error
cases with the Playwright result.

## URLs

A site-relative URL such as `/api/search?q=...` resolves against the site origin, live and
in replay. `http.siteOrigin` is that origin, and each response's `requestUrl` is the
absolute URL requested, so build other URLs from them, never from a sponsored link, a
canonical tag or other page text, and never write the site's hostname as a literal (the core
skill). A request may go to a sibling host on the site's registrable domain, such as
`api.shop.example` or `data.shop.example` for `www.shop.example`, which many sites serve their
data from. A host on another
registrable domain is a third party: call it only with an https read that matches a call
the captures show the site's own page script making for this data, with the same origin and
endpoint, and send only the caller's input and the values the page itself sends there,
never a secret handle, a credential, or account data the page does not send there.

## Transport

Files named `*-http.mjs` run with the host HTTP relay as `SiteHttp`: `src/tool-http.mjs`,
and probes such as `explore/cart-http.mjs`. There are two backends, and the code picks per
request:

- **Kernel browser curl**, the default. It sends the browser's cookie jar, TLS fingerprint
  and proxy, and a Set-Cookie response updates that jar. It ignores CORS and runs no page
  JavaScript. A live test starts with cleared cookies, so before curl's first request the
  host gives the jar the cookies its own first load of the site set, as a run's entry page
  load does; the first time, it loads the site origin in the page to get them. A jar that
  already holds site cookies, such as a restored sign-in or your flow in progress, stays
  as it is. The execution's `http.relay.preparation` says what the host did.
- **The page's own fetch**, chosen with `requires: ["page-environment"]` (or
  `"service-worker"`). It runs in the site's page with `credentials: "include"`, CORS and
  browser cookie rules; the host loads the site origin in the page first when the page
  is on another origin. Use it for a request that needs
  page JavaScript context or the page origin, and for a bot challenge curl can't pass.

When curl fails before sending, or on a safe read, the mint's relay repeats that request
once through the page's fetch and records which transport worked. Runs use the transport
your test used and never switch after a failure; a request that declares
`page-environment` goes to the page's fetch at run time too. The Kernel script,
`src/tool.mjs`, does its site HTTP inside a call with `page.evaluate(() => fetch(...))`,
never `page.request` or a Node-side fetch. Native HTTP without a browser is parked.

## Bot challenges

<!-- pomerado:section http-mcp.challenges:start
`readJson` and `readText` from `runtime/index.js` check each answer for a bot-protection
challenge page in place of the site's answer: after one on a safe read, they send the request
once more over the page's fetch, then check the status and content, and fail with what came
back. `requestPastChallenge` does the retry alone, and `isBotChallenge` tells you whether the
host found a challenge in a response. The host recognizes challenge pages; a host that
recognizes none reads every answer as the site's, so a site's own 403 or 429 is its answer.
For a challenge it misses, send the request with `requires: ["page-environment"]` yourself.
Because the retry is in your code, runs do the same. If the page's fetch is challenged too, say so in coverage; the Playwright version then
publishes alone.
pomerado:section http-mcp.challenges:end -->

The relay refuses nothing it carries. The host records every request, and Guardian's
publication review sees each one that sent a credential (the password, a one-time code)
to another site and judges your source for it: never send a credential to another site.
There is no route allowlist, so any route may be requested.

## Tokens

After each live execution the host writes `captures/session-tokens.json`. It holds this
attempt's live cookies and the credential headers relayed requests sent and received,
such as authorization, CSRF and Set-Cookie, with their values. The view is transient:
it is never stored, uploaded or published, and passwords and one-time codes are
withheld. Use it to learn which tokens the site issues and where they come from, then
write code that obtains each one at run time. Read a CSRF value from the page, a cookie
or an earlier response and forward it. Never paste a value into source; publication
refuses literal tokens.

## Test it

- **Read:** `execute` purpose `test`, target `liveBrowser`, entrypoint `src/tool-http.mjs`.
  A live test starts like the example: the site origin page, with the session saved right after
  sign-in for a signed-in read, or with exploration cookies and storage cleared for an
  anonymous one. So it cannot pass on state exploration left. The host records the
  result as the HTTP version's live evidence: transport, duration and output schemas.
  Compare its output with the example's IDs, counts and fields. If that one test fails, do
  not test again: say why in coverage, delete `src/tool-http.mjs` and publish the Playwright
  version alone. Get the parsing right offline first, against the recorded exchanges, so the
  one live test counts.
- **Read why it failed:** a failed execution's `result.cause.class` says where the failure
  came from. `transport`: the relay, proxy or provider could not complete the request, so the
  site's answer never came back; `cause.http` has the request, `transport`, `durationMs`, the
  host's screened `detail` and, when the page's fetch replaced a failed curl attempt,
  `curlFailure`. That is not evidence your request is wrong. `destination_status`: the site
  answered with `cause.http.status`. `parsing`: an answer did not parse or decode.
  `output_contract`: your output missed its schema. `request_refused`: the host refused the
  request unsent, such as `unsupported_capability`. `cancelled`: the execution was interrupted, or its
  own deadline ran out before the request finished (`deadline_exceeded` without `transport`);
  a relay timeout on the transport is `transport`. `parsing` with `code: "invalid_response"`
  means the provider's envelope did not decode, not the site's body. `destination_status`
  with `code: "response_too_large"` and a 2xx status means the site answered normally with a
  body over the limit: lower what you fetch or raise `maxResponseBytes`, don't treat it as
  an error page.
  `readText` and `readJson` classify the site's answers; an error you throw yourself has no
  cause unless it keeps the `HttpFailure` as its `cause`.
- **Write:** the real write is the act session, which runs the Playwright version; the
  host refuses an act step or residual whose entrypoint is `*-http.mjs`. Write the HTTP
  version from the session's state-changing requests and captures, and never run a
  second write to compare. Test it offline with target `savedHTTP`, selecting the
  session's capture (`capture.json`) or its response bodies as `fixtureRefs`. `SiteHttp` then replays the
  recorded exchanges, as the testing skill describes. A passing replay is the only
  evidence a write's HTTP version can have.
- Replay also helps a read: iterate on parsing without touching the site.
- A test counts only for the `src/tool-http.mjs` it ran, and its schemas must match the
  published ones: a read's example, or a write's composed script, whose declared write
  confirmation the HTTP version must match too. After you edit the file, test it again before `finish_build`.

Fail loudly on an unexpected status or shape. Never return an empty result for a
response you didn't understand, and never repeat a login or a write after a parse
failure.

## What publishes and runs

The host decides from its own records, never from your claims:

- A read whose HTTP version passed a live test with the schemas it publishes runs `http`
  first, with the Kernel script as its fallback. After a run falls back (on its entry
  page with the cookies and site storage the run started with), maintenance repairs the HTTP
  version.
- A read whose example itself ran `src/tool-http.mjs` publishes `http` alone.
- For a read without a passing HTTP test of the current file, finish_build asks once, and
  only while live capture is open: `http_implementation_untested` to try one, or
  `http_implementation_stale` when the file changed since its passing test. If an HTTP
  version is impossible, for example because page code signs every request, say why in
  coverage, delete `src/tool-http.mjs` and call finish_build again. The Playwright script
  then publishes alone, and deleting a file you ran is that choice, so the host never asks
  about it. Once a publication took the browser's capture, nobody asks until a live run opens
  a fresh browser: a stale or untested file then publishes the Playwright script alone. Ship
  an HTTP version only after it passes a live test, never an untested or failed one beside the
  Playwright script.
- A write's HTTP version is stored, and is `http` first only after a passing recorded
  replay. Runs use it only when the operator turns on write promotion, which is off by
  default. An HTTP write failure goes straight to maintenance, never to a Playwright
  retry.

In maintenance, failure code `HttpImplementationFailed` means the HTTP version failed in a
run; for a read, its Playwright fallback may already have answered the caller. Read the
original attempt's relay capture and repair `src/tool-http.mjs`. For a read, test it live
again. When the original failure is a bot challenge on a read published with no Playwright
version, don't repair the HTTP version: write the Playwright version, delete
`src/tool-http.mjs` and publish the Playwright version alone.
For a write, never run it live: replay the original attempt's capture offline
(target `savedHTTP`).
Failure code `HttpSignInTemplateFailed` means the run's explicit direct sign-in request failed.
Read its original failure evidence and repair that request without sending unchanged credentials again. The host won't send
the unchanged `src/website-auth-http.json`; correct it against the login page (see the auth
skill) and `authenticate` again.

## The SiteHttp contract

`http.siteOrigin` is the job's site origin. `request({ url, method, headers?, body?,
requires?, timeoutMs?, maxResponseBytes? })` accepts text request bodies and returns
finite response `body` bytes, status, multi-value header arrays, `transport`, `requestUrl`
(the absolute URL requested) and explicit gaps. A 401, 403 or 429 remains a response for
site code to interpret. Curl responses expose no final URL or redirect chain; the page's
fetch gives `finalUrl`, and its visible headers exclude Set-Cookie even though the browser
updates its cookie jar. Streaming and binary
uploads are not supported. The default timeout is 60 seconds through the finite body,
bounded by the execution deadline. Response bodies use an 8 MiB ceiling; declare
`buffered-response-v1` in `requires` to select that versioned contract and optionally a
lower `maxResponseBytes`. Larger bodies fail as `response_too_large` without a partial
body. Cancellation cannot prove an in-flight website effect was undone.

Do not assume an API-looking URL returns JSON when opened with `page.goto`: document
navigation can negotiate HTML. For a demonstrated JSON endpoint, send
`Accept: application/json`, then check status and Content-Type before decoding.
Unexpected HTML may be a login, challenge, error or alternate representation. See
`references/kernel-page-fetch.ts` for a Kernel script's in-page fetch and parsing. Binary and SSE/WebSocket
decoding need a supported framing contract; infinite streams are not completed bodies.

Design operation families around useful resources and stable IDs, with accurate Effect
schemas, input/output descriptions, dynamic choice resolvers and scoped pagination.
Related operations share connection and login scope. Public definitions contain business
schemas and behaviour; source, captures and credentials stay private. An MCP OAuth token
authorizes Pomerado, not the website login.
