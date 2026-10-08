import type { BrowserContext, Page } from "playwright";
import type { ExpectedConfirm } from "../../src/browser/dialogs/contracts.js";
import { expectedConfirmDigest } from "../../src/browser/dialogs/expected.js";

/**
 * The contract every host's handling of a run's native dialogs keeps, on one fixture page. The
 * confirm a write's build accepted at a step is accepted again at that step without asking. Every
 * other popup, in the page, in an iframe or in a popup window, asks the caller or is dismissed.
 * None of them is ever accepted, and none is left open.
 *
 * A host runs each case on a fresh page of a context `serveConfirmPopups` serves: it opens
 * `confirmPopupsOrigin`, clicks the case's `selector` under its own run handling as the action
 * named `step`, with `recordedConfirmPopups` as the tool's record and a caller who never answers,
 * then reads `confirmPopupOutcome` and counts the questions the caller got.
 * `confirmPopupContractFailures` judges every case at once.
 */
export const confirmPopupsOrigin = "https://confirm-popups.test";

export type ConfirmPopupCaseName = "recorded" | "unrecorded" | "other_step" | "iframe" | "popup";

export interface ConfirmPopupCase {
  readonly name: ConfirmPopupCaseName;
  /** The step the run reports the click under, as a script names it to `decideDialog`. */
  readonly step: string;
  /** The button in the page that raises the case's confirm. */
  readonly selector: string;
  /** Where the confirm shows: in the page, in a same-origin iframe, or in a popup window. */
  readonly shownIn: "page" | "iframe" | "popup";
  readonly message: string;
}

const placeOrder = "Place this order?";

export const confirmPopupCases: readonly ConfirmPopupCase[] = [
  { name: "recorded", step: "place-order", selector: "#recorded", shownIn: "page", message: placeOrder },
  {
    name: "unrecorded",
    step: "remove-item",
    selector: "#unrecorded",
    shownIn: "page",
    message: "Remove this item?",
  },
  {
    name: "other_step",
    step: "place-order-again",
    selector: "#other_step",
    shownIn: "page",
    message: placeOrder,
  },
  {
    name: "iframe",
    step: "frame-confirm",
    selector: "#iframe",
    shownIn: "iframe",
    message: "Confirm inside the frame?",
  },
  {
    name: "popup",
    step: "popup-confirm",
    selector: "#popup",
    shownIn: "popup",
    message: "Confirm in the new window?",
  },
];

/** The tool's record: the one confirm its build accepted, at its step, on the fixture's origin. */
export const recordedConfirmPopups: readonly ExpectedConfirm[] = [
  expectedConfirmDigest({ message: placeOrder, origin: confirmPopupsOrigin, step: "place-order" }),
];

const messageOf = (name: ConfirmPopupCaseName) =>
  JSON.stringify(confirmPopupCases.find((entry) => entry.name === name)?.message ?? "");

/** Writes a confirm's answer into the fixture page's outcome for the case. */
const settle = (target: string, name: ConfirmPopupCaseName) =>
  `${target}.querySelector("#outcome-${name}").textContent = confirm(${messageOf(name)}) ? "accepted" : "dismissed";`;

const pages: Readonly<Record<string, string>> = {
  "/": `<!doctype html><title>Confirm popups</title>
<button id="recorded">Place order</button><output id="outcome-recorded">pending</output>
<button id="unrecorded">Remove item</button><output id="outcome-unrecorded">pending</output>
<button id="other_step">Place order again</button><output id="outcome-other_step">pending</output>
<button id="iframe">Confirm in frame</button><output id="outcome-iframe">pending</output>
<button id="popup">Open window</button><output id="outcome-popup">pending</output>
<iframe src="/frame" title="Frame"></iframe>
<script>
for (const name of ["recorded", "unrecorded", "other_step"])
  document.querySelector("#" + name).onclick = () => window["raise_" + name]();
window.raise_recorded = () => { ${settle("document", "recorded")} };
window.raise_unrecorded = () => { ${settle("document", "unrecorded")} };
window.raise_other_step = () => { ${settle("document", "other_step")} };
document.querySelector("#iframe").onclick = () => document.querySelector("iframe").contentWindow.raise();
document.querySelector("#popup").onclick = () => { window.open("/popup", "confirm_popup"); };
</script>`,
  "/frame": `<!doctype html><title>Frame</title><p>Framed</p>
<script>window.raise = () => { ${settle("parent.document", "iframe")} };</script>`,
  "/popup": `<!doctype html><title>Window</title><p>New window</p>
<script>setTimeout(() => { ${settle("opener.document", "popup")} }, 50);</script>`,
};

/** Serves the fixture's pages at `confirmPopupsOrigin` in `context`, with no server or certificate. */
export const serveConfirmPopups = (context: BrowserContext) =>
  context.route(`${confirmPopupsOrigin}/**`, (route) => {
    const body = pages[new URL(route.request().url()).pathname];
    return body === undefined
      ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ status: 200, contentType: "text/html", body });
  });

export type ConfirmPopupOutcome = "accepted" | "dismissed" | "pending";

/**
 * What the case's confirm returned on the fixture page, once it answered or `waitMs` passed: a
 * popup window writes its answer back after it opens.
 */
export const confirmPopupOutcome = async (
  page: Page,
  name: ConfirmPopupCaseName,
  waitMs = 3_000,
): Promise<ConfirmPopupOutcome> => {
  const outcome = page.locator(`#outcome-${name}`);
  await outcome
    .filter({ hasNotText: "pending" })
    .waitFor({ timeout: waitMs })
    .catch(() => undefined);
  const text = (await outcome.textContent())?.trim();
  return text === "accepted" || text === "dismissed" ? text : "pending";
};

export interface ConfirmPopupObservation {
  readonly outcome: ConfirmPopupOutcome;
  /** How many questions the host put to the caller about the case's popup. */
  readonly asked: number;
}

/**
 * Where a host's observations break the contract, as one line per broken case; empty when the
 * host keeps it. The recorded confirm is accepted without asking. An unrecorded confirm in the
 * page asks the caller and, unanswered, is dismissed. The iframe's and the popup window's are
 * dismissed, asked or not.
 */
export const confirmPopupContractFailures = (
  observed: Readonly<Record<ConfirmPopupCaseName, ConfirmPopupObservation>>,
): readonly string[] =>
  confirmPopupCases.flatMap(({ name, shownIn }) => {
    const { outcome, asked } = observed[name];
    if (name === "recorded")
      return outcome === "accepted" && asked === 0
        ? []
        : [`${name}: the recorded confirm must be accepted without asking (${outcome}, asked ${asked})`];
    if (outcome !== "dismissed")
      return [`${name}: an unrecorded confirm must end dismissed, never ${outcome}`];
    return shownIn === "page" && asked === 0
      ? [`${name}: an unrecorded confirm in the page must ask the caller first`]
      : [];
  });
