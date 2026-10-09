import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { initialStoreState, storeProducts, storeRoutes, type StoreState } from "./shop-store.js";

export type { CartLine, PlacedOrder, ShippingAddress, StoreProduct } from "./shop-store.js";
export { storeProducts } from "./shop-store.js";

// The JSON search API serves the home goods, as it did before the storefront had apparel.
const products = storeProducts
  .filter((item) => item.department === "home")
  .map(({ id, name, priceMinor }) => ({ id, name, priceMinor }));
export const shopAccount = { username: "ada@example.test", password: "correct-horse-battery-9" };
/** The code the shop asks for after the one-screen sign-in, when `loginCode` is set. */
export const shopCode = "482913";
/** How many help links the two-screen sign-in's password screen shows besides its 4 controls. */
export const shopHelpLinks = 40;
/**
 * A host on another site, whose identity service the shop's script sign-in, `/identity-login`,
 * sends the login to. A browser maps it to the shop's server, which answers it on the same port.
 */
export const identityHost = "accounts.identity.test";
/** An account the shop has locked: it answers 423 whatever the password. */
export const lockedShopAccount = {
  username: "grace@example.test",
  password: "locked-horse-battery-7",
};

/** Counters and switches for one controlled shop, with its storefront's carts and orders. */
interface ShopState extends StoreState {
  searchPageLoads: number;
  /** Loads of the code screen, by GET, that `loginCode` puts after the one-screen sign-in. */
  codePageLoads: number;
  /** Codes posted to the code screen. */
  codePosts: number;
  apiRequests: number;
  curlApiRequests: number;
  cartPosts: number;
  loginPosts: number;
  /** Loads of the one-screen sign-in's page, `/login`, by GET. */
  loginPageLoads: number;
  /** Posts to the two-screen sign-in's session endpoint, whatever they carry. */
  sessionPosts: number;
  /** Posts of a login to the identity service on `identityHost`, its preflights left out. */
  identityPosts: number;
  /** The notes the signed-in account saved on `/account/note`, in order. */
  accountNotes: string[];
  /** The HTTP version's contract: `error` and `changed` break it for curl traffic only. */
  api: "ok" | "error" | "changed";
  /** `refuse` makes the modeled Kernel curl fail before sending anything. */
  curl: "ok" | "refuse";
  /** `after_input` keeps the sign-in button disabled until both fields hold input. */
  loginSubmit: "enabled" | "after_input";
  /**
   * The root page: `broken` drops its connection, so it never loads, and `hang` shows an image
   * whose request never answers, so its load never ends. `late` is an empty shell whose script
   * renders a header with an "Account" link, signed out too, `homeRenderMs` after it runs, and
   * `splash` is the same shell showing "Loading…" until then. `ticking` is the splash with a
   * counter beside it that changes every 200 ms and never stops, so the root never goes 1.5
   * seconds without a change.
   */
  home: "ok" | "broken" | "hang" | "late" | "splash" | "ticking";
  homeRenderMs: number;
  /**
   * Whether the one-screen sign-in asks for `shopCode` on a code screen, `/two-factor`, before it
   * signs the browser in. The screen's form posts the code back to it.
   */
  loginCode: boolean;
  /**
   * What the one-screen sign-in shows a signed-in session: `form` its form, as any session sees
   * it, `account` a redirect to the account page, as many sites answer a signed-in visit.
   */
  signedInLogin: "form" | "account";
  /**
   * A path whose next load by a signed-in browser signs it out, as a site that keeps its session
   * in the page does on a full load: that load expires the session cookie and shows the signed-out
   * page. Cleared once used. Only for a page that sets no cookie of its own, such as `/orders`.
   */
  signOutOn: string | undefined;
}

export interface Shop {
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly state: ShopState;
  readonly sessionValue: string;
  readonly csrfValue: string;
  readonly close: () => Promise<void>;
}

const html = (response: ServerResponse, body: string, headers: Record<string, string[]> = {}) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
  response.end(body);
};
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
const cookieOf = (request: IncomingMessage, name: string) =>
  new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(request.headers.cookie ?? "")?.[1];

type Route = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

