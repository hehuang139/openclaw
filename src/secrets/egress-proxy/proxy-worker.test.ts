import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { reserveTestPortListener, type TestPortClaim } from "../../test-utils/port-claims.js";
import { sealSecretSentinel } from "../sentinel.js";
import type { SecretEgressProcessGrant, SecretEgressProxyAuditEvent } from "./proxy-server.js";
import {
  startSecretEgressProxyWorker,
  type SecretEgressProxyWorkerHandle,
} from "./proxy-worker.js";
import { copyCa, proxyRequest, readResponse, socketTracker } from "./proxy.test-support.js";

const secret = "synthetic-worker-egress-credential";
const sentinel = sealSecretSentinel(secret, { label: "WORKER_API_KEY" });
const bindings = [{ name: "WORKER_API_KEY", sentinel, allowedHosts: ["localhost"] }];
const proxies: SecretEgressProxyWorkerHandle[] = [];
const grants = new Set<SecretEgressProcessGrant>();
const sockets = socketTracker();
const auditEvents: SecretEgressProxyAuditEvent[] = [];
const observed: Array<{ authorization: string | undefined; body: string }> = [];
const failure = vi.fn();
let seedDir: string;
let origin: Server;
let originPort: number;
let originClaim: TestPortClaim;
let closeOrigin: (() => Promise<void>) | undefined;
let proxy: SecretEgressProxyWorkerHandle;
let nativeWorker: Worker;
let streamingResponse: ServerResponse | undefined;
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    sockets.destroy();
    await Promise.all(proxies.map((owned) => owned.stop()));
    expect(nativeWorker.threadId).toBe(-1);
    expect(failure).not.toHaveBeenCalled();
    await expect(proxy.registerProcess(bindings)).rejects.toThrow("stopped");
    origin?.closeAllConnections();
    await closeOrigin?.();
    await originClaim?.release();
    cleanup();
  }),
);

async function startWorker(onFailure = failure) {
  const caDir = dirs.make("openclaw-egress-worker-");
  copyCa(seedDir, caDir);
  const created = createDeferredCore<Worker>();
  const onWorker = (worker: Worker) => created.resolve(worker);
  process.once("worker", onWorker);
  try {
    const handle = await startSecretEgressProxyWorker({
      caDir,
      allowedHosts: ["localhost"],
      onAudit: (event) => auditEvents.push(event),
      onFailure,
    });
    proxies.push(handle);
    return { handle, worker: await created.promise };
  } finally {
    process.off("worker", onWorker);
  }
}

async function register(owner = proxy, withBinding = true) {
  const grant = await owner.registerProcess(withBinding ? bindings : []);
  grants.add(grant);
  return grant;
}

function openRequest(
  grant: SecretEgressProcessGrant,
  options: {
    path?: string;
    host?: string;
    body?: string;
    authorization?: string;
  } = {},
): Promise<IncomingMessage> {
  const body = options.body ?? "";
  return proxyRequest(
    grant.env,
    {
      method: body ? "POST" : "GET",
      path: `https://${options.host ?? "localhost"}:${originPort}${options.path ?? "/"}`,
      headers: {
        Authorization: options.authorization ?? `Bearer ${sentinel}`,
        "Content-Length": Buffer.byteLength(body),
      },
      chunks: [body],
    },
    sockets.track,
  );
}

async function request(
  grant: SecretEgressProcessGrant,
  options?: Parameters<typeof openRequest>[1],
) {
  return readResponse(await openRequest(grant, options));
}

function readSse(response: IncomingMessage) {
  const first = createDeferredCore();
  let received = "";
  response.on("data", (chunk: Buffer) => {
    received += chunk.toString();
    if (received.includes("data: first\n\n")) {
      first.resolve();
    }
  });
  return { first: first.promise, text: () => received };
}

beforeAll(async () => {
  seedDir = dirs.make("openclaw-egress-worker-seed-");
  const ca = await ensureSecretEgressProxyCa(seedDir);
  const leaf = await generateLocalProxyLeaf({ certDir: seedDir, ca, hostname: "localhost" });
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createHttpsServer(leaf, (incoming, response) => {
        const record = { authorization: incoming.headers.authorization, body: "" };
        observed.push(record);
        incoming.on("data", (chunk: Buffer) => {
          record.body += chunk.toString();
        });
        incoming.once("end", () => {
          if (incoming.url === "/sse") {
            streamingResponse = response;
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.write("data: first\n\n");
          } else {
            response.writeHead(200, { "Content-Length": 2 });
            response.end("ok");
          }
        });
      }),
  });
  origin = reservation.listener;
  origin.on("connection", sockets.track);
  originClaim = reservation.claim;
  originPort = reservation.claim.port;
  closeOrigin = reservation.releaseListener;
  const started = await startWorker();
  proxy = started.handle;
  nativeWorker = started.worker;
});

beforeEach(() => {
  auditEvents.length = 0;
  observed.length = 0;
  streamingResponse = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  streamingResponse?.destroy();
  for (const grant of grants) {
    grant.revoke();
  }
  grants.clear();
  // The health reply is ordered after grant cleanup on the same control port.
  await proxy.getCertificateStatus();
});

