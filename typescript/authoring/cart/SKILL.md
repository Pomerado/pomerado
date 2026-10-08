---
name: cart
description: Read before building any tool that reads, adds to, changes or checks out a cart: sign in first, read the cart before and after, quantity, account values and site limits.
---

# Carts and checkout

Read this for any tool that reads, adds to, changes or checks out a cart. For a write, the
writes skill's session, commit and publication rules still apply; this adds what a cart needs.

## Sign in first

A cart or checkout always runs on the caller's account, because a signed-out cart lives in one
browser session and a later call cannot find it. Sign in before the first `act` step (the auth
skill), even when the site lets a guest add to a cart. Never use a signed-out cart in place of
the account's, and never judge the account's cart from one.

## Take the product as the site's tools do

Take the product as the identifier and option values the site's own pages use, such as a
product number and a size, so a caller can pass a search or details tool's output straight in.
When `reference/site-tools.json` lists such a tool, use its identifier, field names and option
values (the core skill). Quantity and each option the product offers are inputs. A value the
product does not offer throws `InvalidInput`, as the core skill says.

## Quantity

The request decides whether quantity adds that many to the cart or sets the line to that
number; ask when it does not settle which. Build only that one, and state it in the tool's
description and the quantity field's description, such as "Units to add; an existing line grows
by this many".

## Read the cart before and after

Read the cart's lines before the write, in the session and in the composed script; never
assume the cart starts empty. Afterwards, confirm from the cart itself that the line reached
the expected quantity (the earlier quantity plus the input, or the input) and that every other
line is unchanged, then return the lines as read and call `verified()`. A checkout reads the
lines it is about to buy before its commit and returns them with the confirmation.

## Values the account lacks

A value the flow needs that the account lacks, such as a delivery address, is a question for
the caller: ask with `request_input` while building, and in the tool take it as an input or a
declared question (the caller-input skill). Never invent it, and never save it to the account
unasked. A save option the page pre-selects is a question, as `AGENTS.md` says; in the
tool, an unset save option means off, not the page's default.

## Minimums and refusals

When the site refuses the order as asked, such as an order under its minimum or an empty cart
at checkout, the tool throws `InvalidInput` with the site's reason, before its commit mark
whenever the page shows the limit first. Never add items, raise a quantity or change the
delivery method to meet a limit. While building, ask the caller to revise or stop, as
`AGENTS.md` says. When they stop, or their answer cannot be met either, end with
`report_blocked` and explain the site's limit: a build that only reached the limit never
completed the write, so it never publishes.

## Description

The description states the decisions a caller needs to use the tool right (the publication
skill): that it acts on the signed-in account's cart, whether quantity adds or sets, what it
returns, and what it leaves out, such as placing the order.
