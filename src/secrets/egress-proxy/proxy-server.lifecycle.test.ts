import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import { createServer as createHttpsServer, type Server } from "node:https";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as proxyCa from "../../proxy-capture/ca.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { mintSecretSentinel } from "../sentinel.js";
import type {
  SecretEgressProcessGrant,
  SecretEgressProxyAuditEvent,
  SecretEgressProxyHandle,
} from "./proxy-server.js";
import * as egress from "./proxy.test-support.js";

vi.mock("node:https", { spy: true });
vi.mock("node:http", { spy: true });

const value = "synthetic-lifecycle-credential";
const authorization = `Bearer ${value}`;
const seed = egress.useCaSeed("openclaw-egress-lifecycle-");
let caDir: string;
let proxy: SecretEgressProxyHandle;
let origin: Server;
let originPort: number;
let sentinel: string;
let grant: SecretEgressProcessGrant;
let observed: Array<{ authorization: string | undefined; body: string }>;
let auditEvents: SecretEgressProxyAuditEvent[];
let incoming: Map<string, IncomingMessage>;
let responses: Map<string, ServerResponse>;
let bodyReceived: Set<string>;
const sockets = egress.socketTracker();
const trackSocket = sockets.track;

function connectTunnel(env = grant.env): Promise<{ status: number; socket?: Socket }> {
  return egress.connectTunnel(env, originPort, trackSocket).catch(() => ({ status: 0 }));
}

async function openTlsTunnel(env = grant.env): Promise<tls.TLSSocket> {
  const socket = await egress.connectTls(await connectTunnel(env), proxy.caCertPath, trackSocket);
  socket.resume();
  return socket;
}

async function sendCredential(socket: tls.TLSSocket, body?: string): Promise<void> {
  const closed = egress.onClose(socket);
  socket.write(
    `${body === undefined ? "GET" : "POST"} / HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: close\r\nAuthorization: Bearer ${sentinel}\r\n${body === undefined ? "" : `Content-Length: ${Buffer.byteLength(body)}\r\n`}\r\n${body ?? ""}`,
  );
  await closed;
}

function writeUpload(socket: Socket, proof?: string, length = 104857600, body = "x", extra = "") {
  socket.write(
    `POST / HTTP/1.1\r\nHost: localhost:${originPort}\r\n${proof ? `X-Upload-Proof: ${proof}\r\n` : ""}${extra}Content-Length: ${length}\r\n\r\n${body}`,
  );
}

async function holdUpload(proof: string, env = grant.env, body = "x", extra = "") {
  const socket = await openTlsTunnel(env);
  writeUpload(socket, proof, 104857600, body, extra);
  await vi.waitFor(() => expect(bodyReceived.has(proof)).toBe(true));
  expect(responses.get(proof)?.headersSent).toBe(false);
  return socket;
}

function register(isActive?: () => boolean): SecretEgressProcessGrant {
  return proxy.registerProcess([egress.binding(sentinel)], isActive);
}

function retire(action: "stop" | "new process") {
  if (action === "stop") {
    return proxy.stop();
  }
  grant.revoke();
  grant = register();
}

afterAll(seed.cleanup);

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_SECRET_SENTINELS", undefined);
  observed = [];
  auditEvents = [];
  incoming = new Map();
  responses = new Map();
  bodyReceived = new Set();
  const { createServer } = await vi.importActual<typeof http>("node:http");
  vi.spyOn(http, "createServer").mockImplementation((options, listener) =>
    createServer(options, listener).on("request", (request, response) => {
      const proof = request.headers["x-upload-proof"];
      if (typeof proof === "string" && !incoming.has(proof)) {
        incoming.set(proof, request);
        responses.set(proof, response);
        request.once("data", () => bodyReceived.add(proof));
      }
    }),
  );
  caDir = seed.make();
  proxy = await egress.createProxy(caDir, auditEvents);
  origin = createHttpsServer(seed.leaf, (request, response) => {
    const record = { authorization: request.headers.authorization, body: "" };
    observed.push(record);
    request.on("error", () => {});
    request.on("data", (chunk: Buffer) => {
      record.body += chunk.toString();
    });
    request.once("end", () => {
      response.writeHead(200, { Connection: "close", "Content-Length": 2 });
      response.end("ok");
    });
  });
  origin.on("connection", trackSocket);
  originPort = await egress.listen(origin);
  sentinel = mintSecretSentinel(value, { label: "egress-lifecycle" });
  grant = register();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  sockets.destroy();
  await proxy?.stop();
  if (origin) {
    await egress.closeServer(origin);
  }
  fs.rmSync(caDir, { recursive: true, force: true });
});

