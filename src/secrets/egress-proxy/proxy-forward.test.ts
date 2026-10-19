import {
  createServer,
  request as httpRequest,
  IncomingMessage,
  ServerResponse,
  type ClientRequest,
} from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { Socket } from "node:net";
import { PassThrough, Writable, type Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveSecretSentinel, sealSecretSentinel } from "../sentinel.js";
import { createSecretEgressBodyBudget, forwardSecretEgressRequest } from "./proxy-forward.js";
import { closeServer, listen } from "./proxy.test-support.js";

vi.mock("node:https", { spy: true });

let agent: Agent;
const resources: Array<Readable | Writable> = [];
const clients: Array<IncomingMessage | ServerResponse> = [];
const target = new URL("https://localhost:1/");
beforeEach(() => {
  agent = new Agent();
});
afterEach(() => {
  for (const resource of [...resources, ...clients]) {
    resource.destroy();
  }
  resources.length = clients.length = 0;
  agent.destroy();
});

function fakeRequest(length?: number) {
  const request = new IncomingMessage(new Socket());
  request.headers = length === undefined ? {} : { "content-length": String(length) };
  request.method = "POST";
  request.on("error", () => {});
  const response = new ServerResponse(request);
  clients.push(request, response);
  return { request, response };
}

function forward(
  request: IncomingMessage,
  response: ServerResponse,
  overrides: Partial<Parameters<typeof forwardSecretEgressRequest>[0]> = {},
) {
  forwardSecretEgressRequest({
    request,
    response,
    host: "localhost",
    upstreamTlsAgent: agent,
    prepareRequest: () => ({ target, headers: {}, substituted: false }),
    acquireBody: createSecretEgressBodyBudget(),
    isActive: () => true,
    ownResource: (resource) => {
      resources.push(resource);
      return resource;
    },
    releaseResponse() {},
    resolveSentinel() {
      return undefined;
    },
    audit() {},
    ...overrides,
  });
}

it.each([undefined, 0])(
  "releases body streams when upstream construction fails (length: %s)",
  async (length) => {
    const { request, response } = fakeRequest(length);
    forward(request, response, {
      // Node rejects this header synchronously, before opening an upstream socket.
      prepareRequest: () => ({
        target,
        headers: { "x-synthetic": "invalid\nheader" },
        substituted: true,
      }),
      ownResource: (resource) => {
        resources.push(resource);
        resource.on("error", () => resource.destroy());
        return resource;
      },
    });
    request.push(null);
    await setImmediate();
    response.emit("close");
    await setImmediate();
    expect(response.statusCode).toBe(502);
    expect(resources.every((resource) => resource.destroyed)).toBe(true);
  },
);

it.each([
  ["run revocation", "drain"],
  ["run revocation", "next turn"],
  ["client disconnect", "drain"],
  ["client disconnect", "next turn"],
] as const)("stops buffered submission after %s while waiting for %s", async (cause, wait) => {
  const secret = "synthetic-buffered-secret";
  const body = Buffer.concat([
    Buffer.alloc(128 * 1024, 120),
    Buffer.from(sealSecretSentinel(secret, { label: "buffered-cancellation" }) + "tail"),
  ]);
  const { request, response } = fakeRequest(body.length);
  const submitted: Buffer[] = [];
  let completeWrite: (error?: Error | null) => void = () => {};
  const started = createDeferredCore();
  // Real backpressure avoids platform socket buffers and test-only production hooks.
  const upstream = new Writable({
    highWaterMark: wait === "drain" ? 1 : body.length + 1,
    write(chunk: Buffer, _encoding, callback) {
      submitted.push(Buffer.from(chunk));
      completeWrite = callback;
      started.resolve();
    },
  });
  vi.mocked(httpsRequest).mockReturnValueOnce(upstream as unknown as ClientRequest);
  const releaseBody = vi.fn();
  const audit = vi.fn();
  let active = true;
  forward(request, response, {
    acquireBody: () => releaseBody,
    isActive: () => active,
    resolveSentinel: resolveSecretSentinel,
    audit,
  });
  request.push(body);
  request.push(null);
  await started.promise;
  expect(releaseBody).not.toHaveBeenCalled();
  if (cause === "client disconnect") {
    response.emit("close");
  } else {
    active = false;
  }
  completeWrite();
  await setImmediate();
  await setImmediate();
  const sent = Buffer.concat(submitted);
  expect(sent.length).toBeLessThan(body.length);
  expect(sent.includes(secret)).toBe(false);
  expect(sent.includes("tail")).toBe(false);
  expect(upstream).toMatchObject({ destroyed: true, writableEnded: false });
  expect(releaseBody).toHaveBeenCalledOnce();
  expect(audit).not.toHaveBeenCalled();
});
// A later-tick upstream response makes writeHead throws escape the forwarding try block.
it("closes a rejected bodyless head instead of framing a 502 body", async () => {
  let failClient: (error: unknown) => void = () => {};
  const onUncaught = vi.fn((error: unknown) => failClient(error));
  vi.mocked(httpsRequest).mockImplementationOnce(((...args: unknown[]) => {
    const callback = args.at(-1) as (message: IncomingMessage) => void;
    const upstreamResponse = new IncomingMessage(new Socket());
    upstreamResponse.statusCode = 304;
    upstreamResponse.headers = { trailer: "Expires" };
    upstreamResponse.on("error", () => {});
    process.nextTick(() => {
      callback(upstreamResponse);
      upstreamResponse.push(null);
    });
    return new PassThrough() as unknown as ClientRequest;
  }) as never);
  const server = createServer(forward);
  process.on("uncaughtException", onUncaught);
  try {
    const port = await listen(server);
    const client = createDeferredCore<IncomingMessage>();
    failClient = client.reject;
    httpRequest({ host: "127.0.0.1", port, path: "/", agent: false }, (response) => {
      response.on("error", client.reject);
      response.resume();
      client.resolve(response);
    })
      .on("error", client.reject)
      .end();
    await expect(client.promise).rejects.toMatchObject({ code: "ECONNRESET" });
    await setImmediate();
    expect(onUncaught).not.toHaveBeenCalled();
  } finally {
    process.off("uncaughtException", onUncaught);
    server.closeAllConnections();
    await closeServer(server);
  }
});
