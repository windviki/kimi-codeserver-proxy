import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../helpers/mock-upstream.mjs";
import { freePort, launchProxy } from "../helpers/launch.mjs";

const TOKEN = "test-token";

let upstream;
let observed;
let proxy;
let proxyPort;
let upstreamPort;
let base;

const via = (p) => `http://127.0.0.1:${proxyPort}${base}${p}`;

before(async () => {
  proxyPort = await freePort();
  upstreamPort = await freePort();
  base = `/proxy/${proxyPort}`;
  ({ server: upstream, observed } = await startMockUpstream(upstreamPort));
  proxy = launchProxy({ proxyPort, upstreamPort, base });
  await proxy.waitReady();
});

after(async () => {
  await proxy?.stop();
  await new Promise((resolve) => upstream?.close(resolve));
});

async function get(path, headers = {}) {
  const res = await fetch(via(path), { headers });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), body: body.toString("utf8"), bytes: body };
}

describe("kimi-codeserver-proxy — base-path adapter behind code-server", () => {
  test("index.html is served with every root-absolute reference base-prefixed", async () => {
    const { status, type, body } = await get("/");
    assert.equal(status, 200);
    assert.match(type, /text\/html/);
    assert.ok(body.includes(`src="${base}/boot.js"`));
    assert.ok(body.includes(`src="${base}/assets/index-yKYHPeXU.js"`));
    assert.ok(body.includes(`href="${base}/assets/index-DBtc5buz.css"`));
    assert.ok(body.includes(`href="${base}/favicon.ico"`));
    assert.equal(body.includes('src="/boot.js'), false);
    assert.equal(body.includes('href="/favicon.ico"'), false);
    // The proxy's client script (token seeding + history fix) is injected.
    assert.ok(body.includes(`<script src="${base}/__kimi-proxy/inject.js"></script></head>`));
  });

  test("the injected client script is served by the proxy itself (never forwarded)", async () => {
    const res = await fetch(via("/__kimi-proxy/inject.js"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /javascript/);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    const body = await res.text();
    assert.ok(body.includes("kimi-web.server-credential"));
    assert.ok(body.includes(`ROOT=${JSON.stringify(base)}`), "history fix must know the base path");
    assert.ok(body.includes(JSON.stringify("test-token")), "seeded token comes from PROXY_KIMI_TOKEN");
    // It must not hit the upstream (which would 401 without auth anyway).
    const observedBody = await (await get("/__observed__")).body;
    assert.equal(JSON.parse(observedBody).some((r) => r.path.includes("__kimi-proxy")), false);
  });

  test("JS bundle has the origin-resolution patch and prefixed /assets/ refs", async () => {
    const { status, body } = await get("/assets/index-yKYHPeXU.js");
    assert.equal(status, 200);
    assert.ok(body.includes(`window.location.origin+"${base}"`), "Wke must append the base path");
    assert.equal(body.includes('"/assets/'), false, "no bare root-absolute /assets/ may remain");
    assert.equal(body.includes('"/favicon.ico"'), false);
    // SPA route constants are prefixed so pushState URLs and pathname parsing
    // stay consistent under the base path.
    assert.ok(body.includes(`const uC="${base}/sessions/",fz="${base}/admin/sessions"`));
    assert.ok(body.includes(`const lk="${base}/devices/"`));
  });

  test("CSS webfont url() refs are prefixed", async () => {
    const { status, body } = await get("/assets/index-DBtc5buz.css");
    assert.equal(status, 200);
    assert.equal(body.includes("url(/assets/"), false);
    assert.ok(body.includes(`url(${base}/assets/`));
  });

  test("REST API works with the bearer token and is denied without it", async () => {
    const ok = await get("/api/v1/meta", { Authorization: `Bearer ${TOKEN}` });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.includes("server_version"));
    const denied = await get("/api/v1/meta");
    assert.equal(denied.status, 401);
  });

  test("SPA deep-link routes serve the rewritten index.html", async () => {
    const { status, type, body } = await get("/settings?tab=archived");
    assert.equal(status, 200);
    assert.match(type, /text\/html/);
    assert.ok(body.includes(`src="${base}/boot.js"`));
  });

  test("session deep links (reload on /sessions/<id>) serve the rewritten app", async () => {
    const { status, type, body } = await get(`/sessions/abc-123?rc=x`);
    assert.equal(status, 200);
    assert.match(type, /text\/html/);
    assert.ok(body.includes(`src="${base}/assets/index-yKYHPeXU.js"`));
    assert.ok(body.includes(`<script src="${base}/__kimi-proxy/inject.js"></script>`));
  });

  test("binary assets pass through byte-identical (no buffered rewrite)", async () => {
    const res = await fetch(via("/assets/blob.bin"));
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.toString("hex"), "00010203feff8040");
  });

  test("every upstream request is rewritten to the loopback Host (DNS-rebinding fence)", async () => {
    const obs = await (await get("/__observed__")).body;
    const all = JSON.parse(obs);
    assert.ok(all.length >= 3);
    for (const r of all) assert.equal(r.host, `127.0.0.1:${upstreamPort}`);
  });

  test("WebSocket upgrade passes through with the bearer subprotocol and rewrites Host", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}${base}/api/v1/ws?client_id=it`, [
      `kimi-code.bearer.${TOKEN}`,
    ]);
    const hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.onopen = () => {
        observed.push({ path: "/api/v1/ws?client_id=it", host: "direct-client" });
      };
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        resolve(String(ev.data));
      };
      ws.onerror = (e) => reject(new Error(e.message));
    });
    ws.close();
    const msg = JSON.parse(hello);
    assert.equal(msg.type, "server_hello");
    assert.equal(msg.via, "mock-upstream");
  });
});
