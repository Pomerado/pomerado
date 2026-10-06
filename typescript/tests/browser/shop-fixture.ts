import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const products = [
  { id: "p-1", name: "Brass lamp", priceMinor: 4200 },
  { id: "p-2", name: "Oak shelf", priceMinor: 9900 },
];
export const shopAccount = { username: "ada@example.test", password: "correct-horse-battery-9" };
/** How many help links the two-screen sign-in's password screen shows besides its 4 controls. */
export const shopHelpLinks = 40;
/** An account the shop has locked: it answers 423 whatever the password. */
export const lockedShopAccount = {
  username: "grace@example.test",
  password: "locked-horse-battery-7",
};

/** Counters and switches for one controlled shop. */
interface ShopState {
  searchPageLoads: number;
  apiRequests: number;
  curlApiRequests: number;
  cartPosts: number;
  loginPosts: number;
  /** The HTTP version's contract: `error` and `changed` break it for curl traffic only. */
  api: "ok" | "error" | "changed";
  /** `refuse` makes the modeled Kernel curl fail before sending anything. */
  curl: "ok" | "refuse";
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
const shopRoutes = (state: ShopState, secrets: ShopSecrets): ReadonlyMap<string, Route> => {
  const { sessionValue, csrfValue, signedIn } = secrets;
  const sessionCookies = [
    `shop_session=${sessionValue}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    `csrf_token=${csrfValue}; Path=/; Secure; SameSite=Lax`,
  ];
  const home: Route = (_request, response) =>
    html(
      response,
      `<title>Shop</title><meta name="csrf-token" content="${csrfValue}"><a href='/login'>Sign in</a>
<button id="add">Add to cart</button><p id="added"></p>
<script>document.querySelector('#add').addEventListener('click',async()=>{const token=document.querySelector('meta[name=csrf-token]').content;const response=await fetch('/api/cart',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':token},body:JSON.stringify({productId:'p-1'})});const data=await response.json();document.querySelector('#added').textContent=data.cartId??'refused'})</script>`,
      { "set-cookie": sessionCookies },
    );
  const search: Route = (_request, response) => {
    state.searchPageLoads += 1;
    html(
      response,
      `<title>Search</title><ul id="results"></ul><script>
fetch('/api/products?q='+encodeURIComponent(new URLSearchParams(location.search).get('q')),{headers:{accept:'application/json'}})
.then(r=>r.json()).then(data=>{for(const item of data.items){const li=document.createElement('li');li.dataset.id=item.id;li.dataset.name=item.name;li.dataset.price=String(item.priceMinor);li.textContent=item.name;document.querySelector('#results').append(li)}});
</script>`,
      { "set-cookie": sessionCookies },
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
  const loginPage: Route = (_request, response) =>
    html(
      response,
      `<title>Sign in</title><form id="login"><input name="username"><input name="password" type="password"><button>Sign in</button></form>
<script>const csrf=document.cookie.match(/csrf_token=([^;]*)/)?.[1]??'';</script>
<script>document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.target);const response=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({username:form.get('username'),password:form.get('password')})});if(response.ok)location.href='/account'})</script>`,
      { "set-cookie": sessionCookies },
    );
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
      "set-cookie": [`shop_session=${signedIn}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    });
    response.end(JSON.stringify({ ok: true }));
  };
  const account: Route = (request, response) =>
    html(
      response,
      cookieOf(request, "shop_session") === signedIn
        ? `<title>Account</title><p id="account">${shopAccount.username}</p>`
        : "<title>Account</title><p id='signed-out'>Please sign in</p>",
    );
  // The sign-in's query goes on to the password screen: `hidden=N` puts N hidden text fields
  // ahead of its own field, and `tag` marks its help links, so a test finds its own screen.
  const queryOf = (request: IncomingMessage) =>
    new URL(request.url ?? "/", "https://www.shop.test").searchParams;
  const identifierScreen: Route = (request, response) =>
    html(
      response,
      `<title>Sign in</title><form method="post" action="/sign-in/password?${queryOf(request).toString()}"><label>Email<input id="username" name="username" type="email" autocomplete="username"></label><button id="next">Next</button></form>`,
    );
  // The next screen echoes the typed identifier in its text, a label, a placeholder and a hidden field.
  const passwordScreen: Route = async (request, response) => {
    const typed = new URLSearchParams(await readBody(request)).get("username") ?? "";
    const links = Array.from(
      { length: shopHelpLinks },
      (_, index) => `<a href="/help/${index}">Help topic ${index} ${queryOf(request).get("tag") ?? ""}</a>`,
    ).join("");
    const hidden = Array.from(
      { length: Number(queryOf(request).get("hidden") ?? 0) },
      (_, index) => `<input name="extra${index}" style="display:none">`,
    ).join("");
    html(
      response,
      `<title>Password</title><p>Signing in as ${typed}</p><form method="post" action="/sign-in/session"><input type="hidden" name="user" value="${typed}">${hidden}<label>Password for ${typed}<input id="password" name="password" type="password" required placeholder="${typed}"></label><input id="otp" style="display:none" aria-label="Code"><button id="sign-in">Sign in</button><button id="trouble" disabled>Trouble signing in</button></form><nav>${links}</nav>`,
    );
  };
  return new Map([
    ["/", home],
    ["/sign-in", identifierScreen],
    ["/sign-in/password", postOnly(passwordScreen)],
    ["/search", search],
    ["/api/products", productsApi],
    ["/api/cart", postOnly(cart)],
    ["/login", loginPage],
    ["/api/login", postOnly(login)],
    ["/account", account],
  ]);
};

/**
 * A controlled HTTPS shop: an HTML search page whose script calls a cookie-gated JSON API, a
 * CSRF-protected cart POST and a JSON sign-in endpoint. The modeled curl marks its requests with
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
    apiRequests: 0,
    curlApiRequests: 0,
    cartPosts: 0,
    loginPosts: 0,
    api: "ok",
    curl: "ok",
  };
  const sessionValue = `sess-${randomBytes(12).toString("hex")}`;
  const csrfValue = `csrf-${randomBytes(12).toString("hex")}`;
  const signedIn = `acct-${randomBytes(12).toString("hex")}`;
  const routes = shopRoutes(state, { sessionValue, csrfValue, signedIn });
  const notFound: Route = (_request, response) => json(response, 404, {});
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "https://www.shop.test");
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
