import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { reserveTestPortListener, type TestPortClaim } from "../../test-utils/port-claims.js";
import { sealSecretSentinel } from "../sentinel.js";
import type { SecretEgressProcessGrant, SecretEgressProxyAuditEvent } from "./proxy-server.js";
import {
  startSecretEgressProxyWorker,
  type SecretEgressProxyWorkerHandle,
} from "./proxy-worker.js";
import * as egress from "./proxy.test-support.js";

const secret = "synthetic-worker-key";
const sentinel = sealSecretSentinel(secret, { label: "WORKER_API_KEY" });
const bindings = [egress.binding(sentinel, ["localhost"], "WORKER_API_KEY")];
const seed = egress.useCaSeed("openclaw-egress-worker-");
const proxies: SecretEgressProxyWorkerHandle[] = [];
const grants = new Set<SecretEgressProcessGrant>();
const sockets = egress.socketTracker();
const auditEvents: SecretEgressProxyAuditEvent[] = [];
const observed: Array<{ authorization: string | undefined; body: string }> = [];
const authorized = { authorization: `Bearer ${secret}`, body: "" };
const failure = vi.fn();
let origin: Server;
let originPort: number;
let originClaim: TestPortClaim;
let closeOrigin: (() => Promise<void>) | undefined;
let proxy: SecretEgressProxyWorkerHandle;
let nativeWorker: Worker;
let streamingResponse: ServerResponse | undefined;
afterAll(async () => {
  sockets.destroy();
  await Promise.all(proxies.map((owned) => owned.stop()));
  expect(nativeWorker.threadId).toBe(-1);
  expect(failure).not.toHaveBeenCalled();
  await expect(proxy.registerProcess(bindings)).rejects.toThrow("stopped");
  origin?.closeAllConnections();
  await closeOrigin?.();
  await originClaim?.release();
  seed.cleanup();
});

async function startWorker(onFailure = failure) {
  const created = createDeferredCore<Worker>();
  const onWorker = (worker: Worker) => created.resolve(worker);
  process.once("worker", onWorker);
  try {
    const handle = await startSecretEgressProxyWorker({
      caDir: seed.make(),
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

async function register(owner = proxy, scopedBindings = bindings) {
  const grant = await owner.registerProcess(scopedBindings);
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
  return egress.proxyRequest(
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

type RequestOptions = Parameters<typeof openRequest>[1];
async function request(grant: SecretEgressProcessGrant, options?: RequestOptions, status = 200) {
  const result = await egress.readResponse(await openRequest(grant, options));
  expect(result.status).toBe(status);
  return result;
}

beforeAll(async () => {
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createHttpsServer(seed.leaf, (incoming, response) => {
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
  ({ handle: proxy, worker: nativeWorker } = await startWorker());
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

it("scopes multi-secret Basic credentials to their grant", async () => {
  const password = sealSecretSentinel("password", { label: "WORKER_PASSWORD" });
  const unrelated = sealSecretSentinel("synthetic-unrelated", { label: "UNRELATED" });
  const grant = await register(proxy, [
    ...bindings,
    egress.binding(password, ["localhost"], "WORKER_PASSWORD"),
  ]);
  const authorization = egress.basic(`${sentinel}:${password}`);
  await request(grant, { authorization });
  expect(observed).toEqual([{ authorization: egress.basic(`${secret}:password`), body: "" }]);
  await request(grant, { authorization: egress.basic(`user:${unrelated}`) }, 502);
  grant.revoke();
  await request(grant, { authorization }, 407);
  expect(observed).toHaveLength(1);
});
it("acknowledges grants with scoped bindings, hosts, and payload-free audits", async () => {
  const grant = await register();
  expect(await request(grant, { body: `${sentinel}:body` })).toEqual({ status: 200, body: "ok" });
  expect(observed).toEqual([{ authorization: `Bearer ${secret}`, body: `${secret}:body` }]);
  await request(await register(proxy, []), {}, 502);
  await request(grant, { host: "127.0.0.1" }, 403);
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

it("revokes before cleanup delivery without revoking a sibling", async () => {
  const [revoked, sibling] = await Promise.all([register(), register()]);
  const response = await openRequest(revoked, { path: "/sse" });
  const sse = egress.capture(response);
  response.on("error", () => {});
  await sse.until("data: first\n\n");
  const send = nativeWorker.postMessage.bind(nativeWorker);
  const held = vi.spyOn(nativeWorker, "postMessage").mockImplementation(() => {});
  revoked.revoke();
  const messages = held.mock.calls.slice();
  held.mockRestore();
  try {
    streamingResponse!.end("data: after revoke\n\n");
    await sse.closed;
    expect(sse.text()).toBe("data: first\n\n");
    expect(response.complete).toBe(false);
    await request(revoked, {}, 407);
    expect(await request(sibling)).toEqual({ status: 200, body: "ok" });
    expect(observed).toEqual([authorized, authorized]);
  } finally {
    for (const args of messages) {
      send(...args);
    }
  }
});

it("delivers SSE data before the upstream completes its response", async () => {
  const response = await openRequest(await register(), { path: "/sse" });
  const sse = egress.capture(response);
  const ended = once(response, "end");
  await sse.until("data: first\n\n");
  expect(response.readableEnded).toBe(false);
  expect(streamingResponse?.writableEnded).toBe(false);
  streamingResponse!.end("data: final\n\n");
  await ended;
  expect(sse.text()).toBe("data: first\n\ndata: final\n\n");
});

it("fails closed on Worker exit, settling pending control and network work", async () => {
  const failed = vi.fn();
  const isolated = await startWorker(failed);
  const response = await openRequest(await register(isolated.handle), { path: "/sse" });
  const closed = egress.onClose(response);
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
