import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
const INDEX_HTML = readFileSync(path.join(FIXTURES, "index.html"));
const INDEX_JS = readFileSync(path.join(FIXTURES, "index.js.fixture.js"));
const INDEX_CSS = readFileSync(path.join(FIXTURES, "index.css.fixture.css"));
const BOOT_JS = Buffer.from("(function(){window.__boot=true})();");
const FAVICON = Buffer.from("fake-favicon-bytes-0123456789");
const BINARY = Buffer.from([0, 1, 2, 3, 254, 255, 128, 64]); // non-UTF8-safe bytes

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TOKEN = "test-token";

/**
 * Starts a mock upstream that mimics `kimi web`'s observable surface:
 *  - serves the SPA fixtures under the same paths/content-types
 *  - enforces a DNS-rebinding-style Host check (403 unless Host is the loopback
 *    upstream authority) so the test proves the proxy rewrites Host
 *  - requires Authorization: Bearer <TOKEN> on /api/v1/*
 *  - performs the WebSocket upgrade on /api/v1/ws and sends a server_hello
 *  - records every request's Host + path under /__observed__ for assertions
 */
export function startMockUpstream(port) {
  const observed = [];
  const server = http.createServer((req, res) => {
    const host = req.headers.host;
    observed.push({ path: req.url, host });
    if (host !== `127.0.0.1:${port}`) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    const url = req.url.split("?")[0];
    if (url === "/") return serve(res, 200, "text/html; charset=utf-8", INDEX_HTML);
    if (url === "/assets/index-yKYHPeXU.js") return serve(res, 200, "text/javascript; charset=utf-8", INDEX_JS);
    if (url === "/assets/index-DBtc5buz.css") return serve(res, 200, "text/css; charset=utf-8", INDEX_CSS);
    if (url === "/boot.js") return serve(res, 200, "text/javascript; charset=utf-8", BOOT_JS);
    if (url === "/favicon.ico") return serve(res, 200, "image/x-icon", FAVICON);
    if (url === "/assets/blob.bin") return serve(res, 200, "application/octet-stream", BINARY);
    if (url === "/__observed__") {
      return serve(res, 200, "application/json", Buffer.from(JSON.stringify(observed)));
    }
    if (url.startsWith("/api/v1/")) {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return serve(res, 401, "application/json", Buffer.from('{"code":401,"msg":"unauthorized"}'));
      }
      if (url === "/api/v1/meta") {
        return serve(res, 200, "application/json; charset=utf-8", Buffer.from('{"code":0,"data":{"server_version":"mock"}}'));
      }
    }
    // SPA fallback: any other route serves index.html, like kimi's backend.
    return serve(res, 200, "text/html; charset=utf-8", INDEX_HTML);
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"] || "";
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    let head =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n`;
    if (req.headers["sec-websocket-protocol"]) {
      head += `Sec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}\r\n`;
    }
    head += "\r\n";
    socket.write(head);
    const payload = Buffer.from(JSON.stringify({ type: "server_hello", via: "mock-upstream" }));
    const frame = Buffer.alloc(2 + payload.length);
    frame[0] = 0x81; // FIN + text
    frame[1] = payload.length; // unmasked server frame, length < 126
    payload.copy(frame, 2);
    socket.write(frame);
    socket.on("data", () => {}); // swallow client frames
    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, observed }));
  });
}

function serve(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "content-length": String(body.length) });
  res.end(body);
}
