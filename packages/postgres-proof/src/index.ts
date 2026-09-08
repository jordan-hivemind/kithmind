import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  canonicalizeFinanceDecimal,
  parseCanonicalFinanceDecimal,
  parseFinanceCurrency,
} from "@repo/finance-contract";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProofError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ProofError";
  }
}

export type PageInput = { pageNumber: number; text: string; textHash: string };
export type EvidenceInput = {
  ordinal: number;
  pageNumber: number;
  startCodepoint: number;
  endCodepoint: number;
  quote: string;
  quoteHash: string;
};
export type ChunkInput = {
  ordinal: number;
  evidenceOrdinal: number;
  text: string;
};
export type SyntheticFinancialAttachmentInput = {
  evidenceOrdinal: number;
  label: string;
  amount: string;
  currency: string;
};
export type StageGenerationInput = {
  requestId: string;
  documentExternalId: string;
  sourceContentHash: string;
  pages: PageInput[];
  evidence: EvidenceInput[];
  chunks: ChunkInput[];
  financialAttachments?: SyntheticFinancialAttachmentInput[];
};

export type StageGenerationResult = {
  documentId: string;
  sourceRevisionId: string;
  generationId: string;
  revisionOrdinal: number;
  state: "staging";
};

export type ActivateGenerationResult = {
  documentId: string;
  generationId: string;
  state: "ready";
  activatedAt: string;
};

export type Citation = {
  evidenceId: string;
  documentExternalId: string;
  generationId: string;
  pageNumber: number;
  pageTextHash: string;
  startCodepoint: number;
  endCodepoint: number;
  quote: string;
  quoteHash: string;
};

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newSyntheticApiKey(): string {
  return `km_proof_${randomBytes(32).toString("base64url")}`;
}

function keyHash(apiKey: string): Buffer {
  if (
    apiKey.length < 32 ||
    apiKey.length > 256 ||
    !/^[\x21-\x7e]+$/.test(apiKey)
  ) {
    throw new ProofError("invalid_api_key");
  }
  return createHash("sha256").update(apiKey, "utf8").digest();
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new ProofError("invalid_request_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  throw new ProofError("invalid_request_value");
}

function expectUuid(value: string, code: string): void {
  if (typeof value !== "string" || !UUID.test(value))
    throw new ProofError(code);
}

function expectHash(value: string, code: string): void {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new ProofError(code);
}

function expectText(
  value: string,
  min: number,
  max: number,
  code: string,
): void {
  if (typeof value !== "string") throw new ProofError(code);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < min || bytes > max || value.includes("\0"))
    throw new ProofError(code);
}

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  code: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProofError(code);
  const keys = Object.keys(value).sort();
  const expected = [...allowed].filter((key) => key in value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  )
    throw new ProofError(code);
}

function codepointSlice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join("");
}

