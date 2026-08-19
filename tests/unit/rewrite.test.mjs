import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  prefixQuoted,
  patchApiBase,
  rewriteHtml,
  rewriteJs,
  rewriteCss,
  needsRewrite,
  rewriteBody,
  normalizePath,
  requestHeaders,
  responseHeaders,
} from "../../proxy.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const BASE = "/proxy/3101";

const readFixture = (name) => readFile(path.join(FIXTURES, name), "utf8");

describe("rewriteHtml — root-absolute refs in kimi's index.html", () => {
  test("prefixes every root-absolute path in the real index.html", async () => {
    const html = await readFixture("index.html");
    const out = rewriteHtml(html, BASE);

    // The four references from the real index.html must be base-prefixed.
    assert.ok(out.includes('href="/proxy/3101/favicon.ico"'));
    assert.ok(out.includes('src="/proxy/3101/boot.js"'));
    assert.ok(out.includes('src="/proxy/3101/assets/index-yKYHPeXU.js"'));
    assert.ok(out.includes('href="/proxy/3101/assets/index-DBtc5buz.css"'));

    // No root-absolute reference may survive (a surviving one would be
    // src="/assets/...", src="/boot.js" or href="/favicon.ico", not the
    // already-prefixed src="/proxy/3101/..." forms).
    assert.equal(out.includes('src="/assets/'), false);
    assert.equal(out.includes('src="/boot.js'), false);
    assert.equal(out.includes('href="/favicon.ico"'), false);

    // Non-path bytes are untouched and nothing is double-prefixed.
    assert.ok(out.includes("useKimiWebClient"));
    assert.equal(out.includes(BASE + BASE), false);
  });

  test("returns the body unchanged when base is /", () => {
    assert.equal(rewriteHtml('<script src="/boot.js"></script>', "/"), '<script src="/boot.js"></script>');
  });

  test("does not touch single-quoted or unquoted URL-looking text", () => {
    const body = `const a='/assets/x.js'; const b=href=/assets/y.js;`;
    const out = rewriteHtml(body, BASE);
    assert.equal(out, body);
  });
});

describe("patchApiBase — kimi's origin-resolution expression", () => {
  test("appends the base path after window.location.origin (exact 0.37.2 string)", () => {
    const fn = 'function Wke(){return typeof window<"u"&&window.location?.origin?window.location.origin:"http://127.0.0.1:58627"}';
    const out = patchApiBase(fn, BASE);
    assert.ok(out.includes(`window.location.origin+"${BASE}"`));
    // The default-port fallback literal is preserved.
    assert.ok(out.includes('"http://127.0.0.1:58627"'));
  });

  test("matches a different default port via regex (future kimi version)", () => {
    const fn = 'function Wke(){return typeof window<"u"&&window.location?.origin?window.location.origin:"http://127.0.0.1:5494"}';
    const out = patchApiBase(fn, BASE);
    assert.ok(out.includes(`window.location.origin+"${BASE}"`));
  });

  test("leaves the body untouched when the pattern is absent (warns but no rewrite)", () => {
    const src = "function other(){return window.location.origin}";
    const out = patchApiBase(src, BASE);
    assert.equal(out, src);
  });

  test("returns the body unchanged when base is /", () => {
    const fn = 'function Wke(){return typeof window<"u"&&window.location?.origin?window.location.origin:"http://127.0.0.1:58627"}';
    assert.equal(patchApiBase(fn, "/"), fn);
  });
});

describe("rewriteJs — bundle rewriting", () => {
  test("patches Wke AND prefixes every /assets/ reference in the real bundle excerpt", async () => {
    const js = await readFixture("index.js.fixture.js");
    const out = rewriteJs(js, BASE);

    // Wke origin-resolution must now yield origin + base.
    const wke = out.slice(out.indexOf("function Wke()"), out.indexOf("function Wke()") + 200);
    assert.ok(wke.includes(`window.location.origin+"${BASE}"`));

    // Every root-absolute /assets/ reference is prefixed; none survives bare.
    assert.equal(out.split('"/assets/').length - 1, 0);
    assert.ok(out.split(`"${BASE}/assets/`).length - 1 >= 4);

    // API path literals are appended to serverHttpUrl at runtime, so they must
    // NOT be rewritten (they are not root-absolute in the served JS).
    assert.ok(out.includes('"/api/v1"'));
    assert.ok(out.includes('"/sessions:archive"'));
    assert.ok(out.includes('"/oauth/login"'));
  });

  test("does not double-prefix", async () => {
    const js = await readFixture("index.js.fixture.js");
    const once = rewriteJs(js, BASE);
    const twice = rewriteJs(once, BASE);
    assert.equal(twice, once);
  });
});

