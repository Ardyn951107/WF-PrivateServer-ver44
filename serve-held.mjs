// serve-held.mjs - keeps the game "holding" while the SpaceNinjaServer is down, and restarts the server if it dies.
//
//   game --> [this script: 80 / 443] --> SpaceNinjaServer [8080 / 8443]
//
// * The proxy is a plain TCP pipe, so HTTP, HTTPS and WebSocket all pass through untouched (no TLS handling).
// * If the server is not reachable, the game's new connections are accepted and HELD (nothing is sent back)
//   until the server is listening again, then they are connected through. The game just sees a slow response.
// * The server is run as a child process and is restarted automatically if it exits (e.g. the embedded MongoDB crash).
// * Not covered: a request that is already in flight when the server dies (it fails and the game handles it
//   as usual), the UDP hub/IRC traffic, and how long the *game itself* is willing to wait for a reply.
//
// Usage (from the SpaceNinjaServer folder, with the server stopped):
//   node serve-held.mjs --setup     one time: moves the server to ports 8080/8443 in config.json (makes a backup)
//   node serve-held.mjs             start proxy + server (auto-restart)
//   node serve-held.mjs --proxy-only   only the proxy (you start the server yourself, on 8080/8443)
//   node serve-held.mjs --restore   put config.json ports back to 80/443 (to run the server without this script)
// Options: --hold-max <minutes> (default 30), --restart-delay <seconds> (default 3), --http <port> --https <port> (upstream ports)

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