export function validateStageGenerationInput(
  input: StageGenerationInput,
): void {
  assertExactKeys(
    input,
    [
      "requestId",
      "documentExternalId",
      "sourceContentHash",
      "pages",
      "evidence",
      "chunks",
      "financialAttachments",
    ],
    "invalid_stage_shape",
  );
  expectUuid(input.requestId, "invalid_request_id");
  expectText(input.documentExternalId, 1, 128, "invalid_document_external_id");
  expectHash(input.sourceContentHash, "invalid_source_hash");
  if (
    !Array.isArray(input.pages) ||
    input.pages.length < 1 ||
    input.pages.length > 64
  )
    throw new ProofError("invalid_pages");
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length < 1 ||
    input.evidence.length > 256
  )
    throw new ProofError("invalid_evidence");
  if (
    !Array.isArray(input.chunks) ||
    input.chunks.length < 1 ||
    input.chunks.length > 256
  )
    throw new ProofError("invalid_chunks");
  if (
    input.financialAttachments !== undefined &&
    (!Array.isArray(input.financialAttachments) ||
      input.financialAttachments.length > 256)
  ) {
    throw new ProofError("invalid_financial_attachments");
  }
  if (Buffer.byteLength(canonical(input), "utf8") > 4_194_304)
    throw new ProofError("request_too_large");
  const pages = new Map<number, PageInput>();
  for (const page of input.pages) {
    assertExactKeys(
      page,
      ["pageNumber", "text", "textHash"],
      "invalid_page_shape",
    );
    if (
      !Number.isSafeInteger(page.pageNumber) ||
      page.pageNumber < 1 ||
      page.pageNumber > 64 ||
      pages.has(page.pageNumber)
    ) {
      throw new ProofError("invalid_page_number");
    }
    expectText(page.text, 0, 1_048_576, "invalid_page_text");
    expectHash(page.textHash, "invalid_page_hash");
    if (sha256(page.text) !== page.textHash)
      throw new ProofError("page_hash_mismatch");
    pages.set(page.pageNumber, page);
  }
  const evidence = new Map<number, EvidenceInput>();
  for (const item of input.evidence) {
    assertExactKeys(
      item,
      [
        "ordinal",
        "pageNumber",
        "startCodepoint",
        "endCodepoint",
        "quote",
        "quoteHash",
      ],
      "invalid_evidence_shape",
    );
    const page = pages.get(item.pageNumber);
    if (
      !page ||
      !Number.isSafeInteger(item.ordinal) ||
      item.ordinal < 0 ||
      item.ordinal > 255 ||
      evidence.has(item.ordinal)
    ) {
      throw new ProofError("invalid_evidence_reference");
    }
    if (
      !Number.isSafeInteger(item.startCodepoint) ||
      !Number.isSafeInteger(item.endCodepoint) ||
      item.startCodepoint < 0 ||
      item.endCodepoint < item.startCodepoint
    ) {
      throw new ProofError("invalid_evidence_range");
    }
    expectText(item.quote, 1, 1_048_576, "invalid_quote");
    expectHash(item.quoteHash, "invalid_quote_hash");
    if (item.endCodepoint > Array.from(page.text).length)
      throw new ProofError("invalid_evidence_range");
    if (
      codepointSlice(page.text, item.startCodepoint, item.endCodepoint) !==
        item.quote ||
      sha256(item.quote) !== item.quoteHash
    ) {
      throw new ProofError("citation_mismatch");
    }
    evidence.set(item.ordinal, item);
  }
  const chunkOrdinals = new Set<number>();
  for (const chunk of input.chunks) {
    assertExactKeys(
      chunk,
      ["ordinal", "evidenceOrdinal", "text"],
      "invalid_chunk_shape",
    );
    if (
      !Number.isSafeInteger(chunk.ordinal) ||
      chunk.ordinal < 0 ||
      chunk.ordinal > 255 ||
      chunkOrdinals.has(chunk.ordinal) ||
      !evidence.has(chunk.evidenceOrdinal)
    ) {
      throw new ProofError("invalid_chunk_reference");
    }
    expectText(chunk.text, 1, 8192, "invalid_chunk_text");
    const linkedEvidence = evidence.get(chunk.evidenceOrdinal)!;
    const sourcePage = pages.get(linkedEvidence.pageNumber)!;
    if (
      !chunk.text.includes(linkedEvidence.quote) ||
      !sourcePage.text.includes(chunk.text)
    ) {
      throw new ProofError("chunk_citation_mismatch");
    }
    chunkOrdinals.add(chunk.ordinal);
  }
  for (const attachment of input.financialAttachments ?? []) {
    assertExactKeys(
      attachment,
      ["evidenceOrdinal", "label", "amount", "currency"],
      "invalid_financial_attachment_shape",
    );
    if (!evidence.has(attachment.evidenceOrdinal))
      throw new ProofError("invalid_financial_evidence");
    expectText(attachment.label, 1, 128, "invalid_financial_label");
    try {
      parseCanonicalFinanceDecimal(attachment.amount);
    } catch {
      throw new ProofError("invalid_financial_amount");
    }
    try {
      parseFinanceCurrency(attachment.currency);
    } catch {
      throw new ProofError("invalid_currency");
    }
  }
}

const migrationUrl = new URL("../migrations/001_init.sql", import.meta.url);

