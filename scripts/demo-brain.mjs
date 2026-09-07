#!/usr/bin/env node

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUIRED_ENVIRONMENT = [
  "KITHMIND_URL",
  "KITHMIND_API_KEY",
  "KITHMIND_SPACE_ID",
  "KITHMIND_SOURCE_ACCOUNT_ID",
];

const SYNTHETIC_DOCUMENTS = [
  {
    requestId: "kithmind-demo-service-20260907",
    externalId: "kithmind-demo-service-note-20260907",
    title: "Synthetic vehicle service note",
    docType: "generic",
    query: "kithmind-demo-service-marker",
    evidence: "KITHMIND-DEMO-SERVICE-MARKER: café 🚗 service record.",
    capturedAt: "2026-09-07T18:00:00Z",
  },
  {
    requestId: "kithmind-demo-lab-20260907",
    externalId: "kithmind-demo-lab-note-20260907",
    title: "Synthetic lab note",
    docType: "generic",
    query: "kithmind-demo-lab-marker",
    evidence: "KITHMIND-DEMO-LAB-MARKER: naïve sample α retained.",
    capturedAt: "2026-09-07T18:01:00Z",
  },
];

class DemoError extends Error {
  constructor(code) {
    super(code);
    this.name = "DemoError";
  }
}

function safeError(code) {
  return new DemoError(code);
}

export function loadConfig(environment = process.env) {
  for (const name of REQUIRED_ENVIRONMENT) {
    if (!environment[name] || !environment[name].trim()) {
      throw safeError("demo: configuration invalid");
    }
  }

  let baseUrl;
  try {
    baseUrl = new URL(environment.KITHMIND_URL);
  } catch {
    throw safeError("demo: configuration invalid");
  }
  const permittedProtocol =
    baseUrl.protocol === "https:" ||
    (baseUrl.protocol === "http:" && LOOPBACK_HOSTS.has(baseUrl.hostname));
  if (
    !permittedProtocol ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== "/"
  ) {
    throw safeError("demo: configuration invalid");
  }

  return {
    baseUrl: baseUrl.origin,
    apiKey: environment.KITHMIND_API_KEY,
    spaceId: environment.KITHMIND_SPACE_ID,
    sourceAccountId: environment.KITHMIND_SOURCE_ACCOUNT_ID,
  };
}

async function readBoundedText(response) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    throw safeError("demo: response rejected");
  }
  const reader = response.body?.getReader();
  if (!reader) throw safeError("demo: response rejected");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw safeError("demo: response rejected");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function request(fetchImpl, url, apiKey, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw safeError("demo: request failed");
    const text = await readBoundedText(response);
    try {
      return JSON.parse(text);
    } catch {
      throw safeError("demo: response rejected");
    }
  } catch (error) {
    if (error instanceof DemoError) throw error;
    throw safeError("demo: request failed");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function requireReadyIngest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.documentId !== "string" ||
    typeof value.sourceRevisionId !== "string" ||
    value.state !== "ready" ||
    value.isActive !== true
  ) {
    throw safeError("demo: ingest incomplete");
  }
  return {
    documentId: value.documentId,
    sourceRevisionId: value.sourceRevisionId,
  };
}

function parseMcpValue(value, expectedId) {
  if (
    !value ||
    typeof value !== "object" ||
    value.jsonrpc !== "2.0" ||
    value.id !== expectedId ||
    value.error ||
    !value.result ||
    typeof value.result !== "object" ||
    value.result.isError === true ||
    !Array.isArray(value.result.content)
  ) {
    throw safeError("demo: response rejected");
  }
  const firstPart = value.result.content[0];
  if (
    !firstPart ||
    typeof firstPart !== "object" ||
    firstPart.type !== "text" ||
    typeof firstPart.text !== "string"
  ) {
    throw safeError("demo: response rejected");
  }
  try {
    return JSON.parse(firstPart.text);
  } catch {
    throw safeError("demo: response rejected");
  }
}

async function callTool(fetchImpl, config, id, name, args) {
  const response = await request(
    fetchImpl,
    `${config.baseUrl}/api/mcp`,
    config.apiKey,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    },
  );
  return parseMcpValue(response, id);
}

function hasDocument(result, documentId) {
  return (
    result &&
    typeof result === "object" &&
    Array.isArray(result.results) &&
    result.results.some(
      (row) => row && typeof row === "object" && row.documentId === documentId,
    )
  );
}

function hasExactEvidence(result, receipt, evidence) {
  return (
    result &&
    typeof result === "object" &&
    result.documentId === receipt.documentId &&
    result.sourceRevisionId === receipt.sourceRevisionId &&
    result.retainedTextAvailable === true &&
    Array.isArray(result.pages) &&
    result.pages.some(
      (page) =>
        page &&
        typeof page === "object" &&
        page.text === evidence &&
        Array.isArray(page.evidence) &&
        page.evidence.some(
          (span) =>
            span &&
            typeof span === "object" &&
            span.quote === evidence &&
            typeof span.evidenceSpanId === "string" &&
            span.evidenceSpanId.length > 0,
        ),
    )
  );
}

export async function runDemo({
  environment = process.env,
  fetchImpl = fetch,
  output = console.log,
} = {}) {
  const config = loadConfig(environment);
  const documentIds = [];
  let rpcId = 1;
  for (const document of SYNTHETIC_DOCUMENTS) {
    const payload = {
      spaceId: config.spaceId,
      requestId: document.requestId,
      expectedDesiredProcessingEpoch: 0,
      source: {
        connector: "mcp-client",
        accountId: config.sourceAccountId,
        externalId: document.externalId,
        capturedAt: document.capturedAt,
      },
      title: document.title,
      text: document.evidence,
      docType: document.docType,
    };
    const firstReceipt = requireReadyIngest(
      await request(
        fetchImpl,
        `${config.baseUrl}/api/ingest`,
        config.apiKey,
        payload,
      ),
    );
    const retryReceipt = requireReadyIngest(
      await request(
        fetchImpl,
        `${config.baseUrl}/api/ingest`,
        config.apiKey,
        payload,
      ),
    );
    if (
      firstReceipt.documentId !== retryReceipt.documentId ||
      firstReceipt.sourceRevisionId !== retryReceipt.sourceRevisionId
    ) {
      throw safeError("demo: idempotency failed");
    }
    documentIds.push(firstReceipt.documentId);

    const search = await callTool(
      fetchImpl,
      config,
      rpcId++,
      "search_documents",
      {
        query: document.query,
        spaceIds: [config.spaceId],
        limit: 10,
        searchMode: "keyword",
      },
    );
    if (!hasDocument(search, firstReceipt.documentId)) {
      throw safeError("demo: search failed");
    }
    const retrieved = await callTool(
      fetchImpl,
      config,
      rpcId++,
      "get_document",
      {
        documentId: firstReceipt.documentId,
        spaceIds: [config.spaceId],
      },
    );
    if (!hasExactEvidence(retrieved, firstReceipt, document.evidence)) {
      throw safeError("demo: evidence failed");
    }
  }
  output("demo: synthetic documents ingested, replayed, and retrieved");
  return { documentIds };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  runDemo().catch((error) => {
    process.stderr.write(
      `${error instanceof DemoError ? error.message : "demo: failed"}\n`,
    );
    process.exitCode = 1;
  });
}
