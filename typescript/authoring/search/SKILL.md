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
that narrows or orders them: the filter panel, chips, the sort menu, and groups that are collapsed
or behind an "All filters" or "More" button. Record each one that bears on the tool's purpose as
an optional input wired to its control.

- Take each input's choices from the site. When it offers the same choices for every query, the
  enum lists all of them as the page shows them. When they depend on the query, such as sizes or
  brands, take a string and match it against the choices this search's page shows.
- When the page does not offer a caller's value, the tool throws `InvalidInput` naming the
  choices it does offer, only after reading them. A control the tool could not find, open or apply
  makes it throw `OperationFailure`.
- Never set a filter in code, even one the request names: it is an input. A sort or page size the
  code fixes is allowed; say so in the description.

## Apply and read back

On every run, set each input through the site's own control, then read it back from the site's
committed state: the applied-filter chips, the selected sort, an option the site shows selected,
or the results header. A URL naming the input does not show it applied. When a filter did not
apply, the tool throws `OperationFailure` naming it, so the run fails and the tool gets repaired;
it never returns unfiltered results as filtered.

## Location

When results depend on a location the caller can give, such as a ZIP code, make it an optional
input applied through a control that changes only this search, and never save an address or store
to the account. While building, ask the owner for one; they may skip it.

## Results

Wait for the search's answer with `waitForOutcome` (core skill). Prefer naming its error, its
no-results message and its results over waiting for the results alone. Read every field of every
result from that result's own card on every run. When the site marks results as suggestions
rather than matches, such as "no exact matches, showing similar items", return that. A search
that applied every input and got the site's no-results message returns an empty list, never an
error.

## Describe and test it

The description briefly states the design decisions, limits and interpretations a caller needs,
such as the site's default location, a fixed sort or the first page only. Spend one live test on
another query with other filter values set.