it.each(["keep-alive", "close"])(
  "fences queued credentials before socket assignment (%s)",
  async (connection) => {
    const authority = new Int32Array(new SharedArrayBuffer(4));
    grant = register(() => Atomics.load(authority, 0) === 0);
    const queued = createDeferredCore<{ request: http.ClientRequest; agent: https.Agent }>();
    const { request: requestUpstream } = await vi.importActual<typeof https>("node:https");
    vi.mocked(https.request).mockImplementation((...args) => {
      const agent = (args[0] as https.RequestOptions).agent;
      if (!(agent instanceof https.Agent)) {
        throw new Error("Expected the grant's HTTPS agent");
      }
      agent.maxSockets = 1;
      agent.maxTotalSockets = 1;
      const request = requestUpstream(...args);
      if (request.path === "/queued") {
        queued.resolve({ request, agent });
      }
      return request;
    });
    const held = createDeferredCore<ServerResponse>();
    const paths: string[] = [];
    origin.removeAllListeners("request");
    origin.on("request", (request, response) => {
      paths.push(request.url!);
      expect(request.headers.authorization).toBe(authorization);
      request.resume();
      request.once("end", () =>
        request.url === "/held" ? held.resolve(response) : response.end("ok"),
      );
    });
    const first = await openTlsTunnel();
    first.write(
      `GET /held HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: ${connection}\r\nAuthorization: Bearer ${sentinel}\r\nContent-Length: 0\r\n\r\n`,
    );
    const heldResponse = await held.promise;
    const second = await openTlsTunnel();
    second.write(
      `GET /queued HTTP/1.1\r\nHost: localhost:${originPort}\r\nAuthorization: Bearer ${sentinel}\r\nContent-Length: 0\r\n\r\n`,
    );
    const { request: pending, agent } = await queued.promise;
    expect(pending).toMatchObject({ socket: null, writableEnded: true });
    const pendingClosed = egress.onClose(pending);
    const secondClosed = egress.onClose(second);
    expect(Object.values(agent.requests).flat()).toContain(pending);
    // Shared revocation precedes socket assignment and the Worker cleanup message.
    agent.prependOnceListener("free", () => Atomics.store(authority, 0, 1));
    heldResponse.end("ok");
    await pendingClosed;
    expect(paths).toEqual(["/held"]);
    await secondClosed;
    await sendCredential(await openTlsTunnel(register().env));
    expect(paths).toEqual(["/held", "/"]);
  },
);

