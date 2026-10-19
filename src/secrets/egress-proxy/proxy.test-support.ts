import { once, type EventEmitter } from "node:events";
import fs from "node:fs";
import {
  request,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
} from "node:http";
import type { Server, Socket } from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import tls from "node:tls";
import { beforeAll, expect } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { startSecretEgressProxyServer, type SecretEgressProxyAuditEvent } from "./proxy-server.js";

export function createProxy(
  caDir: string,
  audit: SecretEgressProxyAuditEvent[],
  policy: Pick<
    Parameters<typeof startSecretEgressProxyServer>[0],
    "allowedHosts" | "bypassHosts"
  > = {},
) {
  return startSecretEgressProxyServer({ caDir, onAudit: (event) => audit.push(event), ...policy });
}

export function useCaSeed(prefix: string) {
  const dirs = createTempDirTracker();
  let dir: string;
  let leaf: Awaited<ReturnType<typeof generateLocalProxyLeaf>>;
  beforeAll(async () => {
    dir = dirs.make(`${prefix}seed-`);
    const ca = await ensureSecretEgressProxyCa(dir);
    leaf = await generateLocalProxyLeaf({ certDir: dir, ca, hostname: "localhost" });
  });
  return {
    get leaf() {
      return leaf;
    },
    make() {
      const target = dirs.make(prefix);
      copyCa(dir, target);
      return target;
    },
    cleanup: () => dirs.cleanup(),
  };
}

export function onClose(stream: Pick<EventEmitter, "once">): Promise<void> {
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
  });
}

export function capture(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const bytes = () => Buffer.concat(chunks);
  return {
    closed: onClose(stream),
    bytes,
    text: () => bytes().toString(),
    async until(expected: string | Buffer) {
      while (!bytes().includes(expected)) {
        await once(stream, "data");
      }
      return bytes().toString();
    },
  };
}

export const binding = (
  sentinel: string,
  allowedHosts: readonly string[] = ["localhost"],
  name = "SERVICE_API_KEY",
) => ({ name, sentinel, allowedHosts });

export async function readResponse(response: IncomingMessage) {
  return { status: response.statusCode ?? 0, body: await text(response) };
}

export function openRequest(
  options: RequestOptions,
  chunks: readonly (string | Buffer)[] = [],
  track?: (socket: Socket) => void,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ agent: false, ...options }, resolve);
    if (track) {
      outgoing.once("socket", track);
    }
    outgoing.once("error", reject);
    for (const chunk of chunks) {
      outgoing.write(chunk);
    }
    outgoing.end();
  });
}

export function proxyRequest(
  env: Record<string, string>,
  options: Omit<RequestOptions, "headers"> & {
    headers?: OutgoingHttpHeaders;
    chunks?: readonly (string | Buffer)[];
  },
  track?: (socket: Socket) => void,
) {
  const endpoint = new URL(env.HTTP_PROXY!);
  const { chunks, ...requestOptions } = options;
  return openRequest(
    {
      hostname: endpoint.hostname,
      port: endpoint.port,
      ...requestOptions,
      headers: { "Proxy-Authorization": basicAuth(endpoint.password), ...options.headers },
    },
    chunks,
    track,
  );
}

export const basic = (credentials: string) =>
  `Basic ${Buffer.from(credentials).toString("base64")}`;
export const basicAuth = (password: string) => basic(`openclaw:${password}`);

function copyCa(source: string, target: string) {
  for (const file of ["root-ca.pem", "root-ca-key.pem", "leaf-key.pem"]) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
}

export async function listen(server: Server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Origin did not bind a TCP port");
  }
  return address.port;
}

export function closeServer(server: { close: (callback: () => void) => unknown }): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export function socketTracker() {
  const sockets = new Set<Socket>();
  return {
    track<T extends Socket>(socket: T): T {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      return socket;
    },
    destroy() {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
  };
}

export function connectTunnel(
  env: Record<string, string>,
  port: number,
  track: <T extends Socket>(socket: T) => T,
) {
  const url = new URL(env.HTTPS_PROXY!);
  return new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
    const outgoing = request({
      hostname: url.hostname,
      port: url.port,
      method: "CONNECT",
      agent: false,
      path: `localhost:${port}`,
      headers: { "Proxy-Authorization": basicAuth(url.password) },
    });
    outgoing.once("socket", track);
    outgoing.once("connect", (response, socket) =>
      resolve({ status: response.statusCode ?? 0, socket: track(socket) }),
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

export async function connectTls(
  connected: { status: number; socket?: Socket },
  caPath: string,
  track: <T extends Socket>(socket: T) => T,
) {
  expect(connected.status).toBe(200);
  const socket = track(
    tls.connect({
      socket: connected.socket,
      servername: "localhost",
      ca: fs.readFileSync(caPath),
    }),
  );
  await once(socket, "secureConnect");
  expect(socket.authorized).toBe(true);
  return socket;
}
