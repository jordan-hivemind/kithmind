// The one place that decides what an identifier is.
//
// WHAT THIS IS FOR, AND WHAT IT MUST NEVER TOUCH
//
// The owner's decision on 2026-09-19 (migration 032's header quotes it) is that
// his own data reaches him and the assistants he connects, in full. So this
// detector is NOT used to mask stored values, extraction results, or MCP tool
// results. An SSN a document states is stored as the document states it and is
// returned in full when asked for. If you are about to call `maskIdentifiers`
// on a value, a tool result, an observation or a page of text, stop: that is
// the design the owner rejected.
//
// What it is for is the opposite problem -- identifiers ending up in the places
// the owner never looks and other people might. Server logs shipped to a host.
// An error string handed to a connected client. A change-feed payload. A
// deferred-work row's `last_error`. These are not the archive; they are
// incidental copies made by machinery, they are read by whoever can read a log
// aggregator, and nobody chose to put an SSN in them. `scrubForLog` below is
// the function those sinks call, and `sinks.ts` is where they call it.
//
// WHAT IS MATCHED, AND WHAT KEEPS EACH MATCH HONEST
//
// Because a scrubbed log line is still meant to be diagnosable, the detector
// cannot simply blank every number it sees. Every pattern below earns its match
// in one of three ways, and a candidate that earns it in none is left alone:
//
//   a checksum      A payment card must pass Luhn *and* start with a real
//                   issuer prefix at that issuer's length. A routing number
//                   must pass the ABA weighted check *and* start in a real
//                   Federal Reserve range. Luhn alone is a one-in-ten accident
//                   on any 16-digit order number, which is why neither test
//                   stands by itself here.
//
//   a label         An undelimited run of digits is matched only when a label
//                   sits within `LABEL_WINDOW` characters before it: "SSN",
//                   "Account Number", "Routing", "Passport", "Date of Birth".
//                   This is the invoice-number control: a bare `123456789` in
//                   a log line about order numbers is not an SSN here.
//
//   a delimiter     `123-45-6789` is matched without a label, because 3-2-4
//                   dash grouping is an SSN's own notation rather than how
//                   invoice or order numbers are written. The digits must still
//                   be a valid SSN (no 000/666/9xx area, no 00 group, no 0000
//                   serial) or a valid ITIN, so `000-00-0000` is left alone.
//
// EIN is label-only for the same reason: `12-3456789` has no checksum and is a
// plausible invoice number. Passport, driver licence and date of birth are
// label-only because their shapes are nothing but "some letters and digits" and
// "a date", which would otherwise match half of every log file.
//
// Masking keeps the last four, which is the notation the app already uses
// (`maskedLabel` in apps/web/src/lib/kith/institutions.ts): enough to correlate
// two log lines about the same account while debugging, never enough to use the
// account. A date of birth masks whole, because its last four characters are
// the birth year and the year is the identifying half.

/** The closed set. A new kind is a change here and nowhere else. */
export const IDENTIFIER_KINDS = [
  "ssn",
  "itin",
  "ein",
  "routing_number",
  "account_number",
  "payment_card",
  "passport",
  "drivers_license",
  "date_of_birth",
] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export type IdentifierMatch = {
  kind: IdentifierKind;
  /** Index into the text that was scanned. */
  start: number;
  end: number;
  /** The identifier exactly as the text writes it, delimiters included. */
  text: string;
  /** The last four alphanumerics, or "" for a kind that masks whole. */
  last4: string;
};

/** How far back a label may sit and still govern the digits after it. Wide
 * enough for "Employee's social security number" and a column of whitespace in
 * a table, narrow enough that the previous row's label does not reach. */
const LABEL_WINDOW = 48;

/**
 * What may sit between a label and the digits it governs.
 *
 * A form does not write "SSN123456789"; it writes "Social Security Number",
 * then a colon, then a column of whitespace. So after the label itself this
 * allows a few qualifier words ("number", "no.", "#", "is") and then only
 * non-alphanumeric filler. Filler alone is not enough -- an intervening WORD
 * that is not one of the qualifiers ends the label's reach, which is what
 * stops "SSN on file. Reference 123456789" from labelling the reference.
 */