it("pools TLS per live grant and releases idle peers on revocation", async () => {
  const peers: Socket[] = [];
  origin.removeAllListeners("request");
  origin.on("request", (request, response) => {
    peers.push(request.socket);
    expect(request.headers).toMatchObject({ authorization, "proxy-authorization": undefined });
    request.resume();
    response.writeHead(200, { "Content-Length": 2 });
    response.end("ok");
  });
  const send = async (processGrant: SecretEgressProcessGrant, connection = "keep-alive") => {
    const response = await egress.proxyRequest(processGrant.env, {
      path: `https://localhost:${originPort}/`,
      headers: { Connection: connection, Authorization: `Bearer ${sentinel}` },
    });
    expect(await egress.readResponse(response)).toEqual({ status: 200, body: "ok" });
  };
  const connect = vi.spyOn(tls, "connect");
  const sibling = register();
  await send(grant);
  await send(grant);
  await send(sibling);
  expect(peers[1]).toBe(peers[0]);
  expect(peers[2]).not.toBe(peers[0]);
  const revokedPeerClosed = egress.onClose(peers[0]!);
  grant.revoke();
  await revokedPeerClosed;
  await send(sibling);
  expect(peers[3]).toBe(peers[2]);
  const siblingPeerClosed = egress.onClose(peers[2]!);
  await send(sibling, "close");
  await siblingPeerClosed;
  await send(sibling);
  expect(peers[5]).not.toBe(peers[2]);
  const tlsOptions = connect.mock.calls.map(([options]) => options as tls.ConnectionOptions);
  expect(tlsOptions).toHaveLength(3);
  const secureContext = tlsOptions[0]?.secureContext;
  expect(secureContext).toBeDefined();
  for (const option of tlsOptions) {
    expect(option.secureContext).toBe(secureContext);
    expect(option).toMatchObject({ ca: undefined, key: undefined, cert: undefined });
  }
  for (const [options] of vi.mocked(https.request).mock.calls) {
    const agent = (options as https.RequestOptions).agent;
    expect(agent).toBeInstanceOf(https.Agent);
    if (agent instanceof https.Agent) {
      expect(JSON.stringify(agent.options)).not.toContain(value);
      expect(agent.options).not.toHaveProperty("headers");
    }
  }
  const stoppedPeerClosed = egress.onClose(peers[5]!);
  await proxy.stop();
  await stoppedPeerClosed;
});

it("snapshots in-flight URL credential bindings", async () => {
  const allowedHosts = ["localhost"];
  const bindings = [egress.binding(sentinel, allowedHosts)];
  grant = proxy.registerProcess(bindings);
  const socket = await openTlsTunnel();
  const received = egress.capture(socket);
  socket.write(
    `POST /?token=${sentinel} HTTP/1.1\r\nHost: localhost:${originPort}\r\nConnection: close\r\nX-Upload-Proof: snapshot\r\nContent-Length: 7\r\n\r\nprefix`,
  );
  await vi.waitFor(() => expect(bodyReceived.has("snapshot")).toBe(true));
  allowedHosts.length = 0;
  bindings.length = 0;
  const sibling = proxy.registerProcess();
  socket.write("!");
  await received.closed;
  expect(observed).toEqual([{ authorization: undefined, body: "prefix!" }]);
  expect(received.text()).toContain("200");
  await sendCredential(await openTlsTunnel(sibling.env));
  expect(observed).toHaveLength(1);
  expect(auditEvents.at(-1)).toMatchObject({ kind: "refused", reason: "unresolved-sentinel" });
});

it("bounds aggregate reservations but admits small uploads", async () => {
  const held = await holdUpload("large");
  const rejected = await openTlsTunnel(register().env);
  const received = egress.capture(rejected);
  writeUpload(rejected, undefined, 41943040);
  await received.until("503");
  expect(received.text()).toContain("503");
  const small = await Promise.all(Array.from({ length: 8 }, () => openTlsTunnel()));
  await Promise.all(small.map((socket) => sendCredential(socket, "ok")));
  expect(observed).toHaveLength(8);
  const closed = egress.onClose(held);
  held.destroy();
  await closed;
});

it("expires incomplete CONNECT uploads without a listening TLS server", async () => {
  const socket = await openTlsTunnel();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const closed = egress.onClose(socket);
  writeUpload(socket, "deadline");
  await vi.waitFor(() => expect(bodyReceived.has("deadline")).toBe(true));
  await vi.advanceTimersByTimeAsync(300_000);
  vi.useRealTimers();
  await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  await closed;
  expect(observed).toEqual([]);
  expect(auditEvents.some((event) => event.kind === "forwarded")).toBe(false);
  await sendCredential(await openTlsTunnel());
  expect(observed).toHaveLength(1);
});

