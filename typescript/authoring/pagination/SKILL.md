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

Use and test both warm and fresh paths, including expired state, changed live data,
wrong query/account and unsupported reconstruction. `references/pagination.ts`
provides a compiling authoring pattern; its hooks are site logic, not platform
authentication or a universal pagination engine.
<!-- pomerado:section pagination.cursor-scope:start

## Standalone cursor scope

A logical cursor is not proof of browser or account identity. Validate its supplied query and scope before effects, verify the current page and account context, and reconstruct only a repeatable read when the evidence supports it. Never recreate a write to recover a cursor.

pomerado:section pagination.cursor-scope:end -->
