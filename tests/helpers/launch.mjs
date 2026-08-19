import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const PROXY_FILE = fileURLToPath(new URL("../../proxy.js", import.meta.url));

/**
 * Spawns the real proxy as a subprocess with an isolated configuration.
 * Returns { proc, waitReady, stop, logs }.
 */
export function launchProxy({ proxyPort, upstreamPort, base }) {
  const env = {
    ...process.env,
    PROXY_BASE: base,
    PROXY_PORT: String(proxyPort),
    PROXY_UPSTREAM_HOST: "127.0.0.1",
    PROXY_UPSTREAM_PORT: String(upstreamPort),
    PROXY_SPAWN_KIMI: "0",
    PROXY_EXTERNAL_HOST: "",
  };
  const proc = spawn(process.execPath, [PROXY_FILE], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  proc.stdout.on("data", (d) => logs.push(`[stdout] ${d}`));
  proc.stderr.on("data", (d) => logs.push(`[stderr] ${d}`));

  const waitReady = () =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const attempt = () => {
        if (proc.exitCode !== null) {
          reject(new Error(`proxy exited early (${proc.exitCode})\n${logs.join("")}`));
          return;
        }
        const req = net.connect(proxyPort, "127.0.0.1", () => {
          req.destroy();
          resolve();
        });
        req.on("error", () => {
          if (Date.now() > deadline) reject(new Error(`proxy did not listen on ${proxyPort}\n${logs.join("")}`));
          else setTimeout(attempt, 100);
        });
      };
      attempt();
    });

  const stop = () =>
    new Promise((resolve) => {
      proc.on("exit", () => resolve());
      proc.kill("SIGTERM");
      setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 3000);
    });

  return { proc, waitReady, stop, logs };
}