it("keeps lockdown traffic policy local to each process", async () => {
  await proxy.stop();
  proxy = await egress.createProxy(caDir, auditEvents, { allowedHosts: [] });
  grant = register();
  const socket = await openTlsTunnel();
  const received = egress.capture(socket);
  writeUpload(socket, "policy", 2, "a", "Connection: close\r\n");
  await vi.waitFor(() => expect(bodyReceived.has("policy")).toBe(true));
  const sibling = proxy.registerProcess();
  socket.write("b");
  await received.closed;
  expect(received.text()).toContain("200");
  expect(observed).toHaveLength(1);
  const siblingConnection = await connectTunnel(sibling.env);
  expect(siblingConnection.status).toBe(403);
  siblingConnection.socket?.destroy();
});

it("bounds tiny-request count and releases aborted reservations", async () => {
  const held = await Promise.all(Array.from({ length: 65 }, () => openTlsTunnel()));
  for (const [index, socket] of held.entries()) {
    writeUpload(socket, `count-${index}`, 2);
  }
  await vi.waitFor(() => expect(bodyReceived.size).toBe(65));
  expect([...responses.values()].filter((response) => response.statusCode === 503)).toHaveLength(1);
  expect([...responses.values()].filter((response) => !response.headersSent)).toHaveLength(64);
  const closed = held.filter((socket) => !socket.destroyed).map(egress.onClose);
  for (const socket of held) {
    socket.destroy();
  }
  await Promise.all(closed);
  await vi.waitFor(() =>
    expect([...incoming.values()].every((request) => request.destroyed)).toBe(true),
  );
  await holdUpload("count-reused");
});

it("audits actual send and expires stalled upstream TLS", async () => {
  const peers = new Set<Socket>();
  const stalled = net.createServer((socket) => {
    trackSocket(socket);
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
  });
  const previousPort = originPort;
  originPort = await egress.listen(stalled);
  try {
    const socket = await openTlsTunnel();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connected = once(stalled, "connection");
    const received = egress.capture(socket);
    writeUpload(socket, undefined, 5, "hello", "Connection: close\r\n");
    const [peer] = await connected;
    expect(auditEvents).toEqual([]);
    await vi.advanceTimersByTimeAsync(300_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(received.text()).toContain("504");
    expect(auditEvents).toEqual([
      { kind: "refused", host: "localhost", substituted: false, reason: "request-timeout" },
    ]);
    peer.destroy();
  } finally {
    vi.useRealTimers();
    originPort = previousPort;
    for (const peer of peers) {
      peer.destroy();
    }
    await egress.closeServer(stalled);
  }
  await sendCredential(await openTlsTunnel());
  expect(observed).toHaveLength(1);
});

it("preserves bytes at the 100 MiB cap under backpressure", async () => {
  origin.removeAllListeners("request");
  const expectedHash = createHash("sha256");
  const arrived = createDeferredCore<{
    bytes: number;
    hash: string;
    headers: http.IncomingHttpHeaders;
  }>();
  origin.on("request", (request, response) => {
    const hash = createHash("sha256");
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    request.once("end", () => {
      arrived.resolve({ bytes, hash: hash.digest("hex"), headers: request.headers });
      response.writeHead(200, { Connection: "close", "Content-Length": 2 });
      response.end("ok");
    });
  });
  const socket = await openTlsTunnel();
  const received = egress.capture(socket);
  writeUpload(socket, undefined, 104857600, "", "Connection: close\r\n");
  const chunk = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => index % 256));
  for (let i = 0; i < 1600; i++) {
    expectedHash.update(chunk);
    if (!socket.write(chunk)) {
      await once(socket, "drain");
    }
  }
  await received.closed;
  expect(received.text()).toMatch(/^HTTP\/1\.1 200 /);
  expect(await arrived.promise).toMatchObject({
    bytes: 104857600,
    hash: expectedHash.digest("hex"),
    headers: { "content-length": "104857600", "transfer-encoding": undefined },
  });
  await holdUpload("cap-reused");
});

it("keeps the process CA trusted beyond the first day", () => {
  const cert = new X509Certificate(fs.readFileSync(proxy.caCertPath));
  const afterOneDay = Math.floor(cert.validFromDate.getTime() / 1000) + 25 * 60 * 60;
  expect(() =>
    execFileSync(
      "openssl",
      ["verify", "-CAfile", proxy.caCertPath, "-attime", String(afterOneDay), proxy.caCertPath],
      { stdio: "pipe" },
    ),
  ).not.toThrow();
});

