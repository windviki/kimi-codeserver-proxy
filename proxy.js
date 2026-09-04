#!/usr/bin/env node
/**
 * kimi-codeserver-proxy — base-path adapter for the official Kimi Code web UI
 * (`kimi web`), deployed on a self-hosted code-server.
 *
 * `kimi web` serves its frontend with root-absolute paths (/boot.js, /assets/...,
 * /favicon.ico), derives its REST/WS base from `window.location.origin`, and
 * gates every request with a DNS-rebinding Host check. When it is exposed
 * through code-server's port forwarding (https://host/proxy/<port>/), the
 * browser resolves those absolute references against the host root and the
 * API base against the host origin, so the SPA never loads. This proxy sits
 * between code-server and kimi web, forwards everything to kimi, rewrites the
 * served HTML/JS/CSS so every root-absolute reference is prefixed with the
 * proxy base path, and rewrites each request's Host to the loopback upstream so
 * the DNS-rebinding fence is satisfied exactly as for a local browser.
 *
 *   browser -> code-server /proxy/<port>/ -> this proxy -> kimi web (loopback)
 *
 * On top of the path adaptation it also removes the token prompt for
 * code-server deployments with unified auth: the spawned `kimi web` runs with
 * `--dangerous-bypass-auth` (kimi natively skips its bearer gate then), and an
 * injected client script additionally seeds the UI with the persisted token
 * for the case where kimi runs without the flag. The same script patches
 * history pushState/replaceState so SPA navigations never escape the base
 * subtree.
 */

import http from "node:http";
import path from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// .env loading
// ---------------------------------------------------------------------------
// Minimal, dependency-free .env loader (no shell interpolation). Private values
// live in a gitignored .env; every variable below has a documented default for
// the common code-server + kimi-on-loopback layout. Real environment variables
// always win over .env entries.
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value === "") continue;
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv(".env");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function envPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  console.warn(`[kimi-codeserver-proxy] invalid ${name}=${raw}; falling back to ${fallback}`);
  return fallback;
}

const BASE = (process.env.PROXY_BASE || "/proxy/3101").replace(/\/+$/, "") || "/";
const UPSTREAM_HOST = process.env.PROXY_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = envPort("PROXY_UPSTREAM_PORT", 58627);
const PORT = envPort("PROXY_PORT", 3101);
const SPAWN_KIMI = process.env.PROXY_SPAWN_KIMI !== "0";
// Behind code-server's unified auth the kimi-side bearer check is redundant, so
// the proxy spawns `kimi web --dangerous-bypass-auth` by default and the UI
// never asks for a token (kimi advertises the bypass via /api/v1/meta). Set to
// `0` to keep kimi's own bearer auth — the injected client script then seeds the
// UI with the known token instead (see KIMI_TOKEN_DIR / PROXY_KIMI_TOKEN).
const KIMI_BYPASS_AUTH = process.env.PROXY_KIMI_BYPASS_AUTH !== "0";
// Explicit token override; otherwise read from kimi's persisted token file.
const KIMI_TOKEN = (process.env.PROXY_KIMI_TOKEN || "").trim();
const KIMI_TOKEN_DIR = process.env.KIMI_HOME || path.join(homedir(), ".kimi-code");
// Optional: set to the code-server hostname (e.g. code.your-host.com) so the
// proxy can print the full clickable access URL.
const EXTERNAL_HOST = (process.env.PROXY_EXTERNAL_HOST || "").trim();
const LOOPBACK_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

// The auth token kimi web prints at startup (also persisted to
// ~/.kimi-code/server.token). Captured only when this proxy spawns kimi; the
// persisted file is the primary source, this is the fallback.
let kimiToken = null;

// ---------------------------------------------------------------------------
// Header handling
// ---------------------------------------------------------------------------
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// code-server's path proxy stamps forwarding traces (x-forwarded-*) on its
// /proxy/<port>/ requests. From the upstream kimi's point of view this proxy
// IS the final local peer, so those traces are stripped — the request then
// looks like a direct loopback browser connection.
const NO_FORWARD_TRACE = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
]);

