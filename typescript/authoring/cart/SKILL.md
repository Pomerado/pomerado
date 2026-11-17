---
name: cart
description: Read before building any tool that reads, adds to, changes or checks out a cart: when to sign in or use a guest cart or checkout, read the cart before and after, quantity, account values and site limits.
---

# Carts and checkout

Read this for any tool that reads, adds to, changes or checks out a cart. A read tool may open a
checkout only to read what it offers, choosing, entering and saving nothing. For a write, the
writes skill's session, commit and publication rules still apply; this adds what a cart needs.
When the site has other cart tools (the core skill, `reference/site-tools.json`), prefer carrying
over their handling of the page states this tool shares with them.

## Sign in, or use a guest cart or checkout

A cart a later call must find, such as a standalone add-to-cart, view-cart, change-cart or
checkout tool's, runs on the caller's account, because a signed-out cart lives in one browser
session. Sign in before reading or changing it (for a write, before the first `act` step; the
auth skill), even when the site lets a guest add to a cart, and judge the account's cart only
from the account.

A tool that fills a cart and returns its quote in one run, such as the items, totals, shipping,
tax, fees and any quote or cart number the site shows, and stops before checkout, may use the
site's guest cart when the build holds no login. No later call must find that cart, so the tool
needs no sign-in, and the rule above is no reason to ask the caller for one. A tool whose cart the
caller means to view, change or check out in a later call is not such a tool, even when it returns
the cart's lines and totals.

A tool that fills the cart and places the order in the same run may use the site's guest
checkout when the site offers one and the build holds no login. Prefer either to creating an
account. Decide before you sign in, since a build that sent a login keeps it. Take the guest's
contact details as inputs, and fill the card as the caller-input skill says.

## Take the product as the site's tools do

Take the product as the identifier and option values the site's own pages use, such as a
product number and a size, so a caller can pass a search or details tool's output straight in.
When `reference/site-tools.json` lists such a tool, use its identifier, field names and option
values (the core skill). Quantity, each option the product offers and, when the site lets a
visitor set one, the location or store are inputs. When the store, stock or prices follow the
delivery address, an add-to-cart tool takes it as an optional input, one of the account's saved
addresses, and keeps the address the account has selected when it is left out: an add places no
order, and a checkout still chooses its address as below. Set the options as "Configure, then
read" in the core skill says before adding the product: a value the product does not offer
throws `InvalidInput` with `field` and `available`. Opening an item's details or options from
its own card, name or picture, not a control labelled add or plus, is a read. Prefer finding
the item's row or card by the site's own item ID where the page carries one, over its picture or
position, since a site's pages can differ in layout. Where the page carries no item ID, open each
card with the requested name in turn and keep the one whose own details prove the requested ID;
when each card's details show another ID, refuse with `InvalidInput` before the add's commit
mark, naming those IDs.

A product identifier the site has no page for opens its not-found page or a search: name that
page among the answers of every wait on the product page, and refuse with `InvalidInput` and the
site's words, `field` that input, before any commit mark (the core skill).

An item's options often come in groups whose option labels repeat, such as "None" or "Less"
under both a sweetness group and an ice group. Find each option inside its own group, by the
group's heading or fieldset, never by its label across the whole item dialog. A list of saved
addresses or stores can show the same name twice: choose by every part the input gives, such as
the unit, and refuse when more than one entry still matches, never take the first. Choose a
saved address with the core skill's address helpers, such as `resolveAddress` from
`pomerado/runtime` with the saved entries as its suggestions, and compare a part they leave
aside, such as the unit, with `sameText`, never with matching of your own.

When the tool takes an item's or store's page link as its identity, compare the identifiers in
it, such as the store and item ids, after decoding both links, never the raw text of a name in
the path, which the site may encode in more than one way, and ignore tracking parameters and a
trailing slash.

## Quantity

The request decides whether quantity adds that many to the cart or sets the line to that
number; ask when it does not settle which. Build only that one, and state it in the tool's
description and the quantity field's description, such as "Units to add; an existing line grows
by this many". A quantity stepper you cannot type into holds its value in its accessible value
or its text; read it there, and change it with its own buttons.

## Read the cart before and after

Read the cart's lines before the write, in the session and in the composed script; never
assume the cart starts empty, except as the last paragraph of this section says. Afterwards,
confirm from the cart itself that the line reached
the expected quantity (the earlier quantity plus the input, or the input), then call
`verified()`, compare every other line with the before read and return the lines as read.
Prefer needing only each line's identity, chosen options and quantity in that read, with every
other value optional, so a price the page doesn't show clearly can't fail the read before
`verified()` (writes skill, "Check the read-back"). When comparing lines
before and after, such as to list other lines that changed, prefer comparing
`unit_price_minor` with `unit_price_minor` and `line_total_minor` with `line_total_minor` (core
skill, output fields), so a line's quantity, new or above one, doesn't read as a price change.
After the tool's final commit, a line that changed to another quantity than expected, such as
one the site capped, is still the written line: call `verified()` and list it in
`saved_differences` (writes skill). A checkout reads the lines it is about to buy before its
commit and returns them with the confirmation.