const LABEL_TAIL =
  "(?:\\s*(?:number|numbers|no|num|nbr|#|is|of|the|for)\\.?)*[^A-Za-z0-9]{0,24}$";

/** Each kind's label core; the shared tail is appended by `labelPattern`. */
const LABEL_CORES: Record<IdentifierKind, string> = {
  // "Taxpayer identification number" and a bare "TIN" cover a form that does
  // not say which of SSN and ITIN it wants.
  ssn: "\\bssn\\b|\\bssa\\b|social\\s+security|\\btaxpayer\\s+identif\\w*|\\btin\\b|\\bs\\.s\\.",
  itin: "\\bitin\\b|individual\\s+taxpayer|\\btaxpayer\\s+identif\\w*|\\btin\\b",
  ein: "\\bein\\b|employer\\s+identif\\w*|employer'?s?\\s+id\\b|federal\\s+(?:id|tax\\s+id)",
  routing_number: "\\brouting\\b|\\baba\\b|\\brtn\\b|\\btransit\\b",
  account_number: "\\bacct\\b|\\baccount\\b|\\bdda\\b|\\biban\\b",
  payment_card:
    "\\bcard\\b|\\bcredit\\s+card|\\bdebit\\s+card|\\bpan\\b|\\bvisa\\b|\\bmastercard\\b|\\bamex\\b",
  passport: "\\bpassport\\b",
  drivers_license:
    "\\bdriver'?s?\\s+lic\\w*|\\bdl\\b|\\blicen[cs]e\\b|\\bdln\\b",
  date_of_birth:
    "\\bdate\\s+of\\s+birth|\\bd\\.?o\\.?b\\.?\\b|\\bbirth\\s*date|\\bborn\\s+on",
};

const LABELS: Record<IdentifierKind, RegExp> = Object.fromEntries(
  Object.entries(LABEL_CORES).map(([kind, core]) => [
    kind,
    new RegExp(`(?:${core})${LABEL_TAIL}`, "i"),
  ]),
) as Record<IdentifierKind, RegExp>;

/** Whether this kind's label governs the text ending at `start`. */
function labelled(text: string, start: number, kind: IdentifierKind): boolean {
  const from = start < LABEL_WINDOW ? 0 : start - LABEL_WINDOW;
  return LABELS[kind].test(text.slice(from, start));
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/** Luhn, as every card scheme's check digit is defined. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const ABA_WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7, 1] as const;

/** The ABA weighted-sum check on a nine-digit routing number. */
export function abaValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    sum += (digits.charCodeAt(index) - 48) * ABA_WEIGHTS[index]!;
  }
  return sum % 10 === 0;
}

/**
 * A real Federal Reserve routing prefix.
 *
 * The checksum alone passes one nine-digit number in ten, so a nine-digit
 * quantity on a statement would trip it regularly. The prefix ranges are the
 * assigned ones: 01-12 primary, 21-32 thrift, 61-72 electronic, 80 traveller's
 * cheque.
 */
function routingPrefixValid(digits: string): boolean {
  const prefix = Number(digits.slice(0, 2));
  return (
    (prefix >= 1 && prefix <= 12) ||
    (prefix >= 21 && prefix <= 32) ||
    (prefix >= 61 && prefix <= 72) ||
    prefix === 80
  );
}

