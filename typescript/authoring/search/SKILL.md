---
name: search
description: Read before settling a search or listing tool's inputs: the site's own filters, sort and location, applied and read back, and honest empty results.
---

# Build a search from the site's own controls

A search or listing tool returns what the site shows for the caller's query and filters. Every
input changes what the site does on that run, and every value it returns comes from that run's
results. "The tool throws" below means the published tool's code throws at run time, so that run
fails or reports a bad input; it never means ending the build.

## Find the filters

Before you settle the input schema, open the results for a typical query and read every control
that narrows, orders or configures them: the filter panel, chips, the sort menu, range sliders
and boxes, toggles, and every group that is collapsed, scrolled out of view or behind an "All
filters", "More" or "Show all" button. Open each collapsed group and list its options. Make every
control that narrows or orders the results an optional input wired to its control, even one the
request never names; leave out only controls that change neither which results come back nor
their order, such as a layout or language switch.

- Take each input's choices from the site. When it offers the same choices for every query, the
  enum lists all of them as the page shows them. When they depend on the query, such as sizes or
  brands, take a string and match it against the choices this search's page shows.
- Filters and sort are choices: set them as "Configure, then read" in the core skill says, and
  read the results last. When the page does not offer a caller's value, the tool throws
  `InvalidInput` with `field` and `available`, the choices this search's page offers, only after
  reading them. A control the tool could not find, open or apply makes it throw
  `OperationFailure`.
- Never set a filter or sort in code, even one the request names: each is an input. When the
  site offers a sort, it is an optional input listing every order the site offers. A page size
  visitors cannot change is the site's; state it in the description.

## Apply and read back

On every run, set each input through the site's own control, then read it back from the site's
committed state: the applied-filter chips, the selected sort, an option the site shows selected,
or the results header. A URL naming the input does not show it applied. When a filter did not
apply, the tool throws `OperationFailure` naming it, so the run fails and the tool gets repaired;
it never returns unfiltered results as filtered.

For a control inside a drawer or collapsed group, open the group first and wait for its panel to
show and any loading overlay to clear; click the visible label or option, never a hidden input;
when choosing reloads or navigates the results, wait for the new results, then reopen the panel
to read the choice back. After each change, wait for the results themselves to fill in and
stop changing, as the core skill's readiness rules say.

## Location

When results, prices or availability depend on a location or store, and the site lets a visitor
set one (a ZIP, city or address box, or a store picker), make it an optional input, such as
`zip_code` and, when the site offers stores, `store`, as the core skill says. Set it on every run
through the site's own location control, take the site's matching suggestion, then read the
applied location back from the page, such as the header's ZIP, city or store name, and return it.
When the caller leaves it unset, return the location the page shows and say in the description
that the site picks it, which can differ from run to run. If the page does not apply the caller's
value, the tool throws `OperationFailure`; if the site says it has no such location or store, it
throws `InvalidInput` with `field` and `available`, the stores it offers. Setting a location in
the run's own browser is part of the read: the browser is fresh and discarded, so nothing is
saved, and a tool that never signs in has no account to change. In a signed-in tool, use the
site's per-visit location control and never save an address, default store or preference to the
account. While building, ask the owner for a location; they may skip it.

## Results

Read every field of every result from that result's own card on every run. Each result carries
every fact its card shows (core skill, output fields): the full name with any maker or provider
line, each amount with its terms, the rating and its count, availability, badges and the
result's link. When only some cards show a fact, its field is nullable and null exactly on the
cards that don't. Read the results only once every card you return is filled in. When the site
marks results as suggestions rather than matches, such as "no exact matches, showing similar
items", return that. A search that applied every input and got the site's no-results message
returns an empty list, never an error.

## Describe and test it

The description briefly states the design decisions, limits and interpretations a caller needs,
such as the site's default location, a fixed page size or the first page only. Set every input
you expose in at least one live run before publishing, as the testing skill says, and give each
an `examples` value the site offers for a typical query.