/** The values one shop issues: its session, CSRF token and signed-in session. */
interface ShopSecrets {
  readonly sessionValue: string;
  readonly csrfValue: string;
  readonly signedIn: string;
  /** A sign-in that sent the password and waits for its code. */
  readonly pending: string;
  /** The token the identity service issues for the shop's account. */
  readonly identityToken: string;
}

/** A sign-in body's username and password, when it is an object that carries them. */
const credentialsOf = (text: string) => {
  const body: unknown = JSON.parse(text || "null");
  if (typeof body !== "object" || body === null) return {};
  return {
    username: "username" in body ? body.username : undefined,
    password: "password" in body ? body.password : undefined,
  };
};

const postOnly =
  (route: Route): Route =>
  (request, response) =>
    request.method === "POST" ? route(request, response) : json(response, 404, {});

/** The shop's routes by path; any other path answers 404. */
const shopRoutes = (
  state: ShopState,
  secrets: ShopSecrets,
  hanging: ServerResponse[],
): ReadonlyMap<string, Route> => {
  const { sessionValue, csrfValue, signedIn, pending, identityToken } = secrets;
  const sessionCookies = [
    `shop_session=${sessionValue}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    `csrf_token=${csrfValue}; Path=/; Secure; SameSite=Lax`,
  ];
  // A page load keeps a signed-in session; a signed-out browser gets a fresh one.
  const cookiesFor = (request: IncomingMessage) =>
    cookieOf(request, "shop_session") === signedIn ? sessionCookies.slice(1) : sessionCookies;
  const lateHome = (shell: string, ticking: boolean) => `<title>Shop</title><div id="app">${shell}</div>${ticking ? `<p id="tick">0</p>` : ""}
<script>setTimeout(()=>{document.querySelector('#app').innerHTML='<nav><a id="account" href="/login">Account</a></nav>'},${state.homeRenderMs})${ticking ? `;let ticks=0;setInterval(()=>{document.querySelector('#tick').textContent=String(++ticks)},200)` : ""}</script>`;
  // The plain home shows the account link, the shop's signed-in marker, to a signed-in session.
  const home: Route = (request, response) => {
    if (state.home === "broken") return void response.destroy();
    if (state.home === "late" || state.home === "splash" || state.home === "ticking")
      return html(
        response,
        lateHome(state.home === "late" ? "" : "<p>Loading…</p>", state.home === "ticking"),
        { "set-cookie": cookiesFor(request) },
      );
    return html(
      response,
      `<title>Shop</title><meta name="csrf-token" content="${csrfValue}"><a href='/login'>Sign in</a>${cookieOf(request, "shop_session") === signedIn ? `<a id="account" href="/account">Account</a>` : ""}
<button id="add">Add to cart</button><p id="added"></p>
<script>document.querySelector('#add').addEventListener('click',async()=>{const token=document.querySelector('meta[name=csrf-token]').content;const response=await fetch('/api/cart',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':token},body:JSON.stringify({productId:'p-1'})});const data=await response.json();document.querySelector('#added').textContent=data.cartId??'refused'})</script>${state.home === "hang" ? `<img src="/hang" alt="">` : ""}`,
      { "set-cookie": cookiesFor(request) },
    );
  };
  // A request that never answers, until the shop closes.
  const hang: Route = (_request, response) => {
    hanging.push(response);
  };
  const search: Route = (request, response) => {
    state.searchPageLoads += 1;
    html(
      response,
      `<title>Search</title><ul id="results"></ul><script>
fetch('/api/products?q='+encodeURIComponent(new URLSearchParams(location.search).get('q')),{headers:{accept:'application/json'}})
.then(r=>r.json()).then(data=>{for(const item of data.items){const li=document.createElement('li');li.dataset.id=item.id;li.dataset.name=item.name;li.dataset.price=String(item.priceMinor);li.textContent=item.name;document.querySelector('#results').append(li)}});
</script>`,
      { "set-cookie": cookiesFor(request) },
    );
  };
  const productsApi: Route = (request, response) => {
    const curl = request.headers["x-modeled-transport"] === "kernel-curl";
    const session = cookieOf(request, "shop_session");
    state.apiRequests += 1;
    if (curl) state.curlApiRequests += 1;
    if (session !== sessionValue && session !== signedIn)
      return json(response, 401, { error: "signed out" });
    if (curl && state.api === "error") return json(response, 500, {});
    if (curl && state.api === "changed")
      return json(response, 200, {
        items: products.map((item) => ({ ...item, priceMinor: String(item.priceMinor) })),
      });
    return json(response, 200, { items: products });
  };
  const cart: Route = async (request, response) => {
    state.cartPosts += 1;
    await readBody(request);
    const token = request.headers["x-csrf-token"];
    if (token !== cookieOf(request, "csrf_token") || token === undefined)
      return json(response, 403, { error: "csrf" });
    return json(response, 200, { cartId: "c-9" });
  };
  const loginPage: Route = (request, response) => {
    state.loginPageLoads += 1;
    if (state.signedInLogin === "account" && cookieOf(request, "shop_session") === signedIn) {
      response.writeHead(303, { location: "/account" });
      return void response.end();
    }
    return html(
      response,
      `<title>Sign in</title><form id="login"><input name="username"><input name="password" type="password"><button${state.loginSubmit === "after_input" ? " disabled" : ""}>Sign in</button></form>
<script>const csrf=document.cookie.match(/csrf_token=([^;]*)/)?.[1]??'';</script>${
        state.loginSubmit === "after_input"
          ? `
<script>const form=document.querySelector('#login');form.addEventListener('input',()=>{form.querySelector('button').disabled=!(form.username.value&&form.password.value)})</script>`
          : ""
      }
<script>document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const response=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({username:form.get('username'),password:form.get('password')})});if(response.ok)location.href=(await response.json()).next??'/account'})</script>`,
      { "set-cookie": cookiesFor(request) },
    );
  };
  const login: Route = async (request, response) => {
    state.loginPosts += 1;
    const text = await readBody(request);
    const token = request.headers["x-csrf-token"];
    if (token === undefined || token !== cookieOf(request, "csrf_token"))
      return json(response, 403, { error: "csrf" });
    const submitted = credentialsOf(text);
    if (submitted.username === lockedShopAccount.username)
      return json(response, 423, { error: "account locked" });
    const matches =
      submitted.username === shopAccount.username && submitted.password === shopAccount.password;
    if (!matches) return json(response, 401, { error: "invalid credentials" });
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": [
        state.loginCode
          ? `shop_pending=${pending}; Path=/; Secure; HttpOnly; SameSite=Lax`
          : `shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      ],
    });
    response.end(
      JSON.stringify(state.loginCode ? { ok: true, next: "/two-factor" } : { ok: true }),
    );
  };
  // The code screen: a GET shows its form, and the form's post with the code signs in. A wrong
  // code shows the form again under the error.
  const codeForm = `<form method="post" action="/two-factor"><label>Code<input name="code" autocomplete="one-time-code"></label><button>Verify</button></form>`;
  const twoFactor: Route = async (request, response) => {
    if (request.method !== "POST") {
      state.codePageLoads += 1;
      return html(response, `<title>Code</title>${codeForm}`);
    }
    state.codePosts += 1;
    const code = new URLSearchParams(await readBody(request)).get("code");
    if (code !== shopCode || cookieOf(request, "shop_pending") !== pending)
      return html(response, `<title>Code</title><p id='wrong-code'>Wrong code</p>${codeForm}`);
    response.writeHead(303, {
      location: "/account",
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end();
  };
  const account: Route = (request, response) =>
    html(
      response,
      cookieOf(request, "shop_session") === signedIn
        ? `<title>Account</title><p id="account">${shopAccount.username}</p>`
        : "<title>Account</title><p id='signed-out'>Please sign in</p>",
    );
  // The account's orders, behind the same session as its account page.
  const orders: Route = (request, response) =>
    html(
      response,
      cookieOf(request, "shop_session") === signedIn
        ? `<title>Orders</title><p id="account">${shopAccount.username}</p><p id="orders">2 orders</p>`
        : "<title>Orders</title><p id='signed-out'>Please sign in</p>",
    );
  // The sign-in's query goes on to the password screen: `hidden=N` puts N hidden text fields
  // ahead of its own field, `pad=N` puts N spaces ahead of the identifier its label echoes in
  // place of "Password for", `tag` marks its help links, so a test finds its own screen,
  // `echo=none` shows the identifier only in the hidden field, and `stash=password` puts the
  // account's password in its form's action, as page code that kept a typed value could.
  const queryOf = (request: IncomingMessage) =>
    new URL(request.url ?? "/", "https://www.shop.test").searchParams;
  const identifierScreen: Route = (request, response) =>
    html(
      response,
      `<title>Sign in</title><form method="post" action="/sign-in/password?${queryOf(request).toString()}"><label>Email<input id="username" name="username" type="email" autocomplete="username"></label><button id="next">Next</button></form>`,
    );
  // The next screen echoes the typed identifier in its text, a label, a placeholder and a hidden
  // field. Loaded directly, it is a password-only screen with no identifier.
  const passwordScreen: Route = async (request, response) => {
    const typed =
      request.method === "POST"
        ? (new URLSearchParams(await readBody(request)).get("username") ?? "")
        : "";
    const links = Array.from(
      { length: shopHelpLinks },
      (_, index) => `<a href="/help/${index}">Help topic ${index} ${queryOf(request).get("tag") ?? ""}</a>`,
    ).join("");
    const pad = Number(queryOf(request).get("pad") ?? 0);
    const echo = queryOf(request).get("echo") !== "none";
    const label = !echo ? "Password" : pad > 0 ? `${" ".repeat(pad)}${typed}` : `Password for ${typed}`;
    const hidden = Array.from(
      { length: Number(queryOf(request).get("hidden") ?? 0) },
      (_, index) => `<input name="extra${index}" style="display:none">`,
    ).join("");
    const action =
      queryOf(request).get("stash") === "password"
        ? `/sign-in/session?next=${encodeURIComponent(shopAccount.password)}`
        : "/sign-in/session";
    html(
      response,
      `<title>Password</title>${echo ? `<p>Signing in as ${typed}</p>` : ""}<form method="post" action="${action}"><input type="hidden" name="user" value="${typed}">${hidden}<label>${label}<input id="password" name="password" type="password" required placeholder="${echo ? typed : ""}"></label><input id="otp" style="display:none" aria-label="Code"><button id="sign-in">Sign in</button><button id="trouble" disabled>Trouble signing in</button></form><nav>${links}</nav>`,
    );
  };
  // The password screen's form posts here: the shop's account signs in, any other is refused.
  const passwordSession: Route = async (request, response) => {
    state.sessionPosts += 1;
    const form = new URLSearchParams(await readBody(request));
    if (form.get("user") !== shopAccount.username || form.get("password") !== shopAccount.password)
      return html(response, "<title>Password</title><p id='wrong-password'>Wrong password</p>");
    response.writeHead(303, {
      location: "/account",
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end();
  };
  // A sign-in whose script sends the login to an identity service on another site, then trades the
  // token it returns for the shop's session, as a single-page site on a hosted identity service
  // does. The form has no action and the shop's own origin never receives the password.
  const identityLogin: Route = (request, response) =>
    html(
      response,
      `<title>Sign in</title><form id="login"><label>Email<input name="username" type="email" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>
<script>const identity='https://${identityHost}:'+location.port;document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const signedIn=await fetch(identity+'/v1/sign-in?key=public',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:form.get('username'),password:form.get('password')})});if(!signedIn.ok)return;const {idToken}=await signedIn.json();const session=await fetch('/api/identity-session',{method:'POST',headers:{authorization:'Bearer '+idToken}});if(session.ok)location.href='/account'})</script>`,
      { "set-cookie": cookiesFor(request) },
    );
  // The identity service answers its own preflight, and a token for the shop's account.
  const identitySignIn: Route = async (request, response) => {
    const cors = {
      "access-control-allow-origin": request.headers.origin ?? "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      return void response.end();
    }
    if (request.method !== "POST") return json(response, 404, {});
    state.identityPosts += 1;
    const body: unknown = JSON.parse((await readBody(request)) || "null");
    const matches =
      typeof body === "object" &&
      body !== null &&
      "email" in body &&
      "password" in body &&
      body.email === shopAccount.username &&
      body.password === shopAccount.password;
    response.writeHead(matches ? 200 : 400, { "content-type": "application/json", ...cors });
    response.end(JSON.stringify(matches ? { idToken: identityToken } : { error: "invalid login" }));
  };
  // Trades the identity service's token for the shop's session. It never sees the password.
  const identitySession: Route = (request, response) => {
    if (request.headers.authorization !== `Bearer ${identityToken}`)
      return json(response, 401, { error: "invalid token" });
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end(JSON.stringify({ ok: true }));
  };
  // The account's note: a signed-out visit goes to the identity sign-in, a signed-in post saves it.
  const accountNote: Route = async (request, response) => {
    if (cookieOf(request, "shop_session") !== signedIn) {
      response.writeHead(303, { location: "/identity-login" });
      return void response.end();
    }
    if (request.method === "POST") {
      state.accountNotes.push(new URLSearchParams(await readBody(request)).get("note") ?? "");
      return html(response, `<title>Note</title><p id="saved">Saved</p>`);
    }
    return html(
      response,
      `<title>Note</title><p id="account">${shopAccount.username}</p><form method="post" action="/account/note"><label>Note<input id="note" name="note"></label><button id="save">Save</button></form>`,
    );
  };
  return new Map([
    ...storeRoutes({
      state,
      signedIn: (request) => cookieOf(request, "shop_session") === signedIn,
      cookiesFor,
      csrfOf: (request) => cookieOf(request, "csrf_token"),
    }),
    ["/", home],
    ["/sign-in", identifierScreen],
    ["/sign-in/password", passwordScreen],
    ["/sign-in/session", postOnly(passwordSession)],
    ["/search", search],
    ["/api/products", productsApi],
    ["/api/cart", postOnly(cart)],
    ["/login", loginPage],
    ["/api/login", postOnly(login)],
    ["/account", account],
    ["/orders", orders],
    ["/two-factor", twoFactor],
    ["/hang", hang],
    ["/identity-login", identityLogin],
    ["/v1/sign-in", identitySignIn],
    ["/api/identity-session", postOnly(identitySession)],
    ["/account/note", accountNote],
  ]);
};

/**
 * A controlled HTTPS shop: an HTML search page whose script calls a cookie-gated JSON API, a
 * CSRF-protected cart POST, a JSON sign-in endpoint, and a storefront (`shop-store.ts`) with
 * filtered catalog search, product options, guest and account carts, and checkout. The modeled curl marks its requests with
 * `x-modeled-transport`, which a real site cannot see, so the fixture can count them.
 */
export const startShop = async (directory: string): Promise<Shop> => {
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-subj",
    "/CN=www.shop.test",
    "-days",
    "1",
  ]);
  const state: ShopState = {
    searchPageLoads: 0,
    codePageLoads: 0,
    codePosts: 0,
    apiRequests: 0,
    curlApiRequests: 0,
    cartPosts: 0,
    loginPosts: 0,
    loginPageLoads: 0,
    sessionPosts: 0,
    identityPosts: 0,
    accountNotes: [],
    api: "ok",
    curl: "ok",
    loginSubmit: "enabled",
    home: "ok",
    homeRenderMs: 300,
    loginCode: false,
    signedInLogin: "form",
    signOutOn: undefined,
    ...initialStoreState(),
  };
  const sessionValue = `sess-${randomBytes(12).toString("hex")}`;
  const csrfValue = `csrf-${randomBytes(12).toString("hex")}`;
  const signedIn = `acct-${randomBytes(12).toString("hex")}`;
  const pending = `pend-${randomBytes(12).toString("hex")}`;
  const identityToken = `idt-${randomBytes(12).toString("hex")}`;
  const hanging: ServerResponse[] = [];
  const routes = shopRoutes(
    state,
    { sessionValue, csrfValue, signedIn, pending, identityToken },
    hanging,
  );
  const notFound: Route = (_request, response) => json(response, 404, {});
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "https://www.shop.test");
        if (state.signOutOn === url.pathname && cookieOf(request, "shop_session") === signedIn) {
          state.signOutOn = undefined;
          response.setHeader("set-cookie", "shop_session=; Path=/; Max-Age=0; Secure; HttpOnly");
          request.headers.cookie = (request.headers.cookie ?? "").replace(
            /(?:^|;\s*)shop_session=[^;]*/u,
            "",
          );
        }
        await (routes.get(url.pathname) ?? notFound)(request, response);
      })().catch(() => {
        response.destroy();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing shop port");
  return {
    origin: `https://www.shop.test:${address.port}`,
    hostname: "www.shop.test",
    port: address.port,
    state,
    sessionValue,
    csrfValue,
    close: () => {
      for (const response of hanging) response.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
