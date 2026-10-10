---
name: pagination
description: Read before settling the schema of any tool that returns a list: page size, the cursor, numbered pages, next links, load more, infinite scroll, the site's own list API, changed lists and when to stop.
---

# Return a page and a way to the next

Any tool that returns a list the site can run past one page, such as search results, orders,
statements, messages or reviews, returns one page per call and a cursor for the next. A caller
that wants more calls again with the same inputs and that cursor. No browser stays open between
calls: each call is a fresh run that rebuilds its position from the cursor alone, signed in or
not.

## The contract

Spread `listInputFields` into the input schema's fields and `listOutputFields` into the output
schema's: `limit` (1 to 50, default 20) and `cursor`; `next_cursor`, `next_cursor_expires_at`,
`has_more`, `total_results` and `list_changed`. Never rename them or write your own. Return rows
in the site's order; rows the site promotes stay in place, count toward `limit` and carry their
mark as a boolean. `total_results` is the site's own exact count, null when it shows none or an
approximate one. The description says: "Returns up to `limit` results per call (default 20).
When `next_cursor` is not null, call again within an hour with the same inputs and `cursor` set
to it for the results that follow," and names how the site pages and its page size.

## The cursor

The host signs every cursor and checks it before the next run starts: a cursor that is altered,
expired, from another tool or for other inputs never reaches your code. Call
`startList(input, { mechanism })` before any browser work; it gives you `limit` and the position
to continue from, and refuses a cursor from before the tool paged another way. Build the output
with `selectRows` and `finishList`. Never write, sign or parse a cursor yourself, and never put
page text, a secret or an account's value into a position; row keys are hashed for you. A row's
key is its stable ID; when the site shows a promoted copy of a row it also lists, give the copy
its own key, such as `sponsored:` and the ID, so both stay.

## Find how the site pages

While building, scroll to the end of the list for a typical query and note the page links, a
Next link, a "Load more" control, rows that appear as you scroll, and the requests that bring
the next rows. Pick the first that fits, and name it as the mechanism:

- `api`: the page fetches rows from its own list endpoint with an offset, page or cursor
  parameter. Open the results page, then call the endpoint inside the page with the site's own
  token or offset as the position's `token` or `offset`. Keep the visible mechanism as the
  fallback when the endpoint refuses or changes.
- `pages` or `next_link`: keep the site's own link to the next page, exactly as this run read
  it, as the position's `href`. The host accepts only a link on the tool's site. Open it, then
  read back the query, filters, sort and page number. If that fails, run the search and follow
  the site's page links or Next. Never edit a page number or offset into a URL yourself.
- `append` or `scroll`: repeat the one action, a "Load more" click or scrolling the last row
  into view, waiting for the row count to grow each time, until the list holds the window, and
  keep the count as the position's `steps`. On a list that drops earlier rows as it scrolls,
  collect rows by key as they show. If the URL gains a page parameter after a step, the site is
  paged: keep that link.
- `offset`: the whole list is on one page; the position's `offset` is where the next window
  starts. With any mechanism, when `limit` is smaller than the site's page, the next position
  points into that page by its `offset`.

## Changed lists

Lists change between calls. Pass `selectRows` the rows you read from where the position starts,
in the site's order: it continues after the last row the previous page returned, wherever that
row now is, drops rows already returned, and says the list changed when that row is gone or a
returned row came back. When it is gone, it repeats rows rather than skipping them. Return its `listChanged` as `list_changed`. When the site applied a
context the caller did not set, such as a location it picked, pass it as `context` to both, so a
different one sets `list_changed`. When dropping leaves fewer than `limit`, read on. Never
promise a snapshot the site does not keep.

## Stop

Return as soon as you hold `limit` rows. Per call, read at most 5 site pages or 10 steps, within
`remainingMs()`; when a bound stops you, return what you read with a position that continues.
`finishList` sets `next_cursor` to null past the deepest position a tool can rebuild without the
site's link or token (10 site pages or 20 steps); `has_more` stays true, and the description
names that depth. When the site refuses its own link or token and the position cannot be
rebuilt, throw `errors.InvalidInput` with `field: "cursor"` and `kind: "site_expired"`. Never
return a position the tool could not follow.

## Wait only for this page's rows

Wait for the list's answer, then for the key fields of the rows you return: identifier, name and
each value the request needs. Do not wait for rows outside the window, for the whole list to
settle or for slots the site fills late; a slot with no identifier is a placeholder.

## Signed-in lists

The same rules apply under the account the host bound to this run. The saved profile restores
the sign-in, not a page, a server's cursor, drafts or form state. Keep a list's scope, such as a
year or tab, in the position's `scope` as the site's own value. Never recreate a hold, draft,
upload, payment token or write in order to page.

## A list that fits on one page

Every list tool takes the contract. When the site shows the whole list at once, `limit` still
caps each call, the position's `offset` continues it, and the description says the site shows
the whole list.

## Test it

Run page one, then page two live with the cursor page one returned: page two continues the
order and repeats no row. Reach a last page, for example with a narrow query, and check that
`next_cursor` is null. `references/pagination.ts` is a compiling pattern for a paged site with a
Next link; its reads are site logic, not a pagination engine.
<!-- pomerado:section pagination.cursor-scope:start

## Standalone cursor scope

A logical cursor is not proof of browser or account identity. Validate its supplied query and scope before effects, verify the current page and account context, and reconstruct only a repeatable read when the evidence supports it. Never recreate a write to recover a cursor.

pomerado:section pagination.cursor-scope:end -->