describe("rewriteCss — webfont url() references", () => {
  test("prefixes url(/assets/...) while leaving data: URLs alone", async () => {
    const css = await readFixture("index.css.fixture.css");
    const out = rewriteCss(css, BASE);

    assert.equal(out.split("url(/assets/").length - 1, 0);
    assert.ok(out.split(`url(${BASE}/assets/`).length - 1 >= 4);
    // Inline data: fonts must stay untouched.
    assert.ok(out.includes("url(data:font/woff2;base64,"));
  });

  test("returns the body unchanged when base is /", () => {
    assert.equal(rewriteCss("a{src:url(/assets/x.woff2)}", "/"), "a{src:url(/assets/x.woff2)}");
  });
});

describe("rewriteBody / needsRewrite — dispatch", () => {
  test("rewrites only 200 text responses that can carry root-absolute refs", () => {
    assert.equal(needsRewrite(200, "text/html; charset=utf-8"), true);
    assert.equal(needsRewrite(200, "text/javascript; charset=utf-8"), true);
    assert.equal(needsRewrite(200, "text/css; charset=utf-8"), true);
    assert.equal(needsRewrite(200, "application/manifest+json"), true);
    assert.equal(needsRewrite(200, "application/json"), false);
    assert.equal(needsRewrite(200, "image/png"), false);
    assert.equal(needsRewrite(200, ""), false);
    assert.equal(needsRewrite(404, "text/html"), false);
    assert.equal(needsRewrite(302, "text/html"), false);
  });

  test("dispatches by content type", () => {
    assert.equal(rewriteBody('<script src="/boot.js"></script>', BASE, "text/html").includes('src="/proxy/3101/boot.js"'), true);
    assert.equal(rewriteBody("a{src:url(/assets/x.woff2)}", BASE, "text/css").includes(`url(${BASE}/assets/`), true);
    const js = 'function Wke(){return typeof window<"u"&&window.location?.origin?window.location.origin:"http://127.0.0.1:58627"}';
    assert.equal(rewriteBody(js, BASE, "text/javascript").includes(`window.location.origin+"${BASE}"`), true);
  });
});

describe("normalizePath — base stripping for code-server forwarding", () => {
  test("strips the base prefix and collapses leading slashes", () => {
    assert.equal(normalizePath("/proxy/3101/"), "/");
    assert.equal(normalizePath("/proxy/3101/api/v1/meta"), "/api/v1/meta");
    assert.equal(normalizePath("/proxy/3101//api/v1/ws"), "/api/v1/ws");
    assert.equal(normalizePath("/"), "/");
    assert.equal(normalizePath(""), "/");
  });
});

describe("requestHeaders / responseHeaders — loopback impersonation", () => {
  test("rewrites Host/Origin to the loopback upstream", () => {
    const out = requestHeaders({
      host: "code.your-host.com",
      origin: "https://code.your-host.com",
      "x-forwarded-for": "1.2.3.4",
      authorization: "Bearer t",
    });
    assert.equal(out.host, "127.0.0.1:58627");
    assert.equal(out.origin, "http://127.0.0.1:58627");
    assert.equal(out.authorization, "Bearer t");
    // Forwarding traces are stripped; no hop-by-hop leftovers.
    assert.equal(out["x-forwarded-for"], undefined);
    assert.equal(out["accept-encoding"], "identity");
  });

  test("drops hop-by-hop headers from responses but keeps real headers", () => {
    const out = responseHeaders({
      "content-type": "text/html",
      "content-length": "42",
      connection: "keep-alive",
      "set-cookie": "a=b",
    });
    assert.equal(out["content-type"], "text/html");
    assert.equal(out["set-cookie"], "a=b");
    assert.equal(out.connection, undefined);
  });
});