// ---------------------------------------------------------------------------
// Response rewriting (pure, exported for tests)
// ---------------------------------------------------------------------------
// index.html references these root-absolute paths (all double-quoted):
// <script src="/boot.js">, <script src="/assets/index-*.js">,
// <link href="/assets/index-*.css">, <link rel="icon" href="/favicon.ico">.
const HTML_TARGETS = ["/assets/", "/boot.js", "/favicon.ico"];

// Insert `base` after an opening quote for every occurrence of the target
// root-absolute path, so `"/assets/...` becomes `"/proxy/3101/assets/...` and
// the rewritten string stays well-formed HTML/CSS/JS.
export function prefixQuoted(s, base, quote, targets) {
  let out = s;
  for (const p of targets) out = out.split(quote + p).join(quote + base + p);
  return out;
}

// kimi's frontend computes its REST/WS base as:
//   function Wke(){return typeof window<"u"&&window.location?.origin?window.location.origin:"http://127.0.0.1:58627"}
// Under code-server, window.location.origin is the host root, so API calls and
// the WebSocket would go to https://host/api/v1/... instead of the forwarded
// subtree. Patch the expression to append the base path. The port literal in
// the fallback is kimi's default baked at build time and is never used in a
// browser (window.location.origin is always truthy), so it is preserved.
// The regex matches any default port so the patch survives a kimi default-port
// change; if it fails to match we warn loudly instead of silently shipping a
// broken UI.
const WKE_QUOTED = 'window.location?.origin?window.location.origin:"http://127.0.0.1:58627"';
const WKE_PATCH_RE = /(window\.location\?\.origin\?window\.location\.origin)(:"http:\/\/127\.0\.0\.1:\d+")/;

export function patchApiBase(s, base) {
  if (base === "/") return s;
  if (s.includes(WKE_QUOTED)) {
    return s.split(WKE_QUOTED).join(`window.location?.origin?window.location.origin+"${base}":"http://127.0.0.1:58627"`);
  }
  if (WKE_PATCH_RE.test(s)) {
    return s.replace(WKE_PATCH_RE, `$1+"${base}"$2`);
  }
  warnOnce(
    "wke",
    "the kimi web bundle's origin-resolution pattern was not found in a JS response, " +
      "so the API/WS base path is not rewritten there. Boot scripts and lazy chunks never match; " +
      "this only breaks the UI if the main app bundle no longer matches, in which case open it with " +
      `?kimi_origin=<code-server base URL> or upgrade this proxy for the current kimi bundle.`,
  );
  return s;
}

export function rewriteHtml(body, base) {
  let out = body;
  if (base !== "/") out = prefixQuoted(out, base, '"', HTML_TARGETS);
  // The bootstrap script fixes the token prompt and stray "/" navigations and
  // must be present for every base (including "/" — the token seeding still
  // applies). It is harmless inside a manifest JSON: no </head> to inject at.
  return injectClientScript(out, base);
}

export function rewriteJs(body, base) {
  if (base === "/") return body;
  // First patch the origin-resolution expression so the REST/WS base becomes
  // `window.location.origin + base`, then the SPA route constants so pushState
  // URLs and pathname parsing agree under the base path, then prefix the
  // root-absolute asset references that live in the bundle (KaTeX/mermaid
  // workers and rive animations). Lazy chunks are referenced relative to the
  // module URL, so they need no rewrite and are unaffected by these
  // exact-path replacements.
  let s = patchApiBase(body, base);
  s = patchRouteBase(s, base);
  s = prefixQuoted(s, base, '"', ["/assets/"]);
  s = prefixQuoted(s, base, "'", ["/assets/"]);
  return s;
}

