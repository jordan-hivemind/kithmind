import { createServer } from "node:http";

import { handlePostgresWorkerRequest } from "../../dist/workers/index.js";

export async function listenWorker(t, pool, now) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const method = incoming.method ?? "GET";
      const request = new Request(
        `http://127.0.0.1${incoming.url ?? "/api/worker"}`,
        {
          method,
          headers: incoming.headers,
          ...(["GET", "HEAD"].includes(method)
            ? {}
            : { body: Buffer.concat(chunks) }),
        },
      );
      const response = await handlePostgresWorkerRequest(
        pool,
        request,
        now === undefined ? Date.now : () => now,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end("test host failure");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server failed");
  return `http://127.0.0.1:${address.port}/api/worker`;
}
