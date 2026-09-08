import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dropboxConfigIdentityFingerprint,
  verifyDropboxCredentialConfig,
  verifyDropboxDirectoryBinding,
} from "../dist/dropboxCredentials.js";
import { hashDropboxCapture } from "../dist/dropboxOriginal.js";
import { verifyDropboxOriginal } from "../dist/dropboxOriginal.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const id = "id:root_123";

async function fixture() {
  const dir = await mkdtemp(join(homedir(), ".kithmind-dropbox-test-"));
  const configPath = join(dir, "rclone.conf");
  const binary = join(dir, "rclone");
  await writeFile(
    configPath,
    `[synthetic]\ntype = dropbox\ntoken = {"access_token":"TOKEN_SENTINEL","token_type":"bearer"}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = version ]; then echo 'rclone v1.74.4'; exit 0; fi\nif [ "$1" = lsjson ]; then echo '[{"Name":"root","Path":"root","IsDir":true,"Size":-1,"ModTime":"","ID":"${id}"}]'; exit 0; fi\nexit 1\n`,
    { mode: 0o700 },
  );
  await chmod(configPath, 0o600);
  await chmod(binary, 0o700);
  const config = {
    rcloneBinary: binary,
    configPath,
    remoteName: "synthetic",
    configIdentityFingerprint: dropboxConfigIdentityFingerprint(
      configPath,
      "synthetic",
    ),
  };
  return { dir, config };
}

