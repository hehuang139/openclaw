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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveSecretSentinel, sealSecretSentinel } from "../sentinel.js";
import { createSecretEgressBodyBudget, forwardSecretEgressRequest } from "./proxy-forward.js";
import { closeServer, listen } from "./proxy.test-support.js";

vi.mock("node:https", { spy: true });

let agent: Agent;
let resources: Array<Readable | Writable>;
let clients: Array<IncomingMessage | ServerResponse>;
beforeEach(() => {
  agent = new Agent();
  resources = [];
  clients = [];
});
afterEach(() => {
  for (const resource of [...resources, ...clients]) {
    resource.destroy();
  }
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
    prepareRequest: () => ({
      target: new URL("https://localhost:1/"),
      headers: {},
      substituted: false,
    }),
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

describe("secret egress forwarding resource ownership", () => {
  it.each([undefined, 0])(
    "releases body streams when upstream construction fails (length: %s)",
    async (length) => {
      const { request, response } = fakeRequest(length);
      forward(request, response, {
        // A protected value can contain newlines. Node refuses this header
        // synchronously, before DNS, TLS or any upstream socket is opened.
        prepareRequest: () => ({
          target: new URL("https://localhost:1/"),
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
    // Real Writable backpressure controls transport admission without relying on
    // platform socket buffers or adding a test-only production hook.
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
    expect(upstream.destroyed).toBe(true);
    expect(upstream.writableEnded).toBe(false);
    expect(releaseBody).toHaveBeenCalledOnce();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("secret egress forwarded response heads", () => {
  // Serves one real loopback request through the proxy forwarder. The upstream
  // response is emitted on a later tick, like the real client, so a throw from
  // writeHead would escape instead of landing in the forwarder's own try block.
  it("closes a rejected bodyless head instead of framing a 502 body", async () => {
    const uncaught: unknown[] = [];
    let failClient: (error: unknown) => void = () => {};
    const onUncaught = (error: unknown) => {
      uncaught.push(error);
      failClient(error);
    };
    vi.mocked(httpsRequest).mockImplementationOnce(((...args: unknown[]) => {
      const callback = args.find((entry) => typeof entry === "function") as (
        message: IncomingMessage,
      ) => void;
      const upstreamResponse = new IncomingMessage(new Socket());
      upstreamResponse.statusCode = 304;
      upstreamResponse.headers = { trailer: "Expires" };
      upstreamResponse.on("error", () => {});
      process.nextTick(() => {
        callback(upstreamResponse);
        if (!upstreamResponse.destroyed) {
          upstreamResponse.push("file");
          upstreamResponse.push(null);
        }
      });
      return new PassThrough() as unknown as ClientRequest;
    }) as never);
    const server = createServer((request, response) => {
      forward(request, response);
    });
    process.on("uncaughtException", onUncaught);
    try {
      const port = await listen(server);
      const result = await new Promise<{
        status?: number;
        clientError?: NodeJS.ErrnoException;
      }>((resolve, reject) => {
        failClient = reject;
        httpRequest({ host: "127.0.0.1", port, path: "/", agent: false }, (response) => {
          response.resume();
          resolve({ status: response.statusCode });
          response.on("error", (clientError) =>
            resolve({ status: response.statusCode, clientError }),
          );
        })
          .on("error", (clientError) => resolve({ clientError }))
          .end();
      });
      await setImmediate();
      expect(uncaught).toEqual([]);
      expect(result).toEqual({ clientError: expect.objectContaining({ code: "ECONNRESET" }) });
    } finally {
      process.off("uncaughtException", onUncaught);
      server.closeAllConnections();
      await closeServer(server);
    }
  });
});