export async function applyProofMigration(
  owner: Pool,
  appRole: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(appRole))
    throw new ProofError("invalid_app_role");
  const sql = await readFile(fileURLToPath(migrationUrl), "utf8");
  await owner.query(sql);
  await grantProofAppRole(owner, appRole);
}

export async function grantProofAppRole(
  owner: Pool,
  appRole: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(appRole))
    throw new ProofError("invalid_app_role");
  await owner.query(`REVOKE ALL ON SCHEMA kith FROM PUBLIC`);
  await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA kith FROM PUBLIC`);
  await owner.query(`GRANT USAGE ON SCHEMA kith TO "${appRole}"`);
  await owner.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA kith TO "${appRole}"`,
  );
  await owner.query(`GRANT INSERT, UPDATE, DELETE ON
    kith.documents, kith.source_revisions, kith.generations, kith.pages,
    kith.evidence, kith.chunks, kith.synthetic_financial_attachments,
    kith.idempotency_receipts TO "${appRole}"`);
}

export async function seedSyntheticSpace(
  owner: Pool,
  opaqueName: string,
  apiKey: string,
): Promise<{ spaceId: string; apiKeyId: string }> {
  expectText(opaqueName, 1, 128, "invalid_space_name");
  const spaceId = randomUUID();
  const apiKeyId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO kith.spaces(id, opaque_name) VALUES ($1, $2)",
      [spaceId, opaqueName],
    );
    await client.query(
      "INSERT INTO kith.api_keys(id, space_id, key_hash) VALUES ($1, $2, $3)",
      [apiKeyId, spaceId, keyHash(apiKey)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { spaceId, apiKeyId };
}

export async function revokeSyntheticApiKey(
  owner: Pool,
  apiKeyId: string,
): Promise<void> {
  expectUuid(apiKeyId, "invalid_api_key_id");
  const result = await owner.query(
    "UPDATE kith.api_keys SET revoked_at = transaction_timestamp() WHERE id = $1 AND revoked_at IS NULL",
    [apiKeyId],
  );
  if (result.rowCount !== 1) throw new ProofError("api_key_not_current");
}

type ProofOptions = {
  afterDocumentWrite?: (client: PoolClient) => Promise<void>;
};

export class PostgresProof {
  constructor(
    private readonly pool: Pool,
    private readonly options: ProofOptions = {},
  ) {}

  private async authenticate(
    client: PoolClient,
    apiKey: string,
  ): Promise<string> {
    const result = await client.query<{ space_id: string }>(
      "SELECT space_id FROM kith.api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
      [keyHash(apiKey)],
    );
    if (result.rowCount !== 1) throw new ProofError("unauthorized");
    return result.rows[0]!.space_id;
  }

  private async transaction<T>(
    work: (client: PoolClient, spaceId: string) => Promise<T>,
    apiKey: string,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query(
        "SET LOCAL idle_in_transaction_session_timeout = '5s'",
      );
      const spaceId = await this.authenticate(client, apiKey);
      const result = await work(client, spaceId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async idempotent<T extends object>(
    client: PoolClient,
    spaceId: string,
    operation: "stage_generation" | "activate_generation" | "forget_document",
    requestId: string,
    request: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    expectUuid(requestId, "invalid_request_id");
    const requestHash = sha256(canonical(request));
    const prior = await client.query<{ request_hash: string; response: T }>(
      "SELECT request_hash, response FROM kith.idempotency_receipts WHERE space_id = $1 AND operation = $2 AND request_id = $3 FOR UPDATE",
      [spaceId, operation, requestId],
    );
    if (prior.rowCount === 1) {
      if (prior.rows[0]!.request_hash !== requestHash)
        throw new ProofError("idempotency_conflict");
      return prior.rows[0]!.response;
    }
    const response = await run();
    await client.query(
      "INSERT INTO kith.idempotency_receipts(space_id, operation, request_id, request_hash, response) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [spaceId, operation, requestId, requestHash, JSON.stringify(response)],
    );
    return response;
  }

  async stageGeneration(
    apiKey: string,
    input: StageGenerationInput,
  ): Promise<StageGenerationResult> {
    validateStageGenerationInput(input);
    return this.transaction(
      async (client, spaceId) =>
        this.idempotent(
          client,
          spaceId,
          "stage_generation",
          input.requestId,
          input,
          async () => {
            let documentId: string;
            let revisionOrdinal: number;
            const existing = await client.query<{
              id: string;
              forgotten_at: string | null;
            }>(
              "SELECT id, forgotten_at FROM kith.documents WHERE space_id = $1 AND external_id = $2 FOR UPDATE",
              [spaceId, input.documentExternalId],
            );
            if (existing.rowCount === 0) {
              documentId = randomUUID();
              revisionOrdinal = 1;
              await client.query(
                "INSERT INTO kith.documents(id, space_id, external_id) VALUES ($1, $2, $3)",
                [documentId, spaceId, input.documentExternalId],
              );
            } else {
              if (existing.rows[0]!.forgotten_at !== null)
                throw new ProofError("document_forgotten");
              documentId = existing.rows[0]!.id;
              const ordinal = await client.query<{ next_ordinal: number }>(
                "SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM kith.source_revisions WHERE document_id = $1 AND space_id = $2",
                [documentId, spaceId],
              );
              revisionOrdinal = ordinal.rows[0]!.next_ordinal;
            }
            const sourceRevisionId = randomUUID();
            const generationId = randomUUID();
            await client.query(
              "INSERT INTO kith.source_revisions(id, document_id, space_id, ordinal, source_content_hash) VALUES ($1, $2, $3, $4, $5)",
              [
                sourceRevisionId,
                documentId,
                spaceId,
                revisionOrdinal,
                input.sourceContentHash,
              ],
            );
            await this.options.afterDocumentWrite?.(client);
            await client.query(
              "INSERT INTO kith.generations(id, document_id, source_revision_id, space_id, state) VALUES ($1, $2, $3, $4, 'staging')",
              [generationId, documentId, sourceRevisionId, spaceId],
            );
            const pageIds = new Map<number, string>();
            for (const page of input.pages) {
              const pageId = randomUUID();
              pageIds.set(page.pageNumber, pageId);
              await client.query(
                "INSERT INTO kith.pages(id, generation_id, space_id, page_number, page_text, page_text_hash) VALUES ($1, $2, $3, $4, $5, $6)",
                [
                  pageId,
                  generationId,
                  spaceId,
                  page.pageNumber,
                  page.text,
                  page.textHash,
                ],
              );
            }
            const evidenceIds = new Map<number, string>();
            for (const evidence of input.evidence) {
              const evidenceId = randomUUID();
              evidenceIds.set(evidence.ordinal, evidenceId);
              await client.query(
                "INSERT INTO kith.evidence(id, generation_id, page_id, space_id, ordinal, start_codepoint, end_codepoint, quote_text, quote_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                [
                  evidenceId,
                  generationId,
                  pageIds.get(evidence.pageNumber),
                  spaceId,
                  evidence.ordinal,
                  evidence.startCodepoint,
                  evidence.endCodepoint,
                  evidence.quote,
                  evidence.quoteHash,
                ],
              );
            }
            for (const chunk of input.chunks) {
              await client.query(
                "INSERT INTO kith.chunks(id, generation_id, evidence_id, space_id, ordinal, chunk_text) VALUES ($1,$2,$3,$4,$5,$6)",
                [
                  randomUUID(),
                  generationId,
                  evidenceIds.get(chunk.evidenceOrdinal),
                  spaceId,
                  chunk.ordinal,
                  chunk.text,
                ],
              );
            }
            for (const attachment of input.financialAttachments ?? []) {
              await client.query(
                "INSERT INTO kith.synthetic_financial_attachments(id, generation_id, evidence_id, space_id, label, amount, currency) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7)",
                [
                  randomUUID(),
                  generationId,
                  evidenceIds.get(attachment.evidenceOrdinal),
                  spaceId,
                  attachment.label,
                  attachment.amount,
                  attachment.currency,
                ],
              );
            }
            return {
              documentId,
              sourceRevisionId,
              generationId,
              revisionOrdinal,
              state: "staging",
            };
          },
        ),
      apiKey,
    );
  }

  async activateGeneration(
    apiKey: string,
    input: { requestId: string; generationId: string },
  ): Promise<ActivateGenerationResult> {
    assertExactKeys(
      input,
      ["requestId", "generationId"],
      "invalid_activate_shape",
    );
    expectUuid(input.generationId, "invalid_generation_id");
    return this.transaction(
      async (client, spaceId) =>
        this.idempotent(
          client,
          spaceId,
          "activate_generation",
          input.requestId,
          input,
          async () => {
            const generation = await client.query<{
              document_id: string;
              state: string;
              ordinal: number;
            }>(
              "SELECT g.document_id, g.state, r.ordinal FROM kith.generations g JOIN kith.source_revisions r ON r.id=g.source_revision_id AND r.space_id=g.space_id WHERE g.id = $1 AND g.space_id = $2 FOR UPDATE OF g",
              [input.generationId, spaceId],
            );
            if (generation.rowCount !== 1)
              throw new ProofError("generation_not_found");
            if (generation.rows[0]!.state !== "staging")
              throw new ProofError("generation_not_staging");
            const documentId = generation.rows[0]!.document_id;
            await client.query(
              "SELECT id FROM kith.documents WHERE id = $1 AND space_id = $2 AND forgotten_at IS NULL FOR UPDATE",
              [documentId, spaceId],
            );
            const latest = await client.query<{ ordinal: number }>(
              "SELECT max(ordinal)::int AS ordinal FROM kith.source_revisions WHERE document_id=$1 AND space_id=$2",
              [documentId, spaceId],
            );
            if (generation.rows[0]!.ordinal !== latest.rows[0]!.ordinal)
              throw new ProofError("stale_generation");
            const complete = await client.query<{
              pages: string;
              chunks: string;
            }>(
              "SELECT (SELECT count(*) FROM kith.pages WHERE generation_id=$1 AND space_id=$2) AS pages, (SELECT count(*) FROM kith.chunks WHERE generation_id=$1 AND space_id=$2) AS chunks",
              [input.generationId, spaceId],
            );
            if (
              Number(complete.rows[0]!.pages) < 1 ||
              Number(complete.rows[0]!.chunks) < 1
            )
              throw new ProofError("generation_incomplete");
            await client.query(
              "UPDATE kith.generations SET state='superseded' WHERE document_id=$1 AND space_id=$2 AND state='ready'",
              [documentId, spaceId],
            );
            const activated = await client.query<{ activated_at: Date }>(
              "UPDATE kith.generations SET state='ready', activated_at=transaction_timestamp() WHERE id=$1 AND space_id=$2 RETURNING activated_at",
              [input.generationId, spaceId],
            );
            await client.query(
              "UPDATE kith.documents SET active_generation_id=$1 WHERE id=$2 AND space_id=$3",
              [input.generationId, documentId, spaceId],
            );
            return {
              documentId,
              generationId: input.generationId,
              state: "ready",
              activatedAt: activated.rows[0]!.activated_at.toISOString(),
            };
          },
        ),
      apiKey,
    );
  }

  async search(apiKey: string, phrase: string): Promise<Citation[]> {
    expectText(phrase, 1, 256, "invalid_query");
    return this.transaction(async (client, spaceId) => {
      const result = await client.query<CitationRow>(
        `SELECT e.id AS evidence_id, d.external_id AS document_external_id, g.id AS generation_id,
                p.page_number, p.page_text_hash, e.start_codepoint, e.end_codepoint,
                e.quote_text, e.quote_hash
           FROM kith.documents d
           JOIN kith.generations g ON g.id=d.active_generation_id AND g.space_id=d.space_id AND g.state='ready'
           JOIN kith.chunks c ON c.generation_id=g.id AND c.space_id=g.space_id
           JOIN kith.evidence e ON e.id=c.evidence_id AND e.space_id=c.space_id
           JOIN kith.pages p ON p.id=e.page_id AND p.space_id=e.space_id
          WHERE d.space_id=$1 AND d.forgotten_at IS NULL AND position(lower($2) in lower(c.chunk_text)) > 0
          ORDER BY d.external_id, c.ordinal LIMIT 50`,
        [spaceId, phrase],
      );
      return result.rows.map(citationFromRow);
    }, apiKey);
  }

  async readCitation(apiKey: string, evidenceId: string): Promise<Citation> {
    expectUuid(evidenceId, "invalid_evidence_id");
    return this.transaction(async (client, spaceId) => {
      const result = await client.query<CitationRow>(
        `SELECT e.id AS evidence_id, d.external_id AS document_external_id, g.id AS generation_id,
                p.page_number, p.page_text_hash, e.start_codepoint, e.end_codepoint,
                e.quote_text, e.quote_hash
           FROM kith.evidence e
           JOIN kith.generations g ON g.id=e.generation_id AND g.space_id=e.space_id AND g.state IN ('ready','superseded')
           JOIN kith.documents d ON d.id=g.document_id AND d.space_id=g.space_id AND d.forgotten_at IS NULL
           JOIN kith.pages p ON p.id=e.page_id AND p.space_id=e.space_id
          WHERE e.id=$1 AND e.space_id=$2`,
        [evidenceId, spaceId],
      );
      if (result.rowCount !== 1) throw new ProofError("citation_not_found");
      return citationFromRow(result.rows[0]!);
    }, apiKey);
  }

  async syntheticFinancialTotal(
    apiKey: string,
    currency: string,
  ): Promise<string> {
    try {
      parseFinanceCurrency(currency);
    } catch {
      throw new ProofError("invalid_currency");
    }
    return this.transaction(async (client, spaceId) => {
      const result = await client.query<{ total: string }>(
        `SELECT COALESCE(sum(f.amount), 0)::text AS total
           FROM kith.synthetic_financial_attachments f
           JOIN kith.generations g ON g.id=f.generation_id AND g.space_id=f.space_id AND g.state='ready'
           JOIN kith.documents d ON d.active_generation_id=g.id AND d.space_id=g.space_id AND d.forgotten_at IS NULL
          WHERE f.space_id=$1 AND f.currency=$2`,
        [spaceId, currency],
      );
      try {
        return canonicalizeFinanceDecimal(result.rows[0]!.total);
      } catch {
        throw new ProofError("financial_total_out_of_range");
      }
    }, apiKey);
  }

  async forgetDocument(
    apiKey: string,
    input: { requestId: string; documentExternalId: string },
  ): Promise<{ documentId: string; forgotten: true }> {
    assertExactKeys(
      input,
      ["requestId", "documentExternalId"],
      "invalid_forget_shape",
    );
    expectText(
      input.documentExternalId,
      1,
      128,
      "invalid_document_external_id",
    );
    return this.transaction(
      async (client, spaceId) =>
        this.idempotent(
          client,
          spaceId,
          "forget_document",
          input.requestId,
          input,
          async () => {
            const document = await client.query<{ id: string }>(
              "SELECT id FROM kith.documents WHERE space_id=$1 AND external_id=$2 AND forgotten_at IS NULL FOR UPDATE",
              [spaceId, input.documentExternalId],
            );
            if (document.rowCount !== 1)
              throw new ProofError("document_not_found");
            const documentId = document.rows[0]!.id;
            await client.query(
              "UPDATE kith.documents SET active_generation_id=NULL, forgotten_at=transaction_timestamp() WHERE id=$1 AND space_id=$2",
              [documentId, spaceId],
            );
            await client.query(
              "DELETE FROM kith.generations WHERE document_id=$1 AND space_id=$2",
              [documentId, spaceId],
            );
            return { documentId, forgotten: true };
          },
        ),
      apiKey,
    );
  }
}

type CitationRow = QueryResultRow & {
  evidence_id: string;
  document_external_id: string;
  generation_id: string;
  page_number: number;
  page_text_hash: string;
  start_codepoint: number;
  end_codepoint: number;
  quote_text: string;
  quote_hash: string;
};

function citationFromRow(row: CitationRow): Citation {
  return {
    evidenceId: row.evidence_id,
    documentExternalId: row.document_external_id,
    generationId: row.generation_id,
    pageNumber: row.page_number,
    pageTextHash: row.page_text_hash,
    startCodepoint: row.start_codepoint,
    endCodepoint: row.end_codepoint,
    quote: row.quote_text,
    quoteHash: row.quote_hash,
  };
}
