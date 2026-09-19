// The one-time import of the owner's investments spreadsheet.
//
// No Google API and no upload: the operator exports the two tabs as CSV and
// the browser reads them. `Summary` becomes investments (and one `commitment`
// entry each), `Ledger` becomes entries.
//
// CSV rather than xlsx. The repo's xlsx reader
// (`packages/pipeline/src/spreadsheet.ts`) is a Node module built on
// `node:zlib` and `node:crypto`, so it cannot run in the browser, and running
// it in a route would mean adding `@repo/pipeline` to the web app and posting
// the whole workbook to the server before the operator has seen a preview. Two
// "Save as CSV" clicks cost less than either.
//
// Everything here is pure: parse, map, reconcile. The screen renders what
// these return and posts what the operator approves, so the rules below can be
// tested without a DOM, a network or a database -- which matters, because they
// are rules about the owner's money.

/** ---------------------------------------------------------------------------
 * The sign and currency rule, stated once. The preview shows this text, so the
 * operator is reading the same sentence the code is applying.
 * ------------------------------------------------------------------------- */
export const IMPORT_RULE =
  "Ledger: a negative Amount is money out (capital call paid), a positive Amount is money in (distribution). " +
  "A value in the GBP column means the entry is in GBP and that column is its amount, with Exchange Rate converting it to USD; " +
  "otherwise the entry is in USD. Every type can be changed per row before importing.";

export type LedgerDraft = {
  /** Stable across imports of the same file. The store's unique index makes a
   * second import of this row a no-op rather than a duplicate. */
  importKey: string;
  investmentName: string;
  entryType: "capital_call_paid" | "distribution";
  entryDate: string;
  amount: string;
  currency: string;
  exchangeRate: string | null;
  note: string | null;
  /** Which branch of the rule produced the type, for the preview. */
  why: string;
};

export type SummaryDraft = {
  importKey: string;
  name: string;
  category: string | null;
  signedOn: string | null;
  status: "active" | "closed" | "written_off";
  notes: string | null;
  /** The commitment entry the Summary row becomes, if it states one. */
  committed: string | null;
  /** The Summary's own figures, kept only to reconcile against the Ledger. */
  statedSent: string | null;
  statedReceived: string | null;
};

export type SkippedRow = { line: number; raw: string; reason: string };

export type Reconciliation = {
  investmentName: string;
  field: "sent" | "received";
  stated: string;
  imported: string;
  difference: string;
};

