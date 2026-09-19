// The identifier detector and the sinks that use it. No database.
//
// Read migration 029 and `src/sensitivity/identifiers.ts` first for why this
// exists at all: it does NOT protect the owner from his own data. Detection is
// used only to keep identifiers out of logs, error strings and feed payloads.
// The last test in this file is the one that pins that down.
//
// Every value here is invented. The SSNs are in the 900-xx and test ranges or
// are the `123-45-6789` fixture; the card numbers are the published test PANs
// every payment library ships with; the routing numbers are constructed to
// satisfy the ABA check. Nothing in this file is a real person's anything.

import assert from "node:assert/strict";
import test from "node:test";

import {
  abaValid,
  containsIdentifier,
  findIdentifiers,
  luhnValid,
  scrubErrorMessage,
  scrubFeedPayload,
  scrubIdentifiers,
  scrubJobError,
  scrubLogFields,
  scrubLogText,
  scrubOutbound,
} from "../dist/sensitivity/index.js";

/** The kinds found in a string, in order. */
function kinds(text) {
  return findIdentifiers(text).map((match) => match.kind);
}

test("checksums are the real thing, not an approximation", () => {
  // Published test PANs. Every one passes Luhn by construction.
  assert.equal(luhnValid("4111111111111111"), true);
  assert.equal(luhnValid("5555555555554444"), true);
  assert.equal(luhnValid("378282246310005"), true);
  // One digit changed breaks it, which is the whole point of a check digit.
  assert.equal(luhnValid("4111111111111112"), false);

  // 011000015 is the published Federal Reserve Bank of New York routing
  // number and is the canonical ABA example.
  assert.equal(abaValid("011000015"), true);
  assert.equal(abaValid("011000016"), false);
  assert.equal(abaValid("12345678"), false, "eight digits is not a routing number");
});

test("a dashed SSN is found without a label, and only when it is valid", () => {
  assert.deepEqual(kinds("Employee 123-45-6789 filed on time"), ["ssn"]);
  // The SSA's never-issued ranges. A document printing one of these is using a
  // placeholder, and mangling it would be pure noise.
  assert.deepEqual(kinds("Ref 000-00-0000"), []);
  assert.deepEqual(kinds("Ref 666-12-3456"), []);
  assert.deepEqual(kinds("Ref 123-00-4567"), [], "group 00 is never issued");
  assert.deepEqual(kinds("Ref 123-45-0000"), [], "serial 0000 is never issued");
});

test("an ITIN is recognized in the 9xx space a valid SSN cannot use", () => {
  // Area 9xx with an assigned group: an ITIN, reported as `ssn`'s sibling.
  assert.deepEqual(kinds("ITIN 900-70-0000".replace("0000", "1234")), ["ssn"]);
  // 9xx with an unassigned group is neither, and is left alone.
  assert.deepEqual(kinds("Ref 900-01-2345"), []);
});

test("NEAR MISS: an invoice number that looks like an SSN is left alone", () => {
  // The case the owner named. Nine digits, no dashes, no label: this is an
  // order number and it must survive untouched, in a log line as anywhere.
  const line = "Invoice 123456789 for order 987654321 shipped";
  assert.deepEqual(kinds(line), []);
  assert.equal(scrubLogText(line), line);
});

test("nine digits DO match once a label governs them", () => {
  assert.deepEqual(kinds("SSN: 123456789"), ["ssn"]);
  assert.deepEqual(kinds("Social Security Number 123456789"), ["ssn"]);
  // The label has to be near. A label two sentences back does not reach.
  const far = `SSN on file.${" ".repeat(60)}Reference 123456789`;
  assert.deepEqual(kinds(far), []);
});

test("a payment card needs Luhn AND a real issuer prefix", () => {
  assert.deepEqual(kinds("Paid with 4111 1111 1111 1111"), ["payment_card"]);
  assert.deepEqual(kinds("Amex 378282246310005"), ["payment_card"]);
  // NEAR MISS: sixteen digits that happen to pass Luhn but start with 9,
  // which no scheme issues. An order number of this shape must survive.
  const notACard = "9999999999999995";
  assert.equal(luhnValid(notACard), true, "fixture must actually pass Luhn");
  assert.deepEqual(kinds(`Order ${notACard} dispatched`), []);
});

test("a routing number needs the ABA check AND a Federal Reserve prefix", () => {
  assert.deepEqual(kinds("Routing 011000015"), ["routing_number"]);
  // NEAR MISS: passes the ABA weighted sum but starts 99, which is not an
  // assigned range, and carries no label. Left alone.
  const stray = "994829135";
  assert.equal(abaValid(stray), true, "fixture must actually pass the ABA check");
  assert.deepEqual(kinds(`Meter reading ${stray}`), []);
});

