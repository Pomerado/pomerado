---
name: pagination
description: Scoped logical read continuation through warm state or fresh reconstruction.
---

# Continue a read on either path

A cursor represents the query and a logical position under the same authorized
tenant/account/site. The host protects and validates that scope; a saved profile
or an agent's remembered Page is not a cursor authenticity check.

<!-- pomerado:hosted:start
1. Validate cursor/query/account scope before browser effects.
2. Inspect restored live/profile state. Reuse it only if the current signed-in page,
   query and logical position are suitable.
3. Otherwise start from the host's fresh sign-in and reconstruct the
   repeatable read/search, then advance to the logical position. Loading a profile
   does not restore JS heaps, expiring server cursors, drafts or DOM state.
4. Tolerate changing live data. Return observed IDs and coverage; do not promise an
   immutable snapshot if the site has none. Prefer stable IDs over visual row index.
5. If reconstruction is unsupported, return bounded partial data with an explicit
   reason and no pretend next cursor.
pomerado:hosted:end -->

<!-- pomerado:hosted:start
Never recreate a hold, draft, upload, payment token or write as pagination. Unknown
prior effects require recovery, not fresh navigation. A mint question keeps the live
browser for up to 10 minutes; that is not cursor expiry. Profile load/save failure
or 24h inactivity expiry selects fresh reconstruction where supported; it does not
invalidate an otherwise meaningful read cursor.
pomerado:hosted:end -->

## Append pagination ("load more")

Some pages page by appending: a "Load more" or "Show more" control, or scrolling to the
bottom, adds rows to the same list instead of navigating. Detect it when activating the
control leaves the URL and page number unchanged while the row count grows, or when a
scroll adds rows. Then page by repeating that one action and reading only the rows it
added, identified by stable ID, until the control disappears or disables, a step adds no
new rows, or the requested count is met. Bound the loop: a fixed step cap and a time
budget, with a short wait for rows after each step. On hitting a bound, return the rows
read with an explicit reason and no pretend next cursor. Never treat a repeated click as
safe if it could submit or change anything.

Use and test both warm and fresh paths, including expired state, changed live data,
wrong query/account and unsupported reconstruction. `references/pagination.ts`
provides a compiling authoring pattern; its hooks are site logic, not platform
authentication or a universal pagination engine.
<!-- pomerado:standalone:start

## Standalone cursor scope

A logical cursor is not proof of browser or account identity. Validate its supplied query and scope before effects, verify the current page and account context, and reconstruct only a repeatable read when the evidence supports it. Never recreate a write to recover a cursor.

pomerado:standalone:end -->
