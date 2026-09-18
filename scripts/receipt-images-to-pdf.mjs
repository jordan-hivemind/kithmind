#!/usr/bin/env node
// Normalize scanned or photographed receipts into the PDF lane.
//
// Intake admits PDF and xlsx only (`BINARY_CLASSES` in
// packages/worker-protocol/src/index.ts). A paper receipt photographed with a
// phone therefore arrives as a jpg/png/heic and is inventoried but never
// parsed. Rather than open a second binary class with its own media type,
// bounds and receipt rules, this turns the image into a one page PDF beside it
// and lets the existing `pdf_docqa_v1` lane do the rest: Docling already runs
// with `do_ocr: True` and RapidOCR, so an image-only page comes back as OCR
// text items with ordinary page provenance, exactly like a scanned PDF.
//
// The conversion is `sips`, which ships with macOS (the platform the worker
// already requires for `sandbox-exec`). It handles jpeg, png with alpha, heic
// and tiff, applies EXIF orientation, and its output is byte-for-byte
// reproducible for the same input. Writing a PDF wrapper by hand would mean
// parsing JPEG markers, PNG filters and EXIF for no gain.
//
// The original image is never modified or removed: the source file stays the
// backup. Re-running is safe, so this suits a folder action or a scheduled
// run over a Dropbox receipts inbox.
//
// ponytail: one page per image. A two page paper invoice becomes two
// documents, both ingested and both citable. Merging them into one PDF needs a
// PDF writer; add it only if reading them separately actually gets annoying.

import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

/** Extensions `sips` reliably converts, lowercased and with the dot. */
export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
]);

export class ReceiptImageCliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isReceiptImage(name) {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * The PDF an image normalizes to. The full original filename is kept and
 * `.pdf` appended, so `receipt.jpg` and `receipt.png` in one folder stay two
 * distinct documents instead of racing for `receipt.pdf`.
 */
export function pdfNameFor(name) {
  return `${basename(name)}.pdf`;
}

export function parseReceiptImageArgs(argv) {
  const args = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--force") {
      args.force = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--in" || flag === "--out") {
      if (!value || value.startsWith("--")) {
        throw new ReceiptImageCliError(
          "value_required",
          `${flag} requires a directory`,
        );
      }
      args[flag === "--in" ? "inDir" : "outDir"] = resolve(value);
      index += 1;
      continue;
    }
    throw new ReceiptImageCliError("flag_unknown", `unknown flag ${flag}`);
  }
  if (!args.inDir) {
    throw new ReceiptImageCliError("in_required", "--in requires a directory");
  }
  return { ...args, outDir: args.outDir ?? args.inDir };
}

/**
 * Decide what to convert. Pure, so the skip and collision rules are testable
 * without touching a disk or running `sips`.
 *
 * `existing` is the set of names already in the output directory, lowercased,
 * because the target names are compared case-insensitively.
 */
export function planConversions(names, existing, options) {
  const plan = [];
  const claimed = new Map();
  for (const name of [...names].sort()) {
    if (!isReceiptImage(name)) continue;
    const target = pdfNameFor(name);
    // macOS is case-insensitive by default, so `r.jpg` and `r.JPG` are one
    // output file even though they are two names. Compare folded, or the
    // second conversion silently overwrites the first.
    const key = target.toLowerCase();
    const earlier = claimed.get(key);
    if (earlier !== undefined) {
      throw new ReceiptImageCliError(
        "target_collision",
        `${name} and ${earlier} both normalize to ${target}`,
      );
    }
    claimed.set(key, name);
    plan.push({
      source: join(options.inDir, name),
      target: join(options.outDir, target),
      // Already normalized. Converting again would rewrite identical bytes,
      // but only after `sips` has re-read the image, so skipping keeps a
      // scheduled run over a growing folder cheap.
      skipped: existing.has(key) && !options.force,
    });
  }
  return plan;
}

// ponytail: `sips` decodes an untrusted image unsandboxed, as the user. The
// PDF parser it feeds runs under `sandbox-exec` precisely because parsing
// hostile bytes in native code is a real risk, and an image decoder is the
// same class of surface. Acceptable here because this is run by hand or on a
// schedule over the owner's own inbox, not by the watcher on arbitrary input.
// If this ever runs unattended on bytes from elsewhere, wrap it the way
// parserProcess.ts wraps the launcher.
function convert(source, target) {
  const result = spawnSync(
    "/usr/bin/sips",
    ["-s", "format", "pdf", source, "--out", target],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new ReceiptImageCliError(
      "convert_failed",
      `sips could not convert ${basename(source)}: ${(result.stderr ?? "").trim()}`,
    );
  }
}

export async function runReceiptImages(args, run = convert) {
  for (const directory of new Set([args.inDir, args.outDir])) {
    const found = await stat(directory).catch(() => null);
    if (!found?.isDirectory()) {
      throw new ReceiptImageCliError(
        "directory_missing",
        `${directory} is not a directory`,
      );
    }
  }
  const entries = await readdir(args.inDir, { withFileTypes: true });
  const existing = new Set(
    (args.outDir === args.inDir
      ? entries
      : await readdir(args.outDir, { withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name.toLowerCase()),
  );
  const plan = planConversions(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    existing,
    args,
  );
  let converted = 0;
  for (const item of plan) {
    if (item.skipped) continue;
    run(item.source, item.target);
    converted += 1;
  }
  return { found: plan.length, converted, skipped: plan.length - converted };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const summary = await runReceiptImages(
      parseReceiptImageArgs(process.argv.slice(2)),
    );
    console.log(JSON.stringify({ state: "complete", ...summary }));
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "failed",
        code: error instanceof ReceiptImageCliError ? error.code : "failed",
        detail: error.message,
      }),
    );
    process.exitCode = 1;
  }
}
