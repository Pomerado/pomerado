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
filters", "More" or "Show all" button (core skill, the input schema). Make every
control that narrows or orders the results an optional input wired to its control, even one the
request never names; leave out only controls that change neither which results come back nor
their order, such as a layout or language switch.

- Take each input's choices from the site. When it offers the same choices for every query, the
  enum lists all of them as the page shows them. When they depend on the query, such as sizes or
  brands, take a string and match it against the choices this search's page shows.
- Filters and sort are choices: set them as "Configure, then read" in the core skill says, and
  read the results last. When the page's list of choices does not hold a caller's value, the
  tool throws `InvalidInput` with `field` and `available`, the choices this search's page
  offers, only after reading them. A control the tool could not find, open or apply makes it
  throw `OperationFailure`.
- A price or other numeric range is a number, never a label to match: a slider's labels and
  steps often change with the result set. Set the nearest step inside the caller's bound (down
  for a maximum, up for a minimum), the range's end for a value outside it, read the applied
  bound back and return it beside the results (core skill, "Configure, then read").
- A filter group the page disables for this result set, such as a price filter when only one
  result shows, is part of the answer: check that a group is enabled before opening it, never
  wait on a disabled one, and return the results with that filter reported as not offered.
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

When results, prices or availability depend on a location or store that the site lets a visitor
set, make it an input and apply it as the core skill's input schema says. If the site says it has
no such location or store, the tool throws `InvalidInput` with `field` and `available`, the ones
it offers. When the page does not apply the caller's location, the tool throws
`LocationNotApplied` with the requested and applied location (core skill); it never returns
results for the page's own location in their place.

## Categories and collections

A search box is one way into the site's product grid; its navigation is another. When a query
term names a collection or category, such as sale, new arrivals, clearance or a department, or
when the search's results are thin or miss items the site clearly carries, check the navigation
before you settle the inputs:

1. Open the site's menus, drawers and category links, and list each category's label, its
   parent and its link.
2. Search the term too. A search that treats a category word as text, with few or unrelated
   results, shows the category is the way in.
3. Open one category page and compare it with the search results: the same cards, filters, sort
   and paging mean one template.

When they share the template, make one browse tool rather than a search tool and a fixed
category tool:

- Offer an optional `category` input beside an optional `query`, with at least one required.
  Take the category choices from the navigation while you build, as the labels the site shows,
  such as "Shoes > Sale": an enum when the tree is fixed, otherwise a string matched against the
  navigation's links on each run, refused with `available` when no link matches.
- Open the category through its navigation link, or the link's own `href`, then apply the
  query, filters, sort and pagination as on search results, and return the same card shape,
  with the category's heading or breadcrumb as applied.
- Never hard-code one category, such as a sale-only tool: a category is a value the caller
  could vary (core skill).

## Results

Wait for the search's answer with `waitForOutcome` (core skill). Prefer naming its error, its
no-results message and its results over waiting for the results alone. Read every field of every
result from that result's own card on every run. Lean toward more information (core skill,
output fields): return the facts on each card a caller could reasonably use to choose among
results, with full displayed values, and a maker or provider line in its own field. When only
some cards show a fact, its field is nullable and null exactly on the cards that don't. Read the
results only once every card you return is filled in. When the site marks results as suggestions
rather than matches, such as "no exact matches, showing similar items", return that. Keep the
matches apart from related items, recommendations and sponsored carousels, which go in their own
list or are left out, never mixed into the results, and return each item once. A card that stands
for a group of variants, such as "6 flavors" or "3 colors", says so in its own fields, such as a
variant count, and that its link opens one member of the group. Check that the page's echo of the
query, such as a results heading, matches it normalized, never with exact case-sensitive
equality. A search
that applied every input and got the site's no-results message returns an empty list, never an
error.

## Describe and test it

The description briefly states the design decisions, limits and interpretations a caller needs,
such as the site's default location, a fixed page size or the first page only. Set every input
you expose in at least one live run before publishing, as the testing skill says, and give each
an `examples` value the site offers for a typical query.