/** Issuer prefix and length together, so Luhn is never the only evidence. */
function cardIssuerValid(digits: string): boolean {
  const length = digits.length;
  if (/^4/.test(digits)) return length === 13 || length === 16 || length === 19;
  if (/^3[47]/.test(digits)) return length === 15;
  if (/^(5[1-5]|2(22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(digits)) {
    return length === 16;
  }
  if (/^(6011|65|64[4-9]|622(12[6-9]|1[3-9]\d|[2-8]\d\d|91[0-9]|92[0-5]))/.test(digits)) {
    return length === 16 || length === 19;
  }
  if (/^35(2[89]|[3-8]\d)/.test(digits)) return length === 16;
  if (/^3(0[0-5]|[68])/.test(digits)) return length === 14;
  return false;
}

/**
 * A valid SSN's own rules. The SSA has never issued an area of 000, 666 or
 * 900-999, a group of 00 or a serial of 0000, so a number printing one of those
 * is a placeholder or a coincidence rather than someone's SSN. This is what
 * keeps `000-00-0000` and the `123-45-6789` style test values out of the way of
 * a real one -- except that `123-45-6789` is itself valid by these rules, which
 * is why it is the number every test fixture uses and why it is matched.
 */
function ssnValid(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  if (area === "000" || area === "666" || area[0] === "9") return false;
  return group !== "00" && serial !== "0000";
}

/**
 * ITIN: area 900-999, and a group the IRS actually assigns. The assigned
 * ranges are 50-65, 70-88, 90-92 and 94-99; everything else in the 9xx space is
 * unassigned and is left alone.
 */
function itinValid(digits: string): boolean {
  if (!/^9\d{8}$/.test(digits)) return false;
  const group = Number(digits.slice(3, 5));
  return (
    (group >= 50 && group <= 65) ||
    (group >= 70 && group <= 88) ||
    (group >= 90 && group <= 92) ||
    (group >= 94 && group <= 99)
  );
}

type Candidate = {
  kind: IdentifierKind;
  start: number;
  end: number;
  text: string;
  /** Whether this candidate stands on its own evidence (checksum or the SSN
   * dash notation) or needs its label. */
  selfEvident: boolean;
};

/** Every scanner: a pattern, and the test that decides whether a hit is real. */
const SCANNERS: ReadonlyArray<{
  kind: IdentifierKind;
  pattern: RegExp;
  accept(raw: string): { ok: boolean; selfEvident: boolean };
}> = [
  // Dashed or spaced 3-2-4. An SSN's own notation, so no label is required --
  // see the header on why this one pattern is allowed to stand alone.
  {
    kind: "ssn",
    pattern: /\b\d{3}[-– ]\d{2}[-– ]\d{4}\b/g,
    accept: (raw) => {
      const digits = digitsOf(raw);
      if (itinValid(digits)) return { ok: true, selfEvident: true };
      return { ok: ssnValid(digits), selfEvident: true };
    },
  },
  // The same nine digits undelimited. Only next to a label: this is exactly the
  // shape an invoice or order number takes.
  {
    kind: "ssn",
    pattern: /\b\d{9}\b/g,
    accept: (raw) => ({
      ok: ssnValid(raw) || itinValid(raw),
      selfEvident: false,
    }),
  },
  {
    kind: "ein",
    pattern: /\b\d{2}[-– ]\d{7}\b/g,
    accept: () => ({ ok: true, selfEvident: false }),
  },
  {
    kind: "routing_number",
    pattern: /\b\d{9}\b/g,
    accept: (raw) => {
      // A label is ALWAYS required, even with a valid checksum and a real
      // Federal Reserve prefix. Those two together still admit roughly one
      // unlabelled nine-digit reference number in twenty-five: the checksum
      // passes one in ten, and the assigned prefix ranges cover about a third
      // of the leading pairs. That is frequent enough to muddy the diagnostics
      // these log lines exist for, and a real routing number is virtually
      // always printed next to the word, so requiring it costs almost nothing
      // and buys back the false positives.
      if (!abaValid(raw)) return { ok: false, selfEvident: false };
      if (!routingPrefixValid(raw)) return { ok: false, selfEvident: false };
      return { ok: true, selfEvident: false };
    },
  },
  {
    kind: "payment_card",
    pattern: /\b\d(?:[ -]?\d){11,18}\b/g,
    accept: (raw) => {
      const digits = digitsOf(raw);
      if (!luhnValid(digits)) return { ok: false, selfEvident: false };
      return { ok: true, selfEvident: cardIssuerValid(digits) };
    },
  },
  // Label-only from here down: these shapes are too generic to stand alone.
  {
    kind: "account_number",
    pattern: /\b[A-Z0-9][A-Z0-9-]{5,20}\b/gi,
    accept: (raw) => ({
      ok: digitsOf(raw).length >= 5,
      selfEvident: false,
    }),
  },
  {
    kind: "passport",
    pattern: /\b[A-Z0-9]{6,9}\b/gi,
    accept: (raw) => ({ ok: /\d/.test(raw), selfEvident: false }),
  },
  {
    kind: "drivers_license",
    pattern: /\b[A-Z0-9][A-Z0-9-]{4,19}\b/gi,
    accept: (raw) => ({ ok: /\d/.test(raw), selfEvident: false }),
  },
  {
    kind: "date_of_birth",
    pattern:
      /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi,
    accept: () => ({ ok: true, selfEvident: false }),
  },
];

/** Kinds whose mask keeps nothing at all. */
const MASK_WHOLE: ReadonlySet<IdentifierKind> = new Set(["date_of_birth"]);

function lastFour(kind: IdentifierKind, text: string): string {
  if (MASK_WHOLE.has(kind)) return "";
  const alphanumeric = text.replace(/[^A-Za-z0-9]/g, "");
  return alphanumeric.slice(-4);
}

/**
 * Every identifier in `text`, left to right and never overlapping.
 *
 * Overlaps are real: nine digits can be both a candidate SSN and a candidate
 * routing number, and a card number contains shorter runs. The resolution is
 * longest-match-wins at a given start, then first-start-wins, which is what
 * makes a 16-digit card mask as one card rather than as its parts.
 */
export function findIdentifiers(text: string): IdentifierMatch[] {
  if (!text) return [];
  const candidates: Candidate[] = [];
  for (const scanner of SCANNERS) {
    // A fresh regex per scan: `lastIndex` on a shared global regex is the
    // classic way a second call silently skips the first half of its input.
    const pattern = new RegExp(scanner.pattern.source, scanner.pattern.flags);
    for (const found of text.matchAll(pattern)) {
      const raw = found[0];
      const start = found.index;
      if (start === undefined) continue;
      const verdict = scanner.accept(
        scanner.kind === "ssn" || scanner.kind === "routing_number"
          ? digitsOf(raw)
          : raw,
      );
      if (!verdict.ok) continue;
      if (!verdict.selfEvident && !labelled(text, start, scanner.kind)) continue;
      candidates.push({
        kind: scanner.kind,
        start,
        end: start + raw.length,
        text: raw,
        selfEvident: verdict.selfEvident,
      });
    }
  }
  candidates.sort((left, right) =>
    left.start !== right.start
      ? left.start - right.start
      : right.end - right.start - (left.end - left.start),
  );
  const matches: IdentifierMatch[] = [];
  let consumed = 0;
  for (const candidate of candidates) {
    if (candidate.start < consumed) continue;
    matches.push({
      kind: candidate.kind,
      start: candidate.start,
      end: candidate.end,
      text: candidate.text,
      last4: lastFour(candidate.kind, candidate.text),
    });
    consumed = candidate.end;
  }
  return matches;
}

/** Whether this text carries an identifier at all. */
export function containsIdentifier(text: string): boolean {
  return findIdentifiers(text).length > 0;
}

/** The app's existing notation for a masked identifier (`maskedLabel`). */
export function maskedForm(match: IdentifierMatch): string {
  return match.last4 ? `••••${match.last4}` : "••••";
}

/**
 * The same text with every identifier masked.
 *
 * The ONLY legitimate callers are the log, error and feed sinks in `sinks.ts`.
 * It must never be applied to a stored value, an extraction result, a page of
 * text or an MCP tool result -- see this file's header. It is exported rather
 * than kept private because the sinks live in another module and because the
 * tests exercise it directly, not as an invitation to mask anything else.
 */
export function scrubIdentifiers(text: string): string {
  const matches = findIdentifiers(text);
  if (matches.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start) + maskedForm(match);
    cursor = match.end;
  }
  return out + text.slice(cursor);
}
