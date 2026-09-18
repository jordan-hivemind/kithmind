import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ReceiptImageCliError,
  isReceiptImage,
  parseReceiptImageArgs,
  pdfNameFor,
  planConversions,
  runReceiptImages,
} from "./receipt-images-to-pdf.mjs";

test("isReceiptImage accepts the phone formats and nothing else", () => {
  for (const name of ["a.jpg", "b.JPEG", "c.png", "d.HEIC", "e.tiff"]) {
    assert.equal(isReceiptImage(name), true, name);
  }
  for (const name of ["a.pdf", "b.xlsx", "c.txt", "d", "e.jpg.pdf"]) {
    assert.equal(isReceiptImage(name), false, name);
  }
});

test("pdfNameFor keeps the original extension so two images cannot collide", () => {
  assert.equal(pdfNameFor("receipt.jpg"), "receipt.jpg.pdf");
  assert.equal(pdfNameFor("receipt.png"), "receipt.png.pdf");
  assert.notEqual(pdfNameFor("receipt.jpg"), pdfNameFor("receipt.png"));
});

test("parseReceiptImageArgs requires --in and defaults --out to it", () => {
  const args = parseReceiptImageArgs(["--in", "/tmp/receipts"]);
  assert.equal(args.inDir, "/tmp/receipts");
  assert.equal(args.outDir, "/tmp/receipts");
  assert.equal(args.force, false);
  assert.throws(
    () => parseReceiptImageArgs([]),
    (error) =>
      error instanceof ReceiptImageCliError && error.code === "in_required",
  );
  assert.throws(
    () => parseReceiptImageArgs(["--in"]),
    (error) => error.code === "value_required",
  );
  assert.throws(
    () => parseReceiptImageArgs(["--in", "/tmp", "--wat"]),
    (error) => error.code === "flag_unknown",
  );
});

test("planConversions ignores non-images and skips what is already normalized", () => {
  const plan = planConversions(
    ["b.jpg", "a.png", "notes.txt", "statement.pdf", "a.png.pdf"],
    new Set(["a.png.pdf"]),
    { inDir: "/in", outDir: "/out", force: false },
  );
  assert.deepEqual(
    plan.map((item) => [item.source, item.target, item.skipped]),
    [
      ["/in/a.png", "/out/a.png.pdf", true],
      ["/in/b.jpg", "/out/b.jpg.pdf", false],
    ],
  );
});

test("planConversions reconverts an existing target under --force", () => {
  const plan = planConversions(["a.png"], new Set(["a.png.pdf"]), {
    inDir: "/in",
    outDir: "/in",
    force: true,
  });
  assert.equal(plan[0].skipped, false);
});

test("planConversions refuses two sources that claim one target", () => {
  assert.throws(
    () =>
      planConversions(["r.jpg", "r.JPG"], new Set(), {
        inDir: "/in",
        outDir: "/in",
        force: false,
      }),
    (error) =>
      error instanceof ReceiptImageCliError &&
      error.code === "target_collision",
  );
});

test("runReceiptImages converts each image once and leaves originals alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "receipt-images-"));
  await writeFile(join(directory, "van-service.jpg"), "not really a jpeg");
  await writeFile(join(directory, "notes.txt"), "ignored");
  const calls = [];
  const summary = await runReceiptImages(
    { inDir: directory, outDir: directory, force: false },
    (source, target) => {
      calls.push([source, target]);
      return writeFile(target, "%PDF-1.4\n");
    },
  );
  assert.deepEqual(summary, { found: 1, converted: 1, skipped: 0 });
  assert.deepEqual(calls, [
    [
      join(directory, "van-service.jpg"),
      join(directory, "van-service.jpg.pdf"),
    ],
  ]);
  const names = await readdir(directory);
  assert.equal(names.includes("van-service.jpg"), true);
  assert.equal(names.includes("notes.txt"), true);
});

test("runReceiptImages refuses a directory that is not there", async () => {
  await assert.rejects(
    runReceiptImages(
      {
        inDir: join(tmpdir(), "absent-receipts-dir"),
        outDir: tmpdir(),
        force: false,
      },
      () => {
        throw new Error("must not convert");
      },
    ),
    (error) =>
      error instanceof ReceiptImageCliError &&
      error.code === "directory_missing",
  );
});
