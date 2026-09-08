// get_evidence: for one row in a source-carrying table, the document it came
// from, its locator, content hash and the retained text an assistant can
// read. This is the citation the archive exists to produce, so the table
// name is a closed enum, not free text -- every entry here is a table that
// actually carries source_document_id and source_locator.

import type { DatabaseSync } from "node:sqlite";

export const EVIDENCE_TABLES = [
  "transactions",
  "positions",
  "balances",
  "liabilities",
  "commitments",
] as const;
export type EvidenceTable = (typeof EVIDENCE_TABLES)[number];

export type EvidenceDocument = {
  id: string;
  docType: string;
  docDate: string | null;
  sha256: string;
  textPath: string | null;
  filePath: string;
  parsedOk: boolean;
};

export type EvidenceResult =
  | {
      found: true;
      table: EvidenceTable;
      id: string;
      sourceLocator: string | null;
      /** Null when the row has no source_document_id recorded, which is
       * itself informative: this value has no citation yet. */
      document: EvidenceDocument | null;
    }
  | { found: false; table: EvidenceTable; id: string };

type RowRef = {
  source_document_id: string | null;
  source_locator: string | null;
};
type DocRow = {
  id: string;
  doc_type: string;
  doc_date: string | null;
  sha256: string;
  text_path: string | null;
  file_path: string;
  parsed_ok: number;
};

export function getEvidence(
  db: DatabaseSync,
  table: EvidenceTable,
  id: string,
): EvidenceResult {
  const row = db
    .prepare(
      `SELECT source_document_id, source_locator FROM ${table} WHERE id = ?`,
    )
    .get(id) as RowRef | undefined;
  if (!row) return { found: false, table, id };

  let document: EvidenceDocument | null = null;
  if (row.source_document_id !== null) {
    const doc = db
      .prepare(
        "SELECT id, doc_type, doc_date, sha256, text_path, file_path, parsed_ok FROM documents WHERE id = ?",
      )
      .get(row.source_document_id) as DocRow | undefined;
    if (doc) {
      document = {
        id: doc.id,
        docType: doc.doc_type,
        docDate: doc.doc_date,
        sha256: doc.sha256,
        textPath: doc.text_path,
        filePath: doc.file_path,
        parsedOk: doc.parsed_ok === 1,
      };
    }
  }

  return {
    found: true,
    table,
    id,
    sourceLocator: row.source_locator,
    document,
  };
}