it("renews leaves without replacing trust or established connections", async () => {
  const issued: X509Certificate[] = [];
  const issueLeaf = proxyCa.generateLocalProxyLeaf;
  vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockImplementation(async (params) => {
    const leaf = await issueLeaf(params);
    issued.push(new X509Certificate(leaf.cert));
    return leaf;
  });
  const existing = await openTlsTunnel();
  const previous = issued[0]!;
  const trustedCa = fs.readFileSync(proxy.caCertPath);
  // Advance only the cache clock; OpenSSL still verifies against the native clock.
  vi.spyOn(Date, "now").mockReturnValue(previous.validToDate.getTime() - 30 * 60_000);
  const renewed = await Promise.all([openTlsTunnel(), openTlsTunnel(register().env)]);
  for (const socket of renewed) {
    await sendCredential(socket);
  }
  expect(fs.readFileSync(proxy.caCertPath)).toEqual(trustedCa);
  await sendCredential(existing);
  expect(observed).toHaveLength(3);
  expect(issued.length).toBe(2);
  expect(issued[1]!.fingerprint256).not.toBe(previous.fingerprint256);
  expect(issued[1]!.checkIssued(new X509Certificate(trustedCa))).toBe(true);
});
it("recovers failed certificate renewal on the next request", async () => {
  const existing = await openTlsTunnel();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 23.5 * 60 * 60_000);
  vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockRejectedValueOnce(
    new Error("synthetic-private-openssl-output"),
  );
  expect((await connectTunnel()).status).toBe(502);
  const failed = proxy.getCertificateStatus();
  expect(failed).toMatchObject({ state: "degraded", failedCertificates: 1 });
  expect(failed.message).toContain("retry the request");
  expect(JSON.stringify(failed)).not.toContain("synthetic-private-openssl-output");
  await sendCredential(existing);
  await sendCredential(await openTlsTunnel());
  expect(proxy.getCertificateStatus()).toMatchObject({ state: "ready", failedCertificates: 0 });
  expect(observed.length).toBe(2);
});

it("reports root expiry without minting leaves or replacing trust", async () => {
  const trust = fs.readFileSync(grant.env.NODE_EXTRA_CA_CERTS!);
  const validity = new X509Certificate(fs.readFileSync(proxy.caCertPath));
  const clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(validity.validToDate.getTime() - 60_000);
  expect(proxy.getCertificateStatus().message).toContain("expires within seven days");
  clock.mockReturnValue(validity.validToDate.getTime());
  const generateLeaf = vi.spyOn(proxyCa, "generateLocalProxyLeaf");
  expect((await connectTunnel()).status).toBe(502);
  expect(proxy.getCertificateStatus().message).toContain("restart the Gateway");
  expect(generateLeaf).not.toHaveBeenCalled();
  expect(fs.readFileSync(grant.env.NODE_EXTRA_CA_CERTS!)).toEqual(trust);
  clock.mockRestore();
  await sendCredential(await openTlsTunnel());
  expect(proxy.getCertificateStatus().state).toBe("ready");
});

it.each(["new process", "stop"] as const)(
  "%s closes established TLS before its first credential request",
  async (action) => {
    const oldConnection = await openTlsTunnel();
    const siblingEnv = register().env;
    const siblingConnection = await openTlsTunnel(siblingEnv);
    const stopped = retire(action);
    await sendCredential(oldConnection);
    expect(observed).toEqual([]);
    if (stopped) {
      await stopped;
      expect(() => register()).toThrow();
      return;
    }
    await sendCredential(siblingConnection);
    expect(observed).toEqual([{ authorization, body: "" }]);
    await sendCredential(await openTlsTunnel());
    expect(observed).toHaveLength(2);
  },
);