const UP_HTTP = parseInt(opt("--http", "8080"));
const UP_HTTPS = parseInt(opt("--https", "8443"));
const HOLD_MAX_MS = parseFloat(opt("--hold-max", "30")) * 60_000;
const RESTART_DELAY_MS = parseFloat(opt("--restart-delay", "3")) * 1000;
const RETRY_MS = 400;
const configPath = path.join(here, "config.json");

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[hold ${stamp()}]`, ...a);

// ---------- config helpers ----------
const readConfigPorts = () => {
    const txt = fs.readFileSync(configPath, "utf8");
    const h = /"httpPort"\s*:\s*(\d+)/.exec(txt);
    const s = /"httpsPort"\s*:\s*(\d+)/.exec(txt);
    return { txt, http: h ? parseInt(h[1]) : undefined, https: s ? parseInt(s[1]) : undefined };
};
const setConfigPorts = (http, https) => {
    const { txt } = readConfigPorts();
    let out = txt;
    for (const [key, val] of [["httpPort", http], ["httpsPort", https]]) {
        const re = new RegExp(`("${key}"\\s*:\\s*)\\d+`);
        out = re.test(out) ? out.replace(re, `$1${val}`) : out.replace(/\{/, `{\n  "${key}": ${val},`);
    }
    return out;
};

if (flag("--setup") || flag("--restore")) {
    const [h, s] = flag("--setup") ? [UP_HTTP, UP_HTTPS] : [80, 443];
    fs.copyFileSync(configPath, configPath + ".bak-before-serve-held");
    fs.writeFileSync(configPath, setConfigPorts(h, s));
    const now = readConfigPorts();
    log(`config.json ports are now http=${now.http} https=${now.https} (backup: config.json.bak-before-serve-held)`);
    process.exit(0);
}

// ---------- the holding TCP proxy ----------
const waiting = new Set(); // connections currently being held
let holdingSince = 0;

const startProxy = (listenPort, upstreamPort, label) => {
    const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: false }, client => {
        const entry = { client, since: Date.now() };
        let closed = false;
        client.setNoDelay(true);
        client.setKeepAlive(true, 15_000);
        client.on("error", () => {});
        client.on("close", () => {
            closed = true;
            waiting.delete(entry);
        });

        const attempt = () => {
            if (closed) return;
            if (Date.now() - entry.since > HOLD_MAX_MS) {
                log(`${label}: gave up holding a connection after ${(HOLD_MAX_MS / 60000).toFixed(0)} min`);
                client.destroy();
                return;
            }
            const up = net.connect({ host: "127.0.0.1", port: upstreamPort });
            up.setNoDelay(true);
            up.once("error", () => {
                up.destroy();
                if (closed) return;
                if (!waiting.has(entry)) {
                    if (waiting.size === 0) holdingSince = Date.now();
                    waiting.add(entry);
                    log(`${label}: server on :${upstreamPort} not reachable - holding connection (${waiting.size} held)`);
                }
                setTimeout(attempt, RETRY_MS);
            });
            up.once("connect", () => {
                up.removeAllListeners("error");
                up.on("error", () => client.destroy());
                if (closed) {
                    up.destroy();
                    return;
                }
                if (waiting.delete(entry) && waiting.size === 0) {
                    log(`${label}: server is back - released held connection(s) after ${((Date.now() - holdingSince) / 1000).toFixed(1)}s`);
                }
                client.pipe(up);
                up.pipe(client);
                client.on("close", () => up.destroy());
                up.on("close", () => client.destroy());
                client.resume();
            });
        };
        attempt();
    });
    server.on("error", e => {
        log(`${label}: cannot listen on :${listenPort} (${e.code}). Is the SpaceNinjaServer still running on that port? Stop it and run --setup first.`);
        process.exit(1);
    });
    server.listen(listenPort, "0.0.0.0", () => log(`${label}: listening on :${listenPort} -> 127.0.0.1:${upstreamPort}`));
    return server;
};

// listen ports can be overridden for testing
const LISTEN_HTTP = parseInt(opt("--listen-http", "80"));
const LISTEN_HTTPS = parseInt(opt("--listen-https", "443"));

try {
    if (!flag("--proxy-only") && !flag("--no-config-check")) {
        const p = readConfigPorts();
        if (p.http !== UP_HTTP || p.https !== UP_HTTPS) {
            log(`config.json has httpPort=${p.http ?? "(unset=80)"} httpsPort=${p.https ?? "(unset=443)"} but the server must be on ${UP_HTTP}/${UP_HTTPS}.`);
            log("Run:  node serve-held.mjs --setup   (then start again)");
            process.exit(1);
        }
    }
} catch (e) {
    log("could not read config.json:", e.message);
    process.exit(1);
}

startProxy(LISTEN_HTTP, UP_HTTP, "http ");
startProxy(LISTEN_HTTPS, UP_HTTPS, "https");

// ---------- the supervisor ----------
if (!flag("--proxy-only")) {
    let stopping = false;
    let child;
    // Same two commands as "npm run raw", without npm/shell in between so Ctrl+C reaches the server cleanly.
    const entry = opt("--entry", "src/index.ts");
    const precheck = path.join(here, "scripts", "raw-precheck.js");

    const launch = () => {
        if (fs.existsSync(precheck)) {
            const r = spawnSync(process.execPath, [precheck], { cwd: here, stdio: "inherit" });
            if (r.status !== 0) log(`raw-precheck exited with ${r.status} (continuing)`);
        }
        log(`starting server: node --experimental-strip-types ${entry}`);
        child = spawn(process.execPath, ["--experimental-strip-types", entry], { cwd: here, stdio: "inherit" });
        child.on("exit", (code, signal) => {
            if (stopping) process.exit(0);
            log(`server exited (code=${code} signal=${signal}) - restarting in ${RESTART_DELAY_MS / 1000}s; the game's new requests are held meanwhile`);
            setTimeout(launch, RESTART_DELAY_MS);
        });
    };
    // Ctrl+C is delivered to the server child as well (shared console); let it shut down gracefully, then we exit.
    process.on("SIGINT", () => {
        stopping = true;
        log("Ctrl+C - waiting for the server to shut down...");
        setTimeout(() => process.exit(0), 20_000).unref();
    });
    process.on("SIGTERM", () => {
        stopping = true;
        child?.kill("SIGINT");
    });
    launch();
}