describe("secret egress Worker boundary", () => {
  it("keeps a multi-secret job's Basic credentials scoped to its registered grant", async () => {
    const password = sealSecretSentinel("synthetic-worker-password", { label: "WORKER_PASSWORD" });
    const unrelated = sealSecretSentinel("synthetic-unrelated-worker-secret", {
      label: "UNRELATED_SECRET",
    });
    const grant = await proxy.registerProcess([
      ...bindings,
      { name: "WORKER_PASSWORD", sentinel: password, allowedHosts: ["localhost"] },
    ]);
    grants.add(grant);
    const authorization = `Basic ${Buffer.from(`${sentinel}:${password}`).toString("base64")}`;
    expect((await request(grant, { authorization })).status).toBe(200);
    expect(observed).toEqual([
      {
        authorization: `Basic ${Buffer.from(`${secret}:synthetic-worker-password`).toString("base64")}`,
        body: "",
      },
    ]);
    expect(
      (
        await request(grant, {
          authorization: `Basic ${Buffer.from(`user:${unrelated}`).toString("base64")}`,
        })
      ).status,
    ).toBe(502);
    grant.revoke();
    expect((await request(grant, { authorization })).status).toBe(407);
    expect(observed).toHaveLength(1);
  });
  it("acknowledges usable grants while keeping bindings, host policy, and audit data scoped", async () => {
    const grant = await register();
    expect(await request(grant, { body: `${sentinel}:body` })).toEqual({
      status: 200,
      body: "ok",
    });
    expect(observed).toEqual([{ authorization: `Bearer ${secret}`, body: `${secret}:body` }]);
    const unbound = await register(proxy, false);
    expect((await request(unbound)).status).toBe(502);
    expect((await request(grant, { host: "127.0.0.1" })).status).toBe(403);
    expect(observed).toHaveLength(1);
    expect(await proxy.getCertificateStatus()).toMatchObject({
      state: "ready",
      failedCertificates: 0,
    });
    expect(auditEvents).toEqual([
      { kind: "forwarded", host: "localhost", substituted: true },
      { kind: "refused", host: "localhost", substituted: false, reason: "unresolved-sentinel" },
      { kind: "refused", host: "127.0.0.1", substituted: false, reason: "host-not-allowed" },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain(secret);
    expect(JSON.stringify(auditEvents)).not.toContain(sentinel);
  });

  it("revokes authority before its cleanup message arrives without revoking a sibling", async () => {
    const [revoked, sibling] = await Promise.all([register(), register()]);
    const response = await openRequest(revoked, { path: "/sse" });
    const sse = readSse(response);
    const closed = new Promise<void>((resolve) => {
      response.once("close", resolve);
    });
    response.on("error", () => {});
    await sse.first;
    const send = nativeWorker.postMessage.bind(nativeWorker);
    const held = vi.spyOn(nativeWorker, "postMessage").mockImplementation(() => {});
    revoked.revoke();
    const messages = held.mock.calls.slice();
    held.mockRestore();
    try {
      streamingResponse!.end("data: after revoke\n\n");
      await closed;
      expect(sse.text()).toBe("data: first\n\n");
      expect(response.complete).toBe(false);
      expect((await request(revoked)).status).toBe(407);
      expect(await request(sibling)).toEqual({ status: 200, body: "ok" });
      expect(observed).toEqual([
        { authorization: `Bearer ${secret}`, body: "" },
        { authorization: `Bearer ${secret}`, body: "" },
      ]);
    } finally {
      for (const args of messages) {
        send(...args);
      }
    }
  });

  it("delivers SSE data before the upstream completes its response", async () => {
    const response = await openRequest(await register(), { path: "/sse" });
    const sse = readSse(response);
    const ended = once(response, "end");
    await sse.first;
    expect(response.readableEnded).toBe(false);
    expect(streamingResponse?.writableEnded).toBe(false);
    streamingResponse!.end("data: final\n\n");
    await ended;
    expect(sse.text()).toBe("data: first\n\ndata: final\n\n");
  });

  it("fails closed on native Worker exit and settles pending control and network work", async () => {
    const failed = vi.fn();
    const isolated = await startWorker(failed);
    const response = await openRequest(await register(isolated.handle), {
      path: "/sse",
    });
    const closed = new Promise<void>((resolve) => {
      response.once("close", resolve);
    });
    response.on("error", () => {});
    response.resume();
    const holdStatus = vi.spyOn(isolated.worker, "postMessage").mockImplementationOnce(() => {});
    const pending = expect(isolated.handle.getCertificateStatus()).rejects.toThrow("unavailable");
    holdStatus.mockRestore();
    await isolated.worker.terminate();
    await Promise.all([pending, closed]);
    expect(failed).toHaveBeenCalledTimes(1);
    await expect(isolated.handle.registerProcess(bindings)).rejects.toThrow("unavailable");
    await isolated.handle.stop();
    expect(isolated.worker.threadId).toBe(-1);
  });
});
