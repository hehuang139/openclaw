import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type Socket } from "node:net";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  mintSecretSentinel,
  SECRET_SENTINEL_MAX_LENGTH,
  SECRET_SENTINEL_PREFIX,
} from "../sentinel.js";
import type { SecretEgressProxyAuditEvent, SecretEgressProxyHandle } from "./proxy-server.js";
import * as egress from "./proxy.test-support.js";

describe("secret egress proxy", () => {
  type OriginRequest = {
    body: string;
    headers: Record<string, string | string[] | undefined>;
    url: string;
  };

  let origin: Server;
  const proxies: SecretEgressProxyHandle[] = [];
  const sockets = new Set<Socket>();
  const seed = egress.useCaSeed("openclaw-egress-proxy-test-");
  let caDir: string;
  let auditEvents: SecretEgressProxyAuditEvent[];
  let originRequests: OriginRequest[];
  let originPort: number;
  let proxy: SecretEgressProxyHandle;
  let proxyEnv: Record<string, string>;

  function registerSentinel(sentinel: string, allowedHosts = ["localhost"], targetProxy = proxy) {
    return targetProxy.registerProcess([egress.binding(sentinel, allowedHosts)]).env;
  }

  function proxyAuth(env = proxyEnv): string {
    return egress.basicAuth(new URL(env.HTTPS_PROXY!).password);
  }

  async function rawConnect(params: {
    auth?: string;
    proxyOrigin?: string;
  }): Promise<{ response: string; socket: Socket }> {
    const proxyUrl = new URL(params.proxyOrigin ?? proxy.proxyOrigin);
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    await once(socket, "connect");
    const authLine = params.auth ? `Proxy-Authorization: ${params.auth}\r\n` : "";
    socket.write(
      `CONNECT localhost:${originPort} HTTP/1.1\r\nHost: localhost:${originPort}\r\n${authLine}\r\n`,
    );
    const response = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("latin1");
        if (buffered.includes("\r\n\r\n")) {
          socket.off("data", onData);
          resolve(buffered);
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("close", () => resolve(buffered));
    });
    return { response, socket };
  }

  // Preserve raw UTF-8 bytes and Content-Length before Content-Disposition.
  const RAW_UPSTREAM_RESPONSES: Record<string, string> = {
    "/cjk-attachment":
      'HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Disposition: attachment; filename="附件_2026-09-21.log"\r\nConnection: close\r\n\r\nfile',
    "/invalid-trailer":
      "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTrailer: Expires\r\nConnection: close\r\n\r\nfile",
  };

  async function requestThroughTunnel(
    params: {
      path?: string;
      headers?: Record<string, string>;
      bodyChunks?: readonly (string | Buffer)[];
      contentLength?: number;
      caPath?: string;
      proxyEnv?: Record<string, string>;
    },
    expectedStatus = 200,
  ): Promise<{ body: string; head: string }> {
    const env = params.proxyEnv ?? proxyEnv;
    const connected = await rawConnect({
      auth: proxyAuth(env),
      proxyOrigin: new URL(env.HTTPS_PROXY!).origin,
    });
    expect(connected.response).toContain("200 Connection Established");
    const secureSocket = tls.connect({
      socket: connected.socket,
      servername: "localhost",
      ca: fs.readFileSync(params.caPath ?? proxy.caCertPath),
    });
    await once(secureSocket, "secureConnect");
    expect(secureSocket.authorized).toBe(true);
    const continued = createDeferredCore();
    const received = new Promise<string>((resolve, reject) => {
      let output = "";
      secureSocket.setEncoding("utf8");
      secureSocket.on("data", (chunk) => {
        output += chunk.toString();
        if (output.startsWith("HTTP/1.1 100 Continue\r\n\r\n")) {
          continued.resolve();
        }
      });
      secureSocket.once("end", () => resolve(output));
      secureSocket.once("error", reject);
    });
    const bodyChunks = params.bodyChunks ?? [];
    const headers = {
      Host: `localhost:${originPort}`,
      Connection: "close",
      ...(params.contentLength !== undefined
        ? { "Content-Length": String(params.contentLength) }
        : bodyChunks.length > 0
          ? { "Transfer-Encoding": "chunked" }
          : {}),
      ...params.headers,
    };
    secureSocket.write(`POST ${params.path ?? "/"} HTTP/1.1\r\n`);
    for (const [name, value] of Object.entries(headers)) {
      secureSocket.write(`${name}: ${value}\r\n`);
    }
    secureSocket.write("\r\n");
    if (params.headers?.Expect === "100-continue") {
      await Promise.race([
        continued.promise,
        received.then(() => {
          throw new Error("Proxy did not acknowledge 100-continue");
        }),
      ]);
    }
    for (const chunk of bodyChunks) {
      if (params.contentLength === undefined) {
        secureSocket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n`);
      }
      secureSocket.write(chunk);
      if (params.contentLength === undefined) {
        secureSocket.write("\r\n");
      }
    }
    if (bodyChunks.length > 0 && params.contentLength === undefined) {
      secureSocket.write("0\r\n\r\n");
    }
    const raw = (await received).replace(/^(?:HTTP\/1\.1 100 Continue\r\n\r\n)+/u, "");
    const [head = "", body = ""] = raw.split("\r\n\r\n", 2);
    const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(head)?.[1]);
    expect(status).toBe(expectedStatus);
    return { body, head };
  }

  async function forwardedRequest(
    auth?: string,
    protocol = "https",
    proxyOrigin = proxy.proxyOrigin,
    requestTarget?: string,
  ): Promise<number> {
    const proxyUrl = new URL(proxyOrigin);
    const response = await egress.openRequest({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port,
      path: requestTarget ?? `${protocol}://localhost:${originPort}/forwarded-auth`,
      method: "GET",
      headers: auth ? { "Proxy-Authorization": auth } : undefined,
    });
    return (await egress.readResponse(response)).status;
  }

  function tamperSentinel(sentinel: string): string {
    const index = SECRET_SENTINEL_PREFIX.length;
    const replacement = sentinel[index] === "A" ? "B" : "A";
    return `${sentinel.slice(0, index)}${replacement}${sentinel.slice(index + 1)}`;
  }

  beforeEach(async () => {
    auditEvents = [];
    originRequests = [];
    caDir = seed.make();
    proxy = await egress.createProxy(caDir, auditEvents);
    proxies.push(proxy);
    origin = createHttpsServer(seed.leaf, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        originRequests.push({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: { ...request.headers },
          url: request.url ?? "",
        });
        const rawResponse = RAW_UPSTREAM_RESPONSES[request.url ?? ""];
        if (rawResponse) {
          request.socket.end(Buffer.from(rawResponse));
          return;
        }
        if (request.url === "/redirect") {
          response.writeHead(307, {
            Location: `https://127.0.0.1:${originPort}/redirected`,
            Connection: "close",
            "Content-Length": 0,
          });
          response.end();
          return;
        }
        if (request.url?.startsWith("/git/")) {
          response.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
          response.end(
            request.url === "/git/HEAD"
              ? "ref: refs/heads/main\n"
              : `${"a".repeat(40)}\trefs/heads/main\n`,
          );
          return;
        }
        const status =
          request.url === "/fixed-length" && request.headers["content-length"] === undefined
            ? 411
            : 200;
        response.writeHead(status, { Connection: "close", "Content-Length": 2 });
        response.end("ok");
      });
    });
    originPort = await egress.listen(origin);
    proxyEnv = proxy.registerProcess().env;
  });

  afterAll(seed.cleanup);

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    for (const currentProxy of proxies.splice(0)) {
      await currentProxy.stop();
    }
    origin?.closeAllConnections();
    if (origin) {
      await egress.closeServer(origin);
    }
    fs.rmSync(caDir, { recursive: true, force: true });
  });

  it("substitutes Basic credentials without decoding unrelated base64", async () => {
    const username = mintSecretSentinel("synthetic-user", { label: "basic-user" });
    const password = mintSecretSentinel("synthetic-password", { label: "basic-password" });
    proxyEnv = proxy.registerProcess([
      egress.binding(username, ["localhost"], "USERNAME"),
      egress.binding(password, ["localhost"], "PASSWORD"),
    ]).env;
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    await requestThroughTunnel({
      headers: {
        Authorization: `Basic ${encoded}`,
        "X-Encoded": encoded,
        "Proxy-Authorization": `Basic ${encoded}`,
      },
      bodyChunks: [encoded],
    });
    expect(originRequests[0]).toMatchObject({
      body: encoded,
      headers: {
        authorization: egress.basic("synthetic-user:synthetic-password"),
        "x-encoded": encoded,
        "proxy-authorization": undefined,
      },
    });
  });

  it.each([
    "unregistered",
    "tampered",
    "no-colon",
    "control-byte",
    "invalid-utf8",
    "raw-basic",
    "noncanonical",
  ])("refuses %s Basic sentinels before the origin receives credentials", async (kind) => {
    const sentinel = mintSecretSentinel("synthetic-refused-secret", { label: "basic-refusal" });
    const candidate = kind === "tampered" ? tamperSentinel(sentinel) : sentinel;
    if (kind !== "unregistered") {
      proxyEnv = registerSentinel(candidate);
    }
    const decoded =
      kind === "no-colon" ? candidate : `user:${candidate}${kind === "control-byte" ? "\n" : ""}`;
    const bytes =
      kind === "invalid-utf8"
        ? Buffer.concat([Buffer.from(decoded), Buffer.from([255])])
        : Buffer.from(decoded);
    const encoded = bytes.toString("base64");
    const credential =
      kind === "raw-basic"
        ? candidate
        : kind === "noncanonical"
          ? encoded.replace(/=+$/u, "") + (encoded.endsWith("==") ? "=" : "==")
          : encoded;
    const authorization = `Basic ${credential}`;
    await requestThroughTunnel({ headers: { Authorization: authorization } }, 502);
    expect(originRequests).toEqual([]);
    expect(auditEvents.at(-1)?.reason).toBe("unresolved-sentinel");
  });

  it.each(["bAsIc dXNlcjpwYXNz", "Basic malformed!"])(
    "preserves ordinary Basic headers byte-for-byte: %s",
    async (authorization) => {
      await requestThroughTunnel({ headers: { Authorization: authorization } });
      expect(originRequests[0]?.headers.authorization).toBe(authorization);
      expect(auditEvents.at(-1)?.substituted).toBe(false);
    },
  );

  it("returns redirects without following and reauthorizes their destinations", async () => {
    const sentinel = mintSecretSentinel("synthetic-redirect-secret", { label: "basic-redirect" });
    proxyEnv = registerSentinel(sentinel);
    const headers = { Authorization: egress.basic(`user:${sentinel}`) };
    const redirected = await requestThroughTunnel({ path: "/redirect", headers }, 307);
    expect(redirected.head).toContain(`https://127.0.0.1:${originPort}/redirected`);
    expect(originRequests).toHaveLength(1);
    await requestThroughTunnel(
      { path: `https://127.0.0.1:${originPort}/redirected`, headers },
      502,
    );
    expect(originRequests).toHaveLength(1);
    expect(auditEvents.at(-1)?.reason).toBe("destination-not-allowed");
  });

  it("forwards a CJK attachment filename from a real upstream and keeps serving", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const attachment = await requestThroughTunnel({ path: "/cjk-attachment" });
      expect(attachment.body).toBe("file");
      expect(attachment.head.toLowerCase()).toContain(
        "content-disposition: attachment; filename=\"___2026-09-21.log\"; filename*=utf-8''%e9%99%84%e4%bb%b6_2026-09-21.log",
      );

      const rejected = await requestThroughTunnel({ path: "/invalid-trailer" }, 502);
      expect(rejected.body).toBe("Secret egress proxy could not forward the upstream response.\n");

      expect((await requestThroughTunnel({ path: "/after" })).body).toBe("ok");
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it.each(["overlong", "wrong-host"] as const)(
    "refuses %s sentinels inside fixed-length binary content",
    async (kind) => {
      const sentinel = mintSecretSentinel("synthetic-body-credential", { label: kind });
      proxyEnv = registerSentinel(
        sentinel,
        kind === "wrong-host" ? ["other.example"] : ["localhost"],
      );
      const body = Buffer.concat([
        Buffer.from([0, 255, 128]),
        Buffer.from(
          kind === "overlong"
            ? SECRET_SENTINEL_PREFIX + "x".repeat(SECRET_SENTINEL_MAX_LENGTH)
            : sentinel,
        ),
      ]);
      await requestThroughTunnel(
        {
          headers: { "Content-Type": "application/octet-stream" },
          contentLength: body.length,
          bodyChunks: [body],
        },
        502,
      );
      expect(originRequests).toEqual([]);
      expect(auditEvents.at(-1)).toMatchObject({
        kind: "refused",
        reason: kind === "wrong-host" ? "destination-not-allowed" : "unresolved-sentinel",
      });
    },
  );

  it("rejects conflicting content-length and chunked request framing", async () => {
    await requestThroughTunnel(
      { headers: { "Content-Length": "1", "Transfer-Encoding": "chunked" } },
      400,
    );
    expect(originRequests).toEqual([]);
  });

  it("refuses malformed direct/TLS targets and keeps serving", async () => {
    const target = "https://bad_host/";
    const auth = proxyAuth();
    await expect(forwardedRequest(auth, "https", proxy.proxyOrigin, target)).resolves.toBe(400);
    await requestThroughTunnel({ path: target }, 400);
    expect(originRequests).toEqual([]);
    expect(auditEvents).toEqual([
      expect.objectContaining({ kind: "refused", substituted: false }),
      expect.objectContaining({ kind: "refused", substituted: false }),
    ]);
    await expect(forwardedRequest(auth)).resolves.toBe(200);
    expect(originRequests).toHaveLength(1);
  });

  it("lets Git HTTPS discovery trust the registered proxy certificate", async () => {
    expect(fs.statSync(caDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(caDir, "root-ca-key.pem")).mode & 0o777).toBe(0o600);
    const result = await promisify(execFile)(
      "git",
      ["ls-remote", `https://localhost:${originPort}/git`, "refs/heads/main"],
      {
        cwd: caDir,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: caDir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: gitNullConfigPath(),
          GIT_TERMINAL_PROMPT: "0",
          ...proxyEnv,
        },
        timeout: 10_000,
      },
    );
    expect(result.stdout).toBe(`${"a".repeat(40)}\trefs/heads/main\n`);
    expect(originRequests.some((request) => request.url.startsWith("/git/info/refs"))).toBe(true);
    expect(auditEvents).toContainEqual(expect.objectContaining({ kind: "forwarded" }));
  });

  it("keeps serving after a client resets a refused tunnel", async () => {
    const refused = await rawConnect({});
    expect(refused.response).toContain("407 Proxy Authentication Required");
    const closed = new Promise<void>((resolve) => {
      refused.socket.once("close", () => resolve());
    });
    refused.socket.resetAndDestroy();
    await closed;

    const stillAlive = await rawConnect({ auth: proxyAuth() });
    expect(stillAlive.response).toContain("200 Connection Established");
    stillAlive.socket.destroy();
  });

  it.each([
    [undefined, "missing-proxy-auth"],
    [egress.basicAuth("wrong-token"), "invalid-proxy-auth"],
  ] as const)("refuses %s credentials on CONNECT and forwarding (%s)", async (auth, reason) => {
    const connect = await rawConnect({ auth });
    expect(connect.response).toContain("407 Proxy Authentication Required");
    connect.socket.destroy();

    await expect(forwardedRequest(auth)).resolves.toBe(407);
    expect(originRequests).toEqual([]);
    expect(auditEvents).toEqual([
      expect.objectContaining({ kind: "refused", reason }),
      expect.objectContaining({ kind: "refused", reason }),
    ]);
  });

  it("keeps secret bindings narrower than the traffic allowlist", async () => {
    const restrictedEvents: SecretEgressProxyAuditEvent[] = [];
    const restrictedProxy = await egress.createProxy(caDir, restrictedEvents, {
      allowedHosts: ["localhost"],
    });
    proxies.push(restrictedProxy);
    const secret = "wrong-destination-secret";
    const sentinel = mintSecretSentinel(secret, { label: "egress-wrong-destination" });

    const result = await requestThroughTunnel(
      {
        caPath: restrictedProxy.caCertPath,
        headers: { Authorization: `Bearer ${sentinel}` },
        proxyEnv: registerSentinel(sentinel, ["api.example.com"], restrictedProxy),
      },
      502,
    );
    expect(result.body).toContain("--allow-host localhost");
    expect(originRequests).toEqual([]);
    expect(restrictedEvents.at(-1)).toMatchObject({
      kind: "refused",
      host: "localhost",
      reason: "destination-not-allowed",
    });
  });

  it("refuses an unresolved sentinel in a streamed body", async () => {
    const unknown = tamperSentinel(mintSecretSentinel("unknown-body", { label: "egress-body" }));
    await requestThroughTunnel({ path: "/refuse", bodyChunks: [unknown] }, 502);
    expect(originRequests).toEqual([]);
    expect(auditEvents.at(-1)).toMatchObject({ kind: "refused", reason: "unresolved-sentinel" });
  });

  it.each(["chunked", "fixed-length"] as const)(
    "substitutes a %s body larger than the maximum carry window",
    async (framing) => {
      const secret = "stream-boundary-🦞-secret";
      const sentinel = mintSecretSentinel(secret, { label: "egress-stream" });
      proxyEnv = registerSentinel(sentinel);
      const split = SECRET_SENTINEL_PREFIX.length + 3;
      const prefix = "x".repeat(SECRET_SENTINEL_MAX_LENGTH + 1024);
      const suffix = "y".repeat(2048);
      const fixed = framing === "fixed-length";

      await requestThroughTunnel({
        path: fixed ? "/fixed-length" : "/",
        headers: fixed ? { Expect: "100-continue", Trailer: "X-Checksum" } : undefined,
        contentLength: fixed ? Buffer.byteLength(prefix + sentinel + suffix) : undefined,
        bodyChunks: [prefix, sentinel.slice(0, split), sentinel.slice(split), suffix],
      });

      expect(originRequests.at(-1)).toMatchObject({
        body: `${prefix}${secret}${suffix}`,
        headers: {
          expect: undefined,
          trailer: undefined,
          "content-length": fixed ? String(Buffer.byteLength(prefix + secret + suffix)) : undefined,
          "transfer-encoding": framing === "chunked" ? "chunked" : undefined,
        },
      });
    },
  );

  it("revokes only the owning process and keeps audits payload-free", async () => {
    const secret = "audit-secret-value";
    const sentinel = mintSecretSentinel(secret, { label: "egress-audit" });
    const grant = proxy.registerProcess([egress.binding(sentinel)]);
    proxyEnv = grant.env;
    const sibling = proxy.registerProcess();
    await requestThroughTunnel({ headers: { "X-Secret": sentinel } });
    await expect(
      forwardedRequest(proxyAuth(), "http", proxy.proxyOrigin, "http://example.com/"),
    ).resolves.toBe(502);
    expect(auditEvents).toContainEqual(
      expect.objectContaining({ kind: "refused", reason: "non-https-request" }),
    );

    grant.revoke();
    const refused = await rawConnect({ auth: proxyAuth() });
    expect(refused.response).toContain("407 Proxy Authentication Required");
    refused.socket.destroy();
    await expect(forwardedRequest(proxyAuth())).resolves.toBe(407);
    await expect(forwardedRequest(proxyAuth(sibling.env))).resolves.toBe(200);

    const auditText = JSON.stringify(auditEvents);
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain(sentinel);
  });
});

