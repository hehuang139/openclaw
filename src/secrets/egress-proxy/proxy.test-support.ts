import { once } from "node:events";
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
import { expect } from "vitest";

export async function readResponse(response: IncomingMessage) {
  return { status: response.statusCode ?? 0, body: await text(response) };
}

export function proxyRequest(
  env: Record<string, string>,
  options: Omit<RequestOptions, "headers"> & {
    headers?: OutgoingHttpHeaders;
    chunks?: readonly (string | Buffer)[];
  },
  track?: (socket: Socket) => void,
): Promise<IncomingMessage> {
  const endpoint = new URL(env.HTTP_PROXY!);
  const { chunks = [], ...requestOptions } = options;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        agent: false,
        ...requestOptions,
        headers: { "Proxy-Authorization": basicAuth(endpoint.password), ...options.headers },
      },
      resolve,
    );
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

export const basicAuth = (password: string) =>
  `Basic ${Buffer.from(`openclaw:${password}`).toString("base64")}`;

export function copyCa(source: string, target: string) {
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