test("validates a closed synthetic rclone config and real directory ID", async () => {
  const f = await fixture();
  try {
    await verifyDropboxCredentialConfig(f.config);
    const checked = await verifyDropboxDirectoryBinding({
      ...f.config,
      rootPath: "root",
      expectedRootDirectoryIdHash: sha(id),
    });
    assert.equal(checked.rootDirectoryIdHash, sha(id));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("hashes exact Dropbox 4 MiB blocks and rejects wrong digest or symlink", async () => {
  const f = await fixture();
  try {
    const capture = join(f.dir, "capture.bin");
    const bytes = Buffer.concat([
      Buffer.alloc(4 * 1024 * 1024, 0x41),
      Buffer.alloc(12345, 0x42),
    ]);
    await writeFile(capture, bytes, { mode: 0o600 });
    const expectedDrop = sha(
      Buffer.concat([
        Buffer.from(sha(bytes.subarray(0, 4 * 1024 * 1024)), "hex"),
        Buffer.from(sha(bytes.subarray(4 * 1024 * 1024)), "hex"),
      ]),
    );
    await symlink(capture, join(f.dir, "capture-link"));
    await assert.rejects(
      () =>
        hashDropboxCapture(join(f.dir, "capture-link"), {
          sha256: sha(bytes),
          byteLength: bytes.length,
        }),
      /capture identity is invalid/,
    );
    const result = await hashDropboxCapture(capture, {
      sha256: sha(bytes),
      byteLength: bytes.length,
    });
    assert.equal(result.dropboxContentHash, expectedDrop);
    await assert.rejects(
      () =>
        hashDropboxCapture(capture, {
          sha256: sha(Buffer.from("wrong")),
          byteLength: bytes.length,
        }),
      /capture bytes do not match/,
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("verifies provider metadata while separating public metadata from private binding", async () => {
  const f = await fixture();
  const capture = join(f.dir, "one.bin");
  const bytes = Buffer.from("hello");
  const fileHash = sha(bytes);
  const dropHash = sha(Buffer.from(sha(bytes), "hex"));
  await writeFile(capture, bytes, { mode: 0o600 });
  const account = "dbid:account_1";
  const rootId = id;
  const rootHash = sha(rootId);
  const oldFetch = globalThis.fetch;
  const responses = [
    { account_id: account, disabled: false },
    { ".tag": "folder", id: rootId, path_lower: "/root" },
    {
      ".tag": "file",
      id: "id:file_1",
      rev: "rev1",
      content_hash: dropHash,
      size: bytes.length,
      path_lower: "/root/one.pdf",
    },
    { ".tag": "folder", id: rootId, path_lower: "/root" },
    {
      ".tag": "file",
      id: "id:file_1",
      rev: "rev1",
      content_hash: dropHash,
      size: bytes.length,
      path_lower: "/root/one.pdf",
    },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const result = await verifyDropboxOriginal({
      credentials: f.config,
      refreshPath: "root",
      capturePath: capture,
      sourceContentHash: fileHash,
      sourceByteLength: bytes.length,
      providerAccountIdHash: sha(account),
      providerRootDirectoryIdHash: rootHash,
      providerRootDirectoryId: rootId,
      relativePath: "one.pdf",
      bindingId: "123e4567-e89b-12d3-a456-426614174000",
    });
    assert.equal(result.metadata.providerContentHash, dropHash);
    assert.equal(result.binding.providerFileId, "id:file_1");
    assert.equal(result.metadata.providerAccountIdHash, sha(account));
    assert.equal(result.binding.providerAccountId, account);
  } finally {
    globalThis.fetch = oldFetch;
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("rejects each malformed credential and directory independently", async () => {
  const f = await fixture();
  const valid = `[synthetic]\ntype = dropbox\ntoken = {"access_token":"TOKEN_SENTINEL"}\n`;
  try {
    await assert.rejects(
      () =>
        verifyDropboxCredentialConfig({
          ...f.config,
          configIdentityFingerprint: sha("wrong"),
        }),
      /configuration identity mismatch/,
    );
    for (const extra of [
      "endpoint = https://example.invalid\n",
      "[other]\ntype = dropbox\n",
      'token = {"access_token":"other"}\n',
    ]) {
      await writeFile(f.config.configPath, valid + extra, { mode: 0o600 });
      await assert.rejects(
        () => verifyDropboxCredentialConfig(f.config),
        /closed Dropbox settings/,
      );
    }
    await writeFile(f.config.configPath, valid, { mode: 0o600 });
    await assert.rejects(
      () =>
        verifyDropboxDirectoryBinding({
          ...f.config,
          rootPath: "root",
          expectedRootDirectoryIdHash: sha("id:wrong"),
        }),
      /directory identity mismatch/,
    );
    for (const listing of [
      [{ Name: "root", Path: "root", IsDir: true, Size: -1, ModTime: "" }],
      [
        {
          Name: "root",
          Path: "root",
          IsDir: true,
          Size: -1,
          ModTime: "",
          ID: id,
          Extra: true,
        },
      ],
      [
        {
          Name: "root",
          Path: "root",
          IsDir: true,
          Size: 1,
          ModTime: "",
          ID: id,
        },
      ],
    ]) {
      await writeFile(
        f.config.rcloneBinary,
        `#!/bin/sh\nif [ "$1" = version ]; then echo 'rclone v1.74.4'; else echo '${JSON.stringify(listing)}'; fi\n`,
        { mode: 0o700 },
      );
      await assert.rejects(
        () =>
          verifyDropboxDirectoryBinding({
            ...f.config,
            rootPath: "root",
            expectedRootDirectoryIdHash: sha(id),
          }),
        /directory listing shape/,
      );
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("rejects provider substitutions, mutation, oversized responses and errors without leaking secrets", async () => {
  const f = await fixture();
  const capture = join(f.dir, "source.bin");
  const bytes = Buffer.from("synthetic source");
  await writeFile(capture, bytes, { mode: 0o600 });
  const account = "dbid:account_1";
  const root = { ".tag": "folder", id, path_lower: "/root" };
  const file = {
    ".tag": "file",
    id: "id:file_1",
    rev: "rev1",
    content_hash: sha(Buffer.from(sha(bytes), "hex")),
    size: bytes.length,
    path_lower: "/root/one.pdf",
  };
  const input = {
    credentials: f.config,
    refreshPath: "root",
    capturePath: capture,
    sourceContentHash: sha(bytes),
    sourceByteLength: bytes.length,
    providerAccountIdHash: sha(account),
    providerRootDirectoryIdHash: sha(id),
    providerRootDirectoryId: id,
    relativePath: "one.pdf",
    bindingId: "123e4567-e89b-12d3-a456-426614174000",
    expectedProviderFileIdHash: sha(file.id),
  };
  const oldFetch = globalThis.fetch;
  try {
    for (const [index, patch] of [
      [0, { account_id: "dbid:wrong" }],
      [0, { disabled: true }],
      [1, { id: "id:wrong" }],
      [2, { id: "id:wrong" }],
      [2, { content_hash: sha("wrong") }],
      [2, { size: 100 }],
      [2, { path_lower: "/other/one.pdf" }],
      [3, { id: "id:replaced" }],
      [4, { rev: "rev2" }],
    ]) {
      const replies = [
        { account_id: account, disabled: false },
        { ...root },
        { ...file },
        { ...root },
        { ...file },
      ];
      Object.assign(replies[index], patch);
      globalThis.fetch = async () =>
        new Response(JSON.stringify(replies.shift()));
      await assert.rejects(
        () => verifyDropboxOriginal(input),
        /Dropbox verification failed/,
      );
    }
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(
        url,
        "https://api.dropboxapi.com/2/users/get_current_account",
      );
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer TOKEN_SENTINEL");
      throw new Error("TOKEN_SENTINEL PRIVATE_PATH provider body");
    };
    await assert.rejects(
      () => verifyDropboxOriginal(input),
      (error) =>
        !String(error).includes("TOKEN_SENTINEL") &&
        !String(error).includes("PRIVATE_PATH"),
    );
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response("TOKEN_SENTINEL".repeat(70000));
    await assert.rejects(
      () => verifyDropboxOriginal(input),
      /metadata exceeds bound/,
    );
    globalThis.fetch = async () =>
      new Response("TOKEN_SENTINEL", { status: 401 });
    await assert.rejects(
      () => verifyDropboxOriginal(input),
      (error) =>
        String(error).includes("metadata request failed") &&
        !String(error).includes("TOKEN_SENTINEL"),
    );
  } finally {
    globalThis.fetch = oldFetch;
    await rm(f.dir, { recursive: true, force: true });
  }
});