describe("secret egress plain HTTP", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterAll);
  const servers: Server[] = [];
  const audit: SecretEgressProxyAuditEvent[] = [];
  const observed: Array<string | undefined> = [];
  let proxy: SecretEgressProxyHandle;
  let port: number;
  let ipv6Port: number;

  async function listen(host: string): Promise<number> {
    const server = createServer((incoming, response) => {
      incoming.resume();
      incoming.on("end", () => {
        observed.push(incoming.url);
        response.end("loopback-ok");
      });
    });
    servers.push(server);
    return egress.listen(server, host);
  }

  beforeAll(async () => {
    const caDir = tempDirs.make("openclaw-egress-http-");
    proxy = await egress.createProxy(caDir, audit);
    port = await listen("127.0.0.1");
    ipv6Port = await listen("::1");
  });

  beforeEach(() => {
    audit.length = 0;
    observed.length = 0;
  });

  afterAll(async () => {
    await proxy.stop();
    for (const server of servers) {
      server.closeAllConnections();
      await egress.closeServer(server);
    }
  });

  async function request(
    params: {
      target?: string;
      env?: Record<string, string>;
      chunks?: string[];
    } = {},
  ): Promise<{ status: number; body: string }> {
    const response = await egress.proxyRequest(params.env ?? proxy.registerProcess().env, {
      path: params.target ?? `http://localhost:${port}/ok`,
      method: params.chunks ? "POST" : "GET",
      chunks: params.chunks,
    });
    return egress.readResponse(response);
  }

  // Node's HTTP client honors NODE_USE_ENV_PROXY and uses absolute-form HTTP forwarding.
  // fetch's CONNECT transport exercises a different proxy entry point.
  const CHILD_REQUEST = `
  const http = require('node:http');
  const request = http.get(process.argv[1], response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => body += chunk);
    response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, body })));
  });
  request.on('error', error => { console.error(error.message); process.exitCode = 1; });
`;

  it.each([
    { host: "[::1]", allowed: true },
    { host: "localhost.example.com", allowed: false },
  ])("permits only literal loopback HTTP to $host", async ({ host, allowed: permitted }) => {
    expect(
      await request({ target: `http://${host}:${host === "[::1]" ? ipv6Port : port}/ok` }),
    ).toEqual(
      permitted
        ? { status: 200, body: "loopback-ok" }
        : { status: 502, body: "Secret egress proxy refused the request.\n" },
    );
    if (permitted) {
      expect(observed).toEqual(["/ok"]);
      expect(audit).toEqual([
        { kind: "forwarded", host: host === "[::1]" ? "::1" : host, substituted: false },
      ]);
    } else {
      expect(observed).toEqual([]);
      expect(audit).toEqual([
        expect.objectContaining({ kind: "refused", reason: "non-https-request" }),
      ]);
    }
  });

  it("refuses a loopback HTTP sentinel split across body chunks", async () => {
    const sentinel = mintSecretSentinel("synthetic-http-secret", { label: "http-refusal" });
    const grant = proxy.registerProcess([egress.binding(sentinel)]);
    try {
      expect(
        await request({
          env: grant.env,
          chunks: [sentinel.slice(0, 8), sentinel.slice(8)],
        }),
      ).toEqual({ status: 502, body: "Secret egress proxy refused the request.\n" });
      expect(observed).toEqual([]);
      expect(audit).toEqual([
        { kind: "refused", host: "localhost", substituted: false, reason: "non-https-request" },
      ]);
    } finally {
      grant.revoke();
    }
  });

  it("refuses a real HTTP child outside the lockdown allowlist", async () => {
    const lockdown = await egress.createProxy(
      tempDirs.make("openclaw-egress-http-lockdown-"),
      audit,
      { allowedHosts: [] },
    );
    const grant = lockdown.registerProcess();
    try {
      const result = await promisify(execFile)(
        process.execPath,
        ["-e", CHILD_REQUEST, `http://127.0.0.1:${port}/ok`],
        { env: { SystemRoot: process.env.SystemRoot, ...grant.env } },
      );
      const response = JSON.parse(result.stdout);
      const refusal =
        'Host "127.0.0.1" is not in the secret egress proxy traffic allowlist. Add it to secrets.egressProxy.allowedHosts or bind a store secret to it with: openclaw secrets store set <NAME> --allow-host 127.0.0.1, then restart the Gateway.\n';
      expect(response).toMatchObject({ status: 403, body: refusal });
      expect(observed).toEqual([]);
      expect(audit).toEqual([
        { kind: "refused", host: "127.0.0.1", substituted: false, reason: "host-not-allowed" },
      ]);
    } finally {
      grant.revoke();
      await lockdown.stop();
    }
  });
});
