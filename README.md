# kimi-codeserver-proxy

**English** | [中文](README.zh-CN.md)

Base-path adapter so the official [Kimi CLI](https://moonshotai.github.io/kimi-cli/) web UI (`kimi web`) works behind a **self-hosted code-server**'s port forwarding — one click in the browser, no manual URL fixing.

```
Your browser
   │  https://code.your-host/proxy/3101/
   ▼
code-server  (port forwarding: /proxy/3101/ -> 127.0.0.1:3101 on the host)
   ▼
kimi-codeserver-proxy   (this project: listens on 3101, forwards + rewrites)
   ▼
kimi web               (official UI, bound to 127.0.0.1:58627, Bearer-token auth)
```

## Why this proxy exists

`kimi web` is a **local-first** web service:

- it only binds loopback (`127.0.0.1:58627`), intended for a local browser;
- it enforces a **DNS-rebinding Host check** — any non-loopback `Host` gets `403`, so even setting `KIMI_CODE_ALLOWED_HOSTS` to allow your code-server domain is not enough for the SPA to load;
- the frontend resources it serves are **root-absolute paths** (`/assets/...`, `/boot.js`, `/favicon.ico`), and its JS derives the REST/WS base from `window.location.origin`.

code-server's port forwarding mounts the service under a **sub-path** — `https://host/proxy/<port>/`. When the browser loads the forwarded address, those `/assets/...` references resolve to `https://host/assets/...` (the host root) instead of `/proxy/<port>/assets/...`, and API/WS calls go to `https://host/api/v1/...` — the SPA never loads.

This project is the adapter in between: **it forwards everything to kimi web and rewrites the served HTML/JS/CSS so every root-absolute reference and the origin derivation are prefixed with `/proxy/<port>/`**, making the UI work out of the box under code-server.

## What else it fixes

1. **DNS-rebinding Host fence.** The proxy rewrites each request's `Host`/`Origin` to the loopback upstream (`127.0.0.1:58627`), satisfying kimi's Host check exactly like a local browser direct-connect — no `KIMI_CODE_ALLOWED_HOSTS` needed. `x-forwarded-*` forwarding traces are stripped.
2. **Frontend origin derivation.** kimi's JS computes the API/WS base from `window.location.origin`; the proxy injects the base path into the bundle's `Wke()` expression (`window.location.origin+"/proxy/3101"`), so `api/v1/...` and `/api/v1/ws` land on the forwarded subtree.
3. **No token prompt.** For deployments with unified auth in front (code-server login), the proxy spawns kimi with `--dangerous-bypass-auth` — kimi's own option for sitting behind an authenticating proxy — so the UI never asks for a token. As a fallback for kimi instances running without the flag, the proxy also injects a small client script that seeds the UI's credential storage with the persisted token from `~/.kimi-code/server.token` (overridable via `PROXY_KIMI_TOKEN`). Set `PROXY_KIMI_BYPASS_AUTH=0` to keep kimi's bearer auth (the seeding still removes the prompt).
4. **SPA routing stays under the base path.** Selecting a session makes the frontend `history.pushState` to root-absolute routes (`/sessions/<id>`, `/admin/sessions`, `/devices/<id>`); unpatched, the address bar escapes to `https://host/session/...`. The proxy prefixes the bundle's route constants (used for both building and parsing URLs, so reload/back/forward stay consistent) and the injected script additionally guards `pushState`/`replaceState`, keeping every navigation inside `/proxy/3101/`.

## Quick start

Prerequisites:

- Node.js >= 18
- the `kimi` CLI installed (the proxy can spawn `kimi web` for you; alternatively run kimi yourself)
- a self-hosted code-server with port forwarding configured

### 1. Configure

```bash
cp .env.example .env
# edit .env if needed
```

### 2. Start

```bash
./kimi-service.sh start
# or directly: node proxy.js
```

The proxy listens on `3101` by default. If no kimi web is reachable at `127.0.0.1:58627`, it automatically spawns `kimi web --port 58627 --no-open --dangerous-bypass-auth` (disable via `PROXY_KIMI_BYPASS_AUTH=0`).

### 3. Forward the port in code-server

Forward host port `3101` in code-server. The forwarding address looks like:

```
https://code.your-host/proxy/3101/
```

Open that address in a browser to enter the Kimi web UI — authentication is code-server's job; no manual `#token=` needed.

> Note: if you previously opened the UI under the old proxy, your browser may hold a cached kimi bundle (kimi marks it `immutable`). Hard-refresh once (Ctrl+Shift+R) after upgrading.

## Service script

```bash
./kimi-service.sh start      # start the proxy (auto-spawns kimi web)
./kimi-service.sh stop       # stop proxy + kimi web
./kimi-service.sh restart    # restart
./kimi-service.sh status     # show proxy / kimi web status
./kimi-service.sh url        # print the code-server access URL
./kimi-service.sh logs       # tail the proxy log (Ctrl-C to quit)
```

## Configuration

All settings can be provided via environment variables or a `.env` file (`.env` is gitignored — never commit it).

| Variable | Default | Description |
| --- | --- | --- |
| `PROXY_BASE` | `/proxy/3101` | Base path under which the proxy is reached on code-server, i.e. the forwarded subtree |
| `PROXY_PORT` | `3101` | Port the proxy itself listens on |
| `PROXY_UPSTREAM_HOST` | `127.0.0.1` | Host where kimi web is running |
| `PROXY_UPSTREAM_PORT` | `58627` | Port of kimi web |
| `PROXY_SPAWN_KIMI` | `1` | Set to `0` to disable auto-spawning `kimi web` (e.g. when kimi is managed by systemd/pm2) |
| `PROXY_KIMI_BYPASS_AUTH` | `1` | Spawn `kimi web` with `--dangerous-bypass-auth` (kimi-side auth off, code-server's auth is the gate). Set to `0` to keep kimi's bearer auth |
| `PROXY_KIMI_TOKEN` | empty | Explicit token for the client-side credential seeding; defaults to `~/.kimi-code/server.token` (fallback for kimi instances started without the bypass flag) |
| `PROXY_EXTERNAL_HOST` | empty | Set to your code-server hostname to have the scripts print a full clickable access URL |

## How it works

- **HTML/JS/CSS rewriting** is applied only to `200` responses with `content-type` of HTML, JavaScript, CSS or a Web App Manifest. Root-absolute references (`/boot.js`, `/assets/...`, `/favicon.ico`) are prefixed with the base path after the opening quote, in both double-quoted and single-quoted forms, so the rewritten string stays well-formed. CSS `url(/assets/...)` refs are prefixed; `data:` inline URLs are left alone.
- **SPA route constants** `"/sessions/"`, `"/admin/sessions"` and `"/devices/"` are prefixed inside the JS bundle; REST paths that merely look similar (`"/sessions"` without trailing slash) are server paths and stay untouched.
- **Injected client bootstrap script.** The proxy itself serves `<base>/__kimi-proxy/inject.js` (`no-cache`) and references it from every HTML page right before `</head>`, so it runs before the deferred module bundle. It seeds the `kimi-web.server-credential` record (the app's own storage format, 7-day TTL refreshed on every load) to prevent the token prompt, and wraps `history.pushState`/`replaceState` with a base-prefix guard that covers navigations outside the patched constants (e.g. the literal `"/"` pushed when a session closes).
- **Lazy-loaded chunks need no rewrite.** Vite's dynamic `import("./chunk.js")` resolves relative to the module URL, so chunks land naturally under the base subtree.
- **Everything else streams through untouched** — binaries, JSON, redirects and error responses are piped without being buffered in memory.
- **Request headers.** `Host`/`Origin` are rewritten to the loopback upstream; hop-by-hop headers and `x-forwarded-*` forwarding traces are stripped; `accept-encoding: identity` is forced so the bytes can be rewritten.
- **WebSocket.** `/api/v1/ws` upgrade headers (including `Sec-WebSocket-Protocol`) are forwarded verbatim, so the token subprotocol handshake works through the base-prefixed subtree.
- **Error safety.** An unreachable upstream returns `502`; client disconnects, RSTs and failed WS upgrades are handled without crashing the process.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` close the listener and terminate a spawned `kimi web`, so no orphan process is left behind.

## Version applicability & resource patching

The proxy performs three kinds of rewriting, with different sensitivities to kimi frontend versions:

1. **Version-agnostic prefix rewriting (HTML/CSS/JS) and the injected script.** Root-absolute asset references are prefixed by plain string substitution; the client bootstrap script is generated by the proxy itself and touches no upstream bytes. These are structural, so they keep working across kimi versions regardless of bundle hashes.
2. **Route-constant value replacement (JS).** The three route constants are matched as complete quoted values — semantic route paths, far more stable across versions than minified identifiers (identical in 0.37.2, 0.39.1 and 0.41.0). If kimi ever renames its routes, deep-link restore would degrade, but the injected history guard still keeps navigation inside the base subtree.
3. **Bundle-specific JS patch (`Wke()` origin derivation).** To make API/WS calls land on the forwarded subtree, the proxy rewrites the minified expression inside kimi's origin-resolution function. The match targets a specific minified string.

**Verified against: Kimi Code `0.37.2`, `0.39.1` and `0.41.0`** (frontend bundles `index-yKYHPeXU.js` / `index-ClWTW3HX.js` / `index-CiHMlsuo.js`). 0.41.0 renamed the minified identifiers around the patched expressions (e.g. `Wke`→`Yvt`) but kept the expressions byte-identical, so no proxy change was needed. The `--dangerous-bypass-auth` option needs kimi >= 0.39; on older versions the proxy detects the failed spawn and retries without the flag (token seeding still applies).

**If a future kimi version changes the bundle:** a failed patch match prints a WARN once per process (boot scripts and chunks no longer spam the log) — it never silently ships a broken UI. Then:

1. **Quick workaround:** open the UI with `?kimi_origin=<code-server base URL>` in the address — kimi's frontend natively reads this query parameter and persists it in `sessionStorage`, so API/WS calls reach the right origin without any patch.
2. **Proper fix:** update `WKE_QUOTED` / `WKE_PATCH_RE` / `ROUTE_CONSTANTS` in `proxy.js` to match the new output, and add a matching fixture under `tests/fixtures/` so the regression is covered by a test.

Asset filenames with content hashes (`index-*.js`) are never matched by the proxy, so they may change freely between builds.

## Testing

```bash
npm test
```

- `tests/unit/`: rewriting-logic unit tests (HTML/JS/CSS prefixing, the `Wke()` patch, route constants, sandboxed execution of the client bootstrap script, path normalization, request/response header handling).
- `tests/integration/`: end-to-end tests against a mock upstream that reproduces kimi's Host check and token auth — base-prefix rewriting, API auth, byte-identical binary passthrough, Host rewriting and the WebSocket handshake.
- `tests/helpers/`: mock upstream + proxy subprocess launcher.

## License

MIT