test("EIN, passport, licence and date of birth are label-only", () => {
  assert.deepEqual(kinds("EIN 12-3456789"), ["ein"]);
  // NEAR MISS: the same shape as a part number, with no label.
  assert.deepEqual(kinds("Part 12-3456789 in stock"), []);

  assert.deepEqual(kinds("Passport X1234567"), ["passport"]);
  assert.deepEqual(kinds("Model X1234567 recalled"), []);

  assert.deepEqual(kinds("Date of birth 1970-01-01"), ["date_of_birth"]);
  // An ordinary date in an ordinary sentence is not a birth date.
  assert.deepEqual(kinds("Filed on 1970-01-01"), []);
});

test("masking keeps the last four, and a birth date keeps nothing", () => {
  assert.equal(scrubIdentifiers("SSN 123-45-6789 on file"), "SSN ••••6789 on file");
  assert.equal(
    scrubIdentifiers("Paid with 4111 1111 1111 1111"),
    "Paid with ••••1111",
  );
  // The birth year is the identifying half, so nothing is kept.
  assert.equal(
    scrubIdentifiers("Date of birth 1970-01-01"),
    "Date of birth ••••",
  );
});

test("overlapping candidates resolve to one match, not to their parts", () => {
  // Sixteen digits are also shorter digit runs. The card must mask as a card.
  const masked = scrubIdentifiers("Card 4111111111111111 charged");
  assert.equal(masked, "Card ••••1111 charged");
  assert.equal(containsIdentifier(masked), false, "masking must be idempotent");
});

test("text with no identifier is returned unchanged, by identity", () => {
  const clean = "Invoice 4472 for $1,204.55 paid 2026-03-02 by ACH";
  assert.equal(scrubLogText(clean), clean);
  assert.equal(scrubIdentifiers(clean), clean);
});

// ---------------------------------------------------------------------------
// One test per sink
// ---------------------------------------------------------------------------

test("sink: a log line is scrubbed", () => {
  assert.equal(
    scrubLogText("parse failed near SSN 123-45-6789"),
    "parse failed near SSN ••••6789",
  );
});

test("sink: a structured log record's strings are scrubbed, others passed", () => {
  const scrubbed = scrubLogFields({
    tool: "get_document",
    name: "Error",
    message: "invalid input near SSN 123-45-6789",
    attempt: 2,
    fatal: false,
  });
  assert.equal(scrubbed.message, "invalid input near SSN ••••6789");
  assert.equal(scrubbed.tool, "get_document");
  assert.equal(scrubbed.attempt, 2, "non-strings pass through untouched");
  assert.equal(scrubbed.fatal, false);
});

test("sink: an error message handed to a client is scrubbed", () => {
  assert.equal(
    scrubErrorMessage('duplicate key value "123-45-6789"'),
    'duplicate key value "••••6789"',
  );
});

test("sink: a job's last_error is scrubbed and still bounded", () => {
  assert.equal(
    scrubJobError("extraction failed on SSN 123-45-6789"),
    "extraction failed on SSN ••••6789",
  );
  // The 2000-character bound the deferred runner used to apply inline.
  const long = scrubJobError("x".repeat(5_000));
  assert.equal(long.length, 2_001, "bounded to 2000 characters plus an ellipsis");
  assert.ok(long.endsWith("…"));
});

test("sink: a change-feed payload's strings are scrubbed", () => {
  const scrubbed = scrubFeedPayload({
    table: "documents",
    rowId: "doc-1",
    note: "row for SSN 123-45-6789",
  });
  assert.equal(scrubbed.note, "row for SSN ••••6789");
  assert.equal(scrubbed.table, "documents");
});

test("sink: outbound text is scrubbed", () => {
  assert.equal(
    scrubOutbound("alert: card 4111111111111111"),
    "alert: card ••••1111",
  );
});

test("the scrubber is never wired to stored values or tool results", async () => {
  // The guard for this whole feature's most important property, and the reason
  // it is a test rather than a comment: the owner reads his own data in full,
  // so `scrubIdentifiers` must appear only in the sinks module and in the
  // detector that defines it. If a future change masks an extraction value, a
  // page of text or an MCP result, this fails and says why.
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const root = new URL("../src/", import.meta.url).pathname;
  const allowed = new Set([
    join(root, "sensitivity/identifiers.ts"),
    join(root, "sensitivity/sinks.ts"),
  ]);

  async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(path);
      else if (entry.name.endsWith(".ts")) yield path;
    }
  }

  const offenders = [];
  for await (const path of walk(root)) {
    if (allowed.has(path)) continue;
    const source = await readFile(path, "utf8");
    if (/\bscrubIdentifiers\s*\(/.test(source)) offenders.push(path);
  }
  assert.deepEqual(
    offenders,
    [],
    "scrubIdentifiers may only be called from sensitivity/sinks.ts; the owner's own reads are never masked",
  );
});
