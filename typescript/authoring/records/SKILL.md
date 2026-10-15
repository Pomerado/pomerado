---
name: records
description: Read before building a tool that reads or writes records or table rows in an app whose fields are user-defined or found at run time, such as a CRM's objects, a database or spreadsheet's rows or an app's custom objects: a small default keyed by field names, a field projection, field definitions only on request, and output the site's write tools accept.
---

# Records and tables

Read this when the task is extracting records or table rows from an app whose fields are the
caller's own: user-defined or found at run time, such as a CRM's objects and custom fields, the
rows of a table, database or spreadsheet app, or an app's custom objects. Such a record type can
hold dozens of fields, and its owner adds and renames them. A caller of such a tool often wants a
quick, small answer and sometimes the full detail, and the request rarely says which. Offer both
without being asked, as below.

For these tools this skill takes precedence over the core and search skills' lean toward more
information and their one typed output field per fact: the default output is small, and the
`fields` projection and the `include` sections give every other field. A record type whose fields
are fixed and known while building, such as an invoice or ticket list with the same columns for
every account, keeps the core skill's typed fields, one per fact; it takes from this skill only
the small default with `fields` and `include: ["schema"]` where its records are large, and the
round-trip rule. A tool that only writes such records takes "Output that round-trips" and the
writes skill's read-back. The pagination skill still applies.

## Record everything, return a little

While building, record as much as the site holds for the record type: every field or column, the
name people see for it, its type, whether a caller can write it, its choices, and for a link to
another record or a person, what it points to and how a write names it. Read them from the
site's own field list, column headers, settings page or the data request the page sends. That
survey is build evidence: it decides the tool's keys, its `fields` input and its `schema`
section. Only the published default is small. A list of 20 records should come to a few
kilobytes, not tens.

## The default output

By default a call returns the records alone. Each record has its own identifier as the site
uses it, `id`, and an object `fields` of its values. Because the field set is the caller's own,
the values are one object typed by the value union below, in place of one output field per fact:

- Keyed by the name people see for each field or column, such as `Company` or `Close date`, or the
  site's own API name for it where its write path takes that name. Never key by an internal
  column or field ID, such as `fld_8f2a1c`. When the site's data comes keyed by such IDs, map them
  to names in the tool's code from the site's own field or column list, read in the same run,
  never from a mapping copied from the build: columns are added and renamed.
- Only the fields that hold a value. An empty field is left out, and the description says that a
  missing key means empty.
- A link to another record, a person or a linked row as `{ "id": "...", "label": "..." }`, with
  the label the site shows for it, and a list of them for a field that holds several.
- A choice, status or tag as its label, and several as a list of labels, never the site's option
  ID alone.
- Numbers as numbers, dates as `YYYY-MM-DD` and timestamps as ISO 8601, in the form the site's
  write tools take (below).

Leave out by default the site's system and internal fields: its own bookkeeping, such as row
positions, version counters, deleted flags, internal workspace or owner IDs, and audit fields such
as created by or updated at unless the task names them. Never return field definitions in the
default output: no type lists, nested creation shapes for linked records, filter operators for
each field or nested path, or the site's whole field metadata on every call.

A record shape that holds these, with a `description` annotation on each part (core skill):

```js
const Link = Schema.Struct({ id: Schema.String, label: Schema.String });
const Value = Schema.Union(
  Schema.String, Schema.Number, Schema.Boolean, Schema.Null, Link,
  Schema.Array(Schema.Union(Schema.String, Schema.Number, Link)),
);
const Row = Schema.Struct({
  id: Schema.String,
  fields: Schema.Record({ key: Schema.String, value: Value }),
});
```

## Inputs to offer

Add these to the input schema even when the request does not name them:

- `fields`: optional, a list of field names, the same names the output keys by. When set, each
  record returns only those fields and its `id`, every named field present and null where this
  record's is empty. Match names ignoring case and spacing. A name the record type does not have
  throws `InvalidInput` with `field: "fields"` and `available`, the names the site lists
  (caller-input skill), and so does a name that matches several of the site's names that way,
  with those names as `available`; never pick one.
- `include` (core skill, optional sections) with:
  - `schema`: the definitions of every field of the record type, whatever `fields` picks, once
    beside the records, never repeated in each record. A call with a `cursor` leaves it out,
    since the first page returned it, and its description says so. Keep it compact: for each field its `name` (the key the output and
    writes use), its `label` when that differs, `type`, `writable`, `choices` (labels) for a
    choice field, and for a link its `target`, the record type or list it points to, and
    `write_key`, the key and value form a write takes for it, such as the linked record's `id`.
    Nothing else.
  - `system_fields`: the system and internal fields left out above.
  - Any part of a record that costs another request or click per record, such as its comments,
    activity or attachments, named for what it holds.
- The site's own filters, sort and search over the records (search skill), and `limit` and
  `cursor` (pagination skill).

## Output that round-trips

Callers read records to act on them. Use the keys and value forms the same site's write tools
take, so a read's output feeds a create or update without reshaping. When
`reference/site-tools.json` lists a write tool for these records, take its field names and value
forms; when building such a write, take the read tool's, and accept `fields` keyed the same way.
A link reads as `{ id, label }`, and a write takes its `id`, or a label it resolves to an ID
through the site's own list (writes skill, "Check the read-back"). A choice reads and writes as
its label. A value a caller cannot write, such as a formula's result, is `writable: false` in
`schema`.

## Fields that are hard to read

A field type the tool cannot read cleanly, such as a formula, a rich document or an attachment,
returns the text the site displays for it when that is useful, and `schema` gives its type. Leave
a field type out only when it is genuinely hard and optional to the request, and say in the
description which types the tool leaves out and why; when unsure, ask the owner (`AGENTS.md`,
"Solve before you narrow"). Never leave out a field the request names.

## Describe it

The description says that a call returns the records with their filled-in fields, keyed by field
name, so a missing key means empty, that `fields` picks fields and returns each one named, null
when empty, that `include: ["schema"]` adds the field definitions on the first page, and how the
site pages.