export function rewriteCss(body, base) {
  if (base === "/") return body;
  // The main stylesheet embeds KaTeX/webfont files as root-absolute
  // url(/assets/...) — the only url() references in the served CSS.
  return body.split("url(/assets/").join(`url(${base}/assets/`);
}

export function needsRewrite(status, contentType) {
  if (status !== 200 || !contentType) return false;
  const type = contentType.toLowerCase();
  return (
    type.includes("text/html") ||
    type.includes("javascript") ||
    type.includes("text/css") ||
    type.includes("application/manifest+json")
  );
}

export function rewriteBody(body, base, contentType) {
  const type = contentType.toLowerCase();
  if (type.includes("text/html") || type.includes("application/manifest+json")) return rewriteHtml(body, base);
  if (type.includes("text/css")) return rewriteCss(body, base);
  return rewriteJs(body, base);
}

// ---------------------------------------------------------------------------
// Client bootstrap script (pure, exported for tests)
// ---------------------------------------------------------------------------
// The proxy serves one generated script and injects it into every HTML page
// (a classic <script> in <head>, so it always runs before the deferred module
// bundle). It solves the two things that cannot be fixed by byte-rewriting
// upstream assets alone:
//
// 1. Token seeding. The UI asks for the server token when localStorage holds
//    no valid `kimi-web.server-credential`. Seeding that key with the known
//    token — in exactly the app's own record shape ({version, credential,
//    expiresAt}, 7-day TTL, refreshed on every page load) — is equivalent to
//    opening the UI with `#token=…`, so no token prompt ever appears.
// 2. History URL prefixing. The router pushes root-absolute URLs (and the
//    literal "/" when closing a session); patching pushState/replaceState
//    keeps those inside the forwarded subtree even where the bundle-level
//    route patch below has no matching constant.

export const CLIENT_SCRIPT_PATH = "/__kimi-proxy/inject.js";
const CREDENTIAL_KEY = "kimi-web.server-credential";

export function clientBootScript(base, token) {
  const root = base === "/" ? "" : base;
  const cred = token && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
  return `(function(){
"use strict";
var ROOT=${JSON.stringify(root)},TOKEN=${JSON.stringify(cred)};
try{
if(TOKEN&&typeof localStorage<"u"){
localStorage.setItem(${JSON.stringify(CREDENTIAL_KEY)},JSON.stringify({version:1,credential:TOKEN,expiresAt:Date.now()+10080*60*1000}));
}
}catch{}
try{
var push=history.pushState,replace=history.replaceState;
function fix(u){
if(typeof u!=="string"||u===""||u.charAt(0)!=="/"||u.charAt(1)==="/")return u;
if(ROOT===""||u===ROOT||u.lastIndexOf(ROOT+"/",0)===0)return u;
return ROOT+u;
}
history.pushState=function(s,t,u){return push.call(history,s,t,u==null?u:fix(u))};
history.replaceState=function(s,t,u){return replace.call(history,s,t,u==null?u:fix(u))};
}catch{}
})();`;
}

export function injectClientScript(body, base) {
  if (!body.includes("</head>")) return body;
  const src = `${base === "/" ? "" : base}${CLIENT_SCRIPT_PATH}`;
  const tag = `<script src="${src}"></script>`;
  if (body.includes(tag)) return body;
  return body.replace("</head>", `${tag}</head>`);
}

// ---------------------------------------------------------------------------
// SPA route patch (pure, exported for tests)
// ---------------------------------------------------------------------------
// kimi's router builds AND parses its history URLs from module-level route
// constants (present verbatim in the 0.37.2 and 0.39.1 bundles):
//   "/sessions/"       session view
//   "/admin/sessions"  session admin list
//   "/devices/"        remote-control pairing
// Prefixing the constants keeps pushState URLs and location.pathname parsing
// consistent, so the URL stays under the base path and a reload restores the
// same view. The REST client uses "/sessions" (no trailing slash) and similar
// server paths — those are appended to the API base at runtime and must NOT
// be touched, which the trailing-slash / full-value match guarantees.
const ROUTE_CONSTANTS = ["/sessions/", "/admin/sessions", "/devices/"];