An account can hold several carts at once, such as one per store or a separate section for some
items, each with its own lines and totals, and a page may show one at a time. Find the cart the
call is about by the store or section its input or item names, open it through the site's own
control for that cart, and read its lines, count and subtotal inside that cart's own container.
Lines in another cart stay out of that read and out of the comparison of other lines.

In a tool that places the order, when the page shows no cart control and no empty-cart label,
take the cart as empty. Then read back every line of the checkout's order summary with the other
reads before the card fill, or before pressing pay when there is none, and confirm it holds only
the requested items, each at its requested options and quantity; when it holds anything else,
throw `OperationFailure` before the order's commit mark.

## Several carts on one account

Some sites keep a separate cart for each store or seller in one account, such as food delivery,
grocery and multi-vendor marketplaces, and list them in a cart switcher. Act on one cart, found
by the cart or store identifier the site shows, taken as an input when the caller names a cart,
and leave every other cart as it is. When the site asks to clear another cart before adding,
that is a question for the caller (the writes skill). The switcher and the other carts are the
caller's other records: in every step's output, while building and in the tool, return only the
target cart's entry, with one exception. To show the others stayed the same, compare them inside
the step and return for each other cart only its identifier, its line count and whether it
changed, never its items, store name or totals.

## The delivery address

When the site sets the delivery address on the account or the session rather than inside
checkout, read the address the cart will use first. When it already matches the input, street
and unit, compared with `readBackMatches` or `sameText` from `pomerado/runtime` (the core skill),
change nothing and ask nothing. Setting it changes the account or session, so choosing
it is a step with its own commit mark, and saving an address-book entry is another, separate one
(the writes skill). Set it only when it differs, after every check that can refuse, such as
finding the item and its options and that it can be ordered now, so a refusal leaves the account
as it was. When the store, stock or whether the item can be ordered follow the address, read them
for the input's address without saving it where the site allows, such as through an address
preview or a store page that takes the address in its link, and refuse before the marked step.
Otherwise set the address with the site's control that picks one for this order, then check, and
when one refuses, say in the refusal that the account's address changed. Prefer that control
over editing a saved address. When saving the address-book entry is the only way to apply a
detail such as the unit, ask any question about it only on a run that needs the save.

## Values the account lacks

A value the flow needs that the account lacks, such as a delivery address, is a question for
the caller: ask with `request_input` while building, and in the tool take it as an input or a
declared question (the caller-input skill). Never invent it, and never save it to the account
unasked. Fill only the billing fields the card form shows; a card form that asks for part of an
address is no reason to ask the caller for the rest of the address. A save option the page
pre-selects is a question, as `AGENTS.md` says; in the tool, an unset save option means off, not
the page's default.

Choosing the delivery address and payment method is part of a checkout's job, even when the
account has saved ones the page pre-selects: take each from the input, such as which saved
address or a new one, or ask before the commit mark which to use (the writes skill). Never use
the page's selection silently. Offer each saved address and payment method as an
account-specific option with its masked label (the caller-input skill), and say in the labels
which one the page pre-selects. Take a saved address or payment method the caller names as the
caller-input skill says, asking rather than refusing when it matches none or several. Choose it
for this order only, leaving the saved entries and the account's defaults as they are, and when
the page shows that the choice changed a default, report it in its own output field (writes
skill). A paid add-on within the tool's purpose, such as a protection plan for the item bought,
is an input or a question too. A paid membership, subscription or trial the checkout offers is
outside its purpose: decline it without asking, never accept it without an input the caller set,
and handle its pop-up as conditional (the forms skill), since it shows only to some accounts.

## Minimums and refusals

When the site refuses the order as asked, such as an order under its minimum or an empty cart
at checkout, the tool throws `new errors.InvalidInput(message, { field })` with the site's
reason, `field` the input the caller would change, before its commit mark whenever the page shows
the limit first. When the page shows a per-item limit and the cart already holds that many of the
item, prefer refusing the same way before the add's commit mark.
A checkout that takes a limit of the caller's, such as
a maximum total, reads the final total and compares it before the order's commit mark, and
refuses with `InvalidInput`, `field` that input and `kind: "over_price_limit"`, giving the total
and the limit (the caller-input skill). Run each refusal of the caller's own input as soon as the
page shows what it needs, before any check of the page's state that fails the run. Check only the
options the tool sets or the caller asked for; read any other preselected option, except a
membership, subscription, trial or safety default the tool turns off, as page state and name it in
the confirm, rather than failing. Check the caller's limit against the total the page
shows before the purchase click. When tax, fees or shipping aren't shown until after it, check the
limit against what is shown, name in the confirm what isn't included yet, and don't refuse for it.
Never add items, raise a quantity or change the
delivery method to meet a limit. While building, ask the
caller to revise or stop, as `AGENTS.md` says. When they stop, or their answer cannot be met
either, end with `report_blocked` and explain the site's limit: a build that only reached the
limit never completed the write, so it never publishes.