export type ImportPreview = {
  summary: SummaryDraft[];
  ledger: LedgerDraft[];
  skipped: SkippedRow[];
  reconciliation: Reconciliation[];
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 enough for a spreadsheet export: quoted fields, doubled quotes
 * inside them, and newlines inside quotes. Written out rather than depended on
 * because it is twenty lines and a CSV dependency is not.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A leading byte-order mark would otherwise become part of the first header.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** Header-keyed rows. Headers are matched case- and space-insensitively,
 * because a person's spreadsheet says "Docs Signed" one year and "docs signed"
 * the next. */
export function keyed(rows: string[][]): Record<string, string>[] {
  const [header, ...body] = rows;
  if (header === undefined) return [];
  const keys = header.map((cell) => cell.trim().toLowerCase());
  return body.map((cells) => {
    const record: Record<string, string> = {};
    keys.forEach((key, index) => {
      record[key] = (cells[index] ?? "").trim();
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * A spreadsheet money cell as an exact decimal string and a sign.
 *
 * `$1,234.50`, `(1,234.50)`, `-1234.5` and `1234.50` all parse. The magnitude
 * is returned separately from the sign because an entry's direction is its
 * type, never a negative amount. `null` means the cell holds no number, which
 * is a skip rather than a zero: a blank Sent column is "not stated", and
 * importing it as 0.00 would make the reconciliation agree with a figure the
 * sheet never gave.
 */
export function parseMoney(
  value: string | undefined,
): { amount: string; negative: boolean } | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-") return null;
  const parenthesised = /^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[()$£€,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return null;
  const negative = parenthesised || digits.startsWith("-");
  const magnitude = digits.replace(/^-/, "");
  // Two decimal places, exactly, so `1234.5` and `1234.50` produce one key and
  // one amount rather than two that look equal and are not.
  const [whole = "0", fraction = ""] = magnitude.split(".");
  return { amount: `${whole}.${`${fraction}00`.slice(0, 2)}`, negative };
}

/** A rate cell. Unlike money it keeps its precision: 1.2734 is not 1.27. */
export function parseRate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const digits = value.trim().replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits) || Number(digits) <= 0) return null;
  return digits;
}

/**
 * A spreadsheet date cell as `YYYY-MM-DD`.
 *
 * ISO first, then the `M/D/YYYY` a US-locale export produces. Anything else is
 * a skipped row with a reason rather than a guess: `3/4/2024` is ambiguous
 * across locales and the only safe reading of an unrecognised date is to say
 * so.
 */
export function parseSheetDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slashed) {
    const month = slashed[1]!.padStart(2, "0");
    const day = slashed[2]!.padStart(2, "0");
    return `${slashed[3]}-${month}-${day}`;
  }
  return null;
}

/** Exact decimal addition, in integer cents. `0.1 + 0.2` is the reason this is
 * not `Number` arithmetic: the reconciliation exists to find differences, and
 * a difference it invented would be worse than not reconciling at all. */
export function addDecimals(values: readonly string[]): string {
  let cents = 0n;
  for (const value of values) {
    // The sign is read once and applied to the whole amount. Reading it off
    // `whole` alone makes `-12345.67` come out as -12345 + 0.67, which is the
    // kind of error a reconciliation exists to find, not to produce.
    const negative = value.startsWith("-");
    const [whole = "0", fraction = ""] = value.replace(/^[-+]/, "").split(".");
    const magnitude =
      BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
    cents += negative ? -magnitude : magnitude;
  }
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const text = `${absolute / 100n}.${`${absolute % 100n}`.padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

function subtractDecimals(left: string, right: string): string {
  return addDecimals([left, right.startsWith("-") ? right.slice(1) : `-${right}`]);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const STATUS_BY_LABEL: Record<string, SummaryDraft["status"]> = {
  active: "active",
  open: "active",
  closed: "closed",
  exited: "closed",
  "written off": "written_off",
  "write-off": "written_off",
};

/** `Summary` rows to investments. A row with no Investment name is skipped. */
export function mapSummary(
  rows: readonly Record<string, string>[],
): { drafts: SummaryDraft[]; skipped: SkippedRow[] } {
  const drafts: SummaryDraft[] = [];
  const skipped: SkippedRow[] = [];
  rows.forEach((record, index) => {
    const line = index + 2;
    const name = (record.investment ?? "").trim();
    if (name === "") {
      skipped.push({
        line,
        raw: Object.values(record).join(","),
        reason: "No investment name",
      });
      return;
    }
    const committed = parseMoney(record.committed);
    const sent = parseMoney(record.sent);
    const received = parseMoney(record.received);
    const statusLabel = (record.status ?? "").trim().toLowerCase();
    // The two free-text columns are one note: they are the owner's comments on
    // the same row and nothing downstream reads them apart.
    const notes = Object.entries(record)
      .filter(([key]) => key.startsWith("comment"))
      .map(([, value]) => value.trim())
      .filter(Boolean)
      .join(" — ");
    drafts.push({
      importKey: `summary:${name.toLowerCase()}`,
      name,
      category: (record.category ?? "").trim() || null,
      signedOn: parseSheetDate(record["docs signed"]),
      status: STATUS_BY_LABEL[statusLabel] ?? "active",
      notes: notes || null,
      committed: committed === null ? null : committed.amount,
      statedSent: sent === null ? null : sent.amount,
      statedReceived: received === null ? null : received.amount,
    });
  });
  return { drafts, skipped };
}

/** `Ledger` rows to entries, applying IMPORT_RULE. */
export function mapLedger(
  rows: readonly Record<string, string>[],
): { drafts: LedgerDraft[]; skipped: SkippedRow[] } {
  const drafts: LedgerDraft[] = [];
  const skipped: SkippedRow[] = [];
  rows.forEach((record, index) => {
    const line = index + 2;
    const raw = Object.values(record).join(",");
    const investmentName = (record.investment ?? "").trim();
    const entryDate = parseSheetDate(record.date);
    const usd = parseMoney(record.amount);
    const gbp = parseMoney(record.gbp);
    const rate = parseRate(record["exchange rate"]);
    if (investmentName === "") {
      skipped.push({ line, raw, reason: "No investment name" });
      return;
    }
    if (entryDate === null) {
      skipped.push({ line, raw, reason: "Date is blank or unrecognised" });
      return;
    }
    if (usd === null && gbp === null) {
      skipped.push({ line, raw, reason: "No amount" });
      return;
    }
    // The sign lives on whichever column carries the amount; the GBP column
    // decides the currency. A GBP row with no rate cannot be converted, so it
    // is a skip with a reason rather than an entry the schema would refuse.
    const signed = gbp ?? usd!;
    const entryType = signed.negative ? "capital_call_paid" : "distribution";
    if (gbp !== null && rate === null) {
      skipped.push({ line, raw, reason: "GBP amount with no exchange rate" });
      return;
    }
    drafts.push({
      importKey: `ledger:${investmentName.toLowerCase()}:${entryDate}:${
        gbp === null ? "USD" : "GBP"
      }:${signed.negative ? "-" : ""}${signed.amount}`,
      investmentName,
      entryType,
      entryDate,
      amount: signed.amount,
      currency: gbp === null ? "USD" : "GBP",
      exchangeRate: gbp === null ? null : rate,
      note: (record.comment ?? "").trim() || null,
      why:
        `${signed.negative ? "negative" : "positive"} ` +
        `${gbp === null ? "Amount" : "GBP"} → ${entryType}`,
    });
  });
  return { drafts, skipped };
}

/**
 * Where the Ledger and the Summary disagree.
 *
 * Neither is trusted over the other: the preview reports the difference and
 * the operator decides. Silence here would mean importing a Sent total the
 * entries do not add up to, and the screen would then show a number the owner
 * cannot reconstruct from its own rows.
 *
 * Only USD entries are compared, because the Summary's Sent and Received
 * columns are single figures with no currency of their own. A GBP entry is
 * reported as an unmatched difference rather than converted with a rate the
 * Summary never stated.
 */
export function reconcile(
  summary: readonly SummaryDraft[],
  ledger: readonly LedgerDraft[],
): Reconciliation[] {
  const differences: Reconciliation[] = [];
  for (const investment of summary) {
    const mine = ledger.filter(
      (entry) =>
        entry.investmentName.toLowerCase() === investment.name.toLowerCase() &&
        entry.currency === "USD",
    );
    const totals = {
      sent: addDecimals(
        mine
          .filter((entry) => entry.entryType === "capital_call_paid")
          .map((entry) => entry.amount),
      ),
      received: addDecimals(
        mine
          .filter((entry) => entry.entryType === "distribution")
          .map((entry) => entry.amount),
      ),
    };
    const stated = {
      sent: investment.statedSent,
      received: investment.statedReceived,
    };
    for (const field of ["sent", "received"] as const) {
      const claim = stated[field];
      if (claim === null) continue;
      const difference = subtractDecimals(claim, totals[field]);
      if (difference !== "0.00") {
        differences.push({
          investmentName: investment.name,
          field,
          stated: claim,
          imported: totals[field],
          difference,
        });
      }
    }
  }
  return differences;
}

/** The whole preview from the two files' text. */
export function buildPreview(
  summaryCsv: string,
  ledgerCsv: string,
): ImportPreview {
  const summary = mapSummary(keyed(parseCsv(summaryCsv)));
  const ledger = mapLedger(keyed(parseCsv(ledgerCsv)));
  return {
    summary: summary.drafts,
    ledger: ledger.drafts,
    skipped: [...summary.skipped, ...ledger.skipped],
    reconciliation: reconcile(summary.drafts, ledger.drafts),
  };
}