export function patchRouteBase(body, base) {
  if (base === "/") return body;
  let out = body;
  for (const route of ROUTE_CONSTANTS) {
    const target = `"${route}"`;
    if (out.includes(target)) out = out.split(target).join(`"${base}${route}"`);
  }
  return out;
}

// Warn at most once per process per missing pattern: rewriteJs runs on every
// JS response (boot.js, workers, lazy chunks) and most of them legitimately
// contain none of the patched patterns.
const warnedPatterns = new Set();
function warnOnce(key, message) {
  if (warnedPatterns.has(key)) return;
  warnedPatterns.add(key);
  console.warn(`[kimi-codeserver-proxy] WARN: ${message}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers (config-dependent, exported for tests)
// ---------------------------------------------------------------------------

export function normalizePath(rawUrl) {
  let url = rawUrl;
  if (BASE !== "/" && url.startsWith(BASE)) url = url.slice(BASE.length);
  // code-server's proxy target joins an extra slash, e.g. //api/v1/meta.
  url = url.replace(/^\/+/, "/");
  if (url === "") url = "/";
  return url;
}

export function requestHeaders(headers) {
  // kimi's DNS-rebinding check accepts a Host that resolves to the bound
  // loopback address (or that is explicitly allowed). Rewriting Host (and
  // Origin) to the loopback upstream makes every request indistinguishable
  // from a local browser direct-connect, so no KIMI_CODE_ALLOWED_HOSTS /
  // --allowed-host configuration is required on the kimi side.
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k) || NO_FORWARD_TRACE.has(k)) continue;
    out[k] = v;
  }
  out.host = LOOPBACK_AUTHORITY;
  // Rewriting only makes sense on the plain bytes; never ask upstream for a
  // compressed representation that would turn HTML/JS/CSS into gibberish.
  out["accept-encoding"] = "identity";
  if (out.origin) out.origin = `http://${LOOPBACK_AUTHORITY}`;
  return out;
}

export function responseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// Expose the resolved config so the service script / tests can read it back.
export function config() {
  return { BASE, PORT, UPSTREAM_HOST, UPSTREAM_PORT, SPAWN_KIMI, KIMI_BYPASS_AUTH, EXTERNAL_HOST };
}

// The kimi web token: explicit override, else kimi's persisted token file
// (written by kimi itself, survives restarts), else the token captured from a
// kimi this proxy spawned. Re-read per request so a `kimi rotate-token` is
// picked up on the next page load. Returns null when nothing usable is found;
// the client script then skips seeding (same UX as before this proxy existed).
function resolveKimiToken() {
  if (KIMI_TOKEN) return KIMI_TOKEN;
  try {
    const raw = readFileSync(path.join(KIMI_TOKEN_DIR, "server.token"), "utf8").trim();
    if (/^[A-Za-z0-9_-]+$/.test(raw)) return raw;
  } catch {
    // no readable token file — fall through
  }
  return kimiToken;
}

function sendUpstreamError(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, { "content-type": "text/plain" });
  res.end(`kimi-codeserver-proxy: upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT} unreachable: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------

function forward(req, res) {
  const targetPath = normalizePath(req.url);

  if (req.method === "GET" && targetPath === CLIENT_SCRIPT_PATH) {
    res.on("error", () => {});
    if (res.destroyed) return;
    const body = Buffer.from(clientBootScript(BASE, resolveKimiToken()));
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      // Must revalidate: the seeded token follows kimi's server.token and the
      // TTL is anchored to Date.now() at serve time.
      "cache-control": "no-cache",
      "content-length": String(body.length),
    });
    res.end(body);
    return;
  }

  const headers = requestHeaders(req.headers);

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: targetPath,
      method: req.method,
      headers,
    },
    (upRes) => {
      const status = upRes.statusCode;
      const contentType = upRes.headers["content-type"] || "";

      if (needsRewrite(status, contentType)) {
        // Rewritable responses are buffered (HTML/JS/CSS text, not binaries),
        // rewritten, then sent with a recomputed content-length.
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          if (res.destroyed) return;
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = Buffer.from(rewriteBody(raw, BASE, contentType));
          const outHeaders = responseHeaders(upRes.headers);
          outHeaders["content-length"] = String(body.length);
          res.writeHead(status, outHeaders);
          res.end(body);
        });
        upRes.on("error", () => res.destroy());
      } else {
        // Everything else (images, JSON, SSE, 404s, redirects, ...) is piped
        // through untouched, without buffering it in memory.
        const outHeaders = responseHeaders(upRes.headers);
        if (res.destroyed) {
          upRes.destroy();
          return;
        }
        res.writeHead(status, outHeaders);
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());
      }
    },
  );

  upstream.on("error", (err) => sendUpstreamError(res, err));
  req.on("error", () => upstream.destroy());
  // Client can drop the response mid-flight (abort, RST); swallow so the
  // process never dies on an unhandled socket error.
  res.on("error", () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer(forward);
server.on("clientError", (err, socket) => socket.destroy());

// WebSocket downlinks (/api/v1/ws) pass through the same base-prefixed paths;
// pipe the upgraded socket to upstream. The frontend authenticates the WS via
// the Sec-WebSocket-Protocol subprotocol (kimi-code.bearer.<token>), which is
// forwarded verbatim — only hop-by-hop headers are touched.
server.on("upgrade", (req, socket, head) => {
  const targetPath = normalizePath(req.url);
  const headers = requestHeaders(req.headers);
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: targetPath,
    headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
  });
  // Raw upgraded sockets emit 'error' (RST/abort) with no automatic handler;
  // without these listeners any dropped WS connection would crash the proxy.
  socket.on("error", () => socket.destroy());
  upstream.on("error", () => socket.destroy());
  upstream.on("response", (upRes) => {
    // Upstream refused the upgrade (e.g. 401/404/502). Pass a plain HTTP
    // response back instead of leaving the browser connection hanging.
    const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || "Error"}\r\n`;
    socket.write(statusLine);
    for (const [k, v] of Object.entries(responseHeaders(upRes.headers))) {
      socket.write(`${k}: ${v}\r\n`);
    }
    socket.write("\r\n");
    upRes.on("error", () => socket.destroy());
    upRes.pipe(socket);
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    upSocket.on("error", () => {
      socket.destroy();
      upSocket.destroy();
    });
    // Forward the upstream 101 headers verbatim: the browser WebSocket verifies
    // Sec-WebSocket-Accept (SHA-1 of key+GUID), so a hardcoded 101 would fail.
    socket.write("HTTP/1.1 101 Switching Protocols\r\n");
    for (const [k, v] of Object.entries(upRes.headers)) {
      socket.write(`${k}: ${v}\r\n`);
    }
    socket.write("\r\n");
    // Push each side's buffered head into the other pipe before streaming.
    if (head.length) upSocket.write(head);
    if (upHead.length) socket.write(upHead);
    socket.pipe(upSocket).pipe(socket);
  });
  upstream.end();
});