An account's state can change the add or buy flow, so that its controls would change an open
order or a line already in the cart instead. A product already in the cart can show that line's
quantity control in place of its add control, so wait for either with `waitForOutcome` (the core
skill), not for the add control alone. Read that state before the commit mark. When the tool's
inputs cover that change, as its quantity does for a line already in the cart (Quantity, above),
continue, bringing a line whose quantity control shows in place of its add control to the earlier
quantity plus the input, or to the input, with that control under the add's commit mark; otherwise
refuse with `InvalidInput` naming the site's state before the commit mark, as the caller-input
skill says for a page's state that rules the task out.

Where the build runs test cases (testing skill), prefer including an item already in the cart
and, for a checkout, a cart under the store's minimum.

An example item that is out of stock doesn't end the build. The tool returns that as the site's
refusal for the item, and the build publishes on it as the writes skill says.

An item or store that can't be ordered right now, such as a store that is closed or takes only
scheduled orders, or an item marked unavailable, often hides or relabels the add control rather
than showing an error. Read the store's and the item's state before waiting for the add control,
and return the state the site shows, in its own words, as the refusal for the item, as for one
out of stock, before any commit mark, setting the address included. Never wait out a timeout for
a control the page replaced.

When the order must take one of a service's tiers of speed, class or service level, take the
caller's choice from an optional input and keep it as given. A delivery speed left unset, or
asked for as "standard", takes the free option the page offers that arrives soonest, for each
shipment, in place of the tier the site presents as standard; with no free option, ask the caller
which to use, showing each fee. For any other tier left unset, choose the tier the site presents
as standard, not one sold as faster, larger or premium; when the site shows no standard tier, ask
the caller which to use.

An "earliest" pickup or delivery time moves with the clock: pick it in the step that places the
order, or right before the card fill when the host fills the card or picking it reloads the
checkout. When the site says that time is gone and offers the next one, the next one is still
the earliest. A time the caller names from a list that moves with the clock is a range: take the
earliest and latest times the caller accepts, and choose the first offered time between them.

In the step that places the order, name the site's reply to that order request and the order's
ID shown on the page as that wait's answers, beside the site's refusal and error messages, as the
writes skill says for a commit, and read the ID from the reply or the page it leaves. Prefer
passing a sign of progress that can show before them as that wait's `loading`, or naming it in
`pending` as the writes skill says, over an answer that ends the wait.

## A checkout's inputs and output

Prefer building a checkout for any order a caller could place on the site, not only the
request's. The inputs and outputs below are good practice, not a must for every checkout: sites
differ, so take and return what this one offers.

Prefer taking as inputs what the site lets a caller choose, such as the items with their options
and quantities, with the unit for an item sold by weight or measure, pickup or delivery with its
place and time, a tip, and a limit such as a maximum total, checked as "Minimums and refusals" says.
Take each as an input without asking the owner whether to, and list a branch the session did not
run as untested (publication skill).

Prefer returning what the site shows for the order placed, such as the order or confirmation
number and its status, the lines bought, the subtotal, fees, tax, tip and total charged, the
payment method as the page labels it, the pickup or delivery time and place, and any link to the
order's status: only fields the session's confirming step read filled for its own order, named and
typed as the core skill says.

Prefer returning each line bought with its quantity, its unit when the site sells it by weight or
measure, its price each and its line total (the core skill's output fields), and each fee as its
own entry, by its name on the site and its amount, with the tip and any discount in their own
fields. This output is a suggestion, separate from the `order` a
purchase's final confirm passes (the caller-input skill), which has its own fixed fields.

Prefer avoiding these, which fit the tool to the build's one order:

- a rule the request sets for that order, such as which item to pick or a price range, written
  into the code, the tool's name or its description: make it an input, with the request's value
  in `exampleInput`, or as its default only when the request states it for every call (the core
  skill);
- a value the page works out for that order, such as its total or a fee, written in as a
  constant, whether passed to `fillCard`, checked before the commit or used to find a control,
  such as a pay button labeled with it: read it in each run;
- an input made required that neither the site nor every caller needs, such as a second address
  line or a price limit, or a choice the site offers, such as an item's options, with no input. A
  costly choice the site pre-selects, such as a tip, still stays an input or a question (the
  writes skill).

## Description

The description states the decisions a caller needs to use the tool right (the publication
skill): that it acts on the signed-in account's cart, checks out as a guest or starts its own
guest cart that lives only inside one run, which no later call or person must find (such as a
tool that fills a cart and returns its quote), whether
quantity adds or sets, what it returns, and what it leaves out, such as placing the order.
