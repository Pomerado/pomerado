---
name: pagination
description: Scoped logical read continuation through warm state or fresh reconstruction.
---

# Continue a read on either path

A cursor represents the query and a logical position under the same authorized
tenant/account/site. The host protects and validates that scope; a saved profile
or an agent's remembered Page is not a cursor authenticity check.

<!-- pomerado:section pagination.continuation -->

<!-- pomerado:section pagination.no-recreated-writes -->

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
<!-- pomerado:section pagination.cursor-scope:start

## Standalone cursor scope

A logical cursor is not proof of browser or account identity. Validate its supplied query and scope before effects, verify the current page and account context, and reconstruct only a repeatable read when the evidence supports it. Never recreate a write to recover a cursor.

pomerado:section pagination.cursor-scope:end -->