// ---------------------------------------------------------------------------
// Upstream readiness / kimi spawn
// ---------------------------------------------------------------------------

function upstreamReady() {
  return new Promise((resolve) => {
    const r = http.get({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: "/" }, (res) => {
      res.resume();
      resolve(true);
    });
    r.on("error", () => resolve(false));
    r.setTimeout(1000, () => {
      r.destroy();
      resolve(false);
    });
  });
}

function findKimiBin() {
  if (process.env.KIMI_BIN && existsSync(process.env.KIMI_BIN)) return process.env.KIMI_BIN;
  // kimi's self-update installer places the binary here when not on PATH.
  const installed = path.join(homedir(), ".kimi-code", "bin", "kimi");
  if (existsSync(installed)) return installed;
  return "kimi"; // resolve on PATH at spawn time
}

function captureToken(line) {
  const m = line.match(/#token=([A-Za-z0-9_-]+)/);
  if (m && !kimiToken) kimiToken = m[1];
}

let kimiChild = null;
let kimiSpawnCount = 0;
let kimiOutput = "";

function spawnKimi(useBypass) {
  const kimiBin = findKimiBin();
  const args = ["web", "--port", String(UPSTREAM_PORT), "--no-open"];
  if (useBypass) args.push("--dangerous-bypass-auth");
  console.log(`[kimi-codeserver-proxy] spawning '${kimiBin} ${args.join(" ")}'`);
  const child = spawn(kimiBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  kimiChild = child;
  kimiSpawnCount++;
  const sink = (d) => {
    const text = d.toString();
    if (kimiOutput.length < 65536) kimiOutput += text;
    process.stdout.write(`[kimi] ${text}`);
    for (const line of text.split("\n")) captureToken(line);
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", (d) => {
    if (kimiOutput.length < 65536) kimiOutput += d.toString();
    process.stderr.write(`[kimi] ${d}`);
  });
  child.on("exit", (code) => {
    if (kimiChild === child) kimiChild = null;
    if (code !== null && code !== 0) {
      console.error(`[kimi-codeserver-proxy] kimi web exited with code ${code}`);
      // Older kimi builds predate --dangerous-bypass-auth and die with an
      // unknown-option error; retry once without the flag so the proxy still
      // comes up (the injected client script then carries the token).
      if (
        useBypass &&
        kimiSpawnCount === 1 &&
        /dangerous-bypass-auth|unknown option|unexpected argument|unrecognized option/i.test(kimiOutput)
      ) {
        console.warn("[kimi-codeserver-proxy] kimi rejected --dangerous-bypass-auth; retrying without it");
        spawnKimi(false);
      }
    }
  });
}

async function ensureUpstream() {
  if (!SPAWN_KIMI) return;
  if (await upstreamReady()) return;
  spawnKimi(KIMI_BYPASS_AUTH);
  for (let i = 0; i < 40; i++) {
    if (await upstreamReady()) return;
    // kimiChild is nulled synchronously in the exit handler (after any retry
    // spawn), so null here means the spawn failed for good — stop waiting.
    if (kimiChild === null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("[kimi-codeserver-proxy] upstream did not become ready; continuing anyway");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`[kimi-codeserver-proxy] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  if (kimiChild && !kimiChild.killed) kimiChild.kill("SIGTERM");
  // Fallback: never hang in a half-open state.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Do not leave a spawned `kimi web` orphaned if the proxy dies another way.
process.on("exit", () => {
  if (kimiChild && !kimiChild.killed) kimiChild.kill("SIGTERM");
});

// ---------------------------------------------------------------------------
// Entry point: only when run directly (not when imported by tests)
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  await ensureUpstream();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[kimi-codeserver-proxy] listening on ${PORT}; access through ${BASE}/ on code-server`);
    console.log(`[kimi-codeserver-proxy] forwarding to ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
    if (EXTERNAL_HOST) {
      console.log(`[kimi-codeserver-proxy] access: https://${EXTERNAL_HOST}${BASE}/`);
    }
    if (!KIMI_BYPASS_AUTH) {
      console.log(
        "[kimi-codeserver-proxy] kimi-side bearer auth is on; the UI is seeded with the token from " +
          `${KIMI_TOKEN_DIR}/server.token (PROXY_KIMI_TOKEN overrides) — set PROXY_KIMI_BYPASS_AUTH=1 ` +
          "to rely on code-server's auth alone",
      );
    }
  });
}
