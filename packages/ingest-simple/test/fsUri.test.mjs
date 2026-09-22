// Synthetic-fixture unit tests for fsUri.ts's `toFsUri`: it must produce the
// exact `fs://<alias>/<percent-encoded path>` shape
// `apps/web/src/lib/kith/document-content.ts`'s `documentDropboxPath` parses
// back (`^fs:\/\/([^/]+)\/(.+)$`, then `decodeURIComponent` on the whole
// remainder) to serve the original file.

import assert from "node:assert/strict";
import test from "node:test";

import { toFsUri } from "../dist/fsUri.js";

test("toFsUri builds fs://<alias>/<relativePath> for a simple path", () => {
  assert.equal(toFsUri("dropbox-inbox", "statement.pdf"), "fs://dropbox-inbox/statement.pdf");
});

test("toFsUri percent-encodes each path segment", () => {
  assert.equal(
    toFsUri("dropbox", "Statements/2021 Q1/January Statement.pdf"),
    "fs://dropbox/Statements/2021%20Q1/January%20Statement.pdf",
  );
});

test("toFsUri round-trips through documentDropboxPath's own parse (fs://alias/... then decodeURIComponent)", () => {
  const uri = toFsUri("dropbox", "Taxes/2022/Form W-2 (Employer).pdf");
  const match = /^fs:\/\/([^/]+)\/(.+)$/.exec(uri);
  assert.ok(match, "uri did not match documentDropboxPath's own regex");
  assert.equal(match[1], "dropbox");
  assert.equal(decodeURIComponent(match[2]), "Taxes/2022/Form W-2 (Employer).pdf");
});

test("toFsUri rejects an absolute path", () => {
  assert.throws(() => toFsUri("dropbox", "/etc/passwd"), /absolute/);
});

test("toFsUri rejects a path with no stable segments", () => {
  assert.throws(() => toFsUri("dropbox", "."), /stable/);
  assert.throws(() => toFsUri("dropbox", "../outside.pdf"), /stable/);
});