it("streams oversized lengths and revokes between chunks", async () => {
  const socket = await openTlsTunnel();
  const firstChunk = createDeferredCore<IncomingMessage>();
  origin.once("request", (request) => request.once("data", () => firstChunk.resolve(request)));
  writeUpload(socket, undefined, Number.MAX_SAFE_INTEGER, "", "Connection: close\r\n");
  const prefix = "safe-prefix".repeat(100);
  const split = Math.floor(sentinel.length / 2);
  socket.write(prefix + sentinel.slice(0, split));
  // Arrival before the rest proves this path streams instead of buffering.
  const upload = await firstChunk.promise;
  expect(upload.headers).toMatchObject({
    "content-length": undefined,
    "transfer-encoding": "chunked",
  });
  const upstreamClosed = egress.onClose(upload);
  const clientClosed = egress.onClose(socket);
  grant.revoke();
  socket.write(sentinel.slice(split));
  await Promise.all([upstreamClosed, clientClosed]);
  expect(observed).toEqual([{ authorization: undefined, body: prefix }]);
  await sendCredential(await openTlsTunnel(register().env));
  expect(observed.at(-1)?.authorization).toBe(authorization);
});

it.each(["new process", "stop", "disconnect", "short body"] as const)(
  "%s discards incomplete fixed-length uploads and releases reservations",
  async (action) => {
    const upstream = vi.spyOn(https, "request").mockClear();
    const prefix = "safe-prefix".repeat(100) + sentinel.slice(0, Math.floor(sentinel.length / 2));
    const socket = await holdUpload("cleanup", grant.env, prefix, "Connection: close\r\n");
    const clientClosed = egress.onClose(socket);
    expect(upstream).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([]);
    // Client close can precede the proxy response closing and releasing its reservation.
    const serverClosed = egress.onClose(responses.get("cleanup")!);
    let stopped: Promise<void> | undefined;
    if (action === "disconnect") {
      socket.destroy();
    } else if (action === "short body") {
      socket.end();
    } else {
      stopped = retire(action);
    }
    await Promise.all([clientClosed, serverClosed, stopped]);
    expect(observed).toEqual([]);
    if (action !== "stop") {
      const next = await holdUpload("reused", register().env);
      next.destroy();
      await sendCredential(await openTlsTunnel(register().env));
      expect(observed).toHaveLength(1);
    }
  },
);

it.each(["stop", "new process"] as const)(
  "%s fences CONNECT while certificate renewal is pending",
  async (action) => {
    await sendCredential(await openTlsTunnel());
    observed = [];
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 23.5 * 60 * 60_000);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const settled = createDeferredCore();
    let leafPrepared = false;
    const generateLeaf = proxyCa.generateLocalProxyLeaf;
    vi.spyOn(proxyCa, "generateLocalProxyLeaf").mockImplementationOnce(async (params) => {
      entered.resolve();
      try {
        await release.promise;
        const leaf = await generateLeaf(params);
        leafPrepared = true;
        return leaf;
      } finally {
        settled.resolve();
      }
    });
    const connecting = connectTunnel();
    try {
      await entered.promise;
      const stopping = retire(action);
      release.resolve();
      expect((await connecting).status).not.toBe(200);
      await stopping;
      if (stopping) {
        expect(leafPrepared).toBe(true);
      }
      expect(observed).toEqual([]);
      if (action !== "stop") {
        await sendCredential(await openTlsTunnel(register().env));
        expect(observed.at(-1)?.authorization).toBe(authorization);
      }
    } finally {
      release.resolve();
      await connecting;
      await settled.promise;
    }
  },
);

it("releases both ends of a bypass CONNECT on revocation", async () => {
  await proxy.stop();
  proxy = await egress.createProxy(caDir, [], { bypassHosts: ["localhost"] });
  grant = register();
  const connected = once(origin, "secureConnection");
  const socket = await openTlsTunnel();
  const [upstreamSocket] = await connected;
  const upstreamClosed = egress.onClose(upstreamSocket);
  grant.revoke();
  await sendCredential(socket);
  await upstreamClosed;
  expect(observed).toEqual([]);
  await sendCredential(await openTlsTunnel(register().env));
  expect(observed.at(-1)?.authorization).toBe(`Bearer ${sentinel}`);
});
