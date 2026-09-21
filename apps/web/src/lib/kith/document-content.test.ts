import { createHash } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  documentByteResponse,
  documentDropboxPath,
  downloadDocumentBytes,
  type DropboxDocumentConfig,
  providerOriginalAvailable,
} from "./document-content";
const config: DropboxDocumentConfig = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  refreshToken: "synthetic-refresh",
  expectedAccountIdHash: createHash("sha256")
    .update("synthetic-account")
    .digest("hex"),
  roots: [
    { sourceAccountId: "source-a", alias: "inbox", path: "/Synthetic Inbox" },
  ],
};
afterEach(() => vi.unstubAllGlobals());
describe("authenticated document content helpers", () => {
  test("provider recovery requires an admitted and verified original", () => {
    const eligible = {
      originalLinkAvailable: true,
      originalRecovery: {
        kind: "provider_original_v1",
        providerVerification: "verified_at_admission",
      },
      contentHash: "a".repeat(64),
    };
    expect(providerOriginalAvailable(eligible, "/Synthetic Inbox/file.pdf")).toBe(
      true,
    );
    expect(
      providerOriginalAvailable(
        { ...eligible, originalLinkAvailable: false },
        "/Synthetic Inbox/file.pdf",
      ),
    ).toBe(false);
    expect(
      providerOriginalAvailable(
        { ...eligible, originalRecovery: undefined },
        "/Synthetic Inbox/file.pdf",
      ),
    ).toBe(false);
    expect(
      providerOriginalAvailable(
        {
          ...eligible,
          originalRecovery: {
            ...eligible.originalRecovery,
            providerVerification: "audit_unavailable",
          },
        },
        "/Synthetic Inbox/file.pdf",
      ),
    ).toBe(false);
    expect(providerOriginalAvailable(eligible, null)).toBe(false);
  });

  test("provider paths stay within the stored connection and configured root", () => {
    expect(
      documentDropboxPath(
        config,
        "source-a",
        "fs://inbox/reports/Test%20return.pdf",
      ),
    ).toBe("/Synthetic Inbox/reports/Test return.pdf");
    for (const uri of [
      "fs://inbox/../secret.pdf",
      "fs://inbox/%2e%2e/secret.pdf",
      "fs://inbox/%2fsecret.pdf",
      "fs://inbox/a%5cb.pdf",
      "https://example.test/file.pdf",
      "fs://elsewhere/file.pdf",
    ]) {
      expect(documentDropboxPath(config, "source-a", uri)).toBeNull();
    }
    expect(
      documentDropboxPath(config, "source-b", "fs://inbox/file.pdf"),
    ).toBeNull();
  });
  test("PDF responses support inline viewing, safe downloads and byte ranges", async () => {
    const bytes = new TextEncoder().encode("%PDF-synthetic");
    const response = documentByteResponse(
      new Request("https://app.test/content", {
        headers: { range: "bytes=1-3" },
      }),
      bytes,
      "synthetic\r\nfile.pdf",
      "application/pdf",
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("PDF");
    expect(response.headers.get("content-range")).toBe(
      `bytes 1-3/${bytes.length}`,
    );
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const download = documentByteResponse(
      new Request("https://app.test/content?download=1"),
      bytes,
      "test.pdf",
      "application/pdf",
    );
    expect(download.headers.get("content-disposition")).toContain("attachment");
    const active = documentByteResponse(
      new Request("https://app.test/content"),
      bytes,
      "test.html",
      "text/html",
    );
    expect(active.headers.get("content-disposition")).toContain("attachment");
    const invalid = documentByteResponse(
      new Request("https://app.test/content", {
        headers: { range: "bytes=999-" },
      }),
      bytes,
      "test.pdf",
      "application/pdf",
    );
    expect(invalid.status).toBe(416);
  });
  test("downloads verify the connected account and indexed content hash", async () => {
    const bytes = new TextEncoder().encode("%PDF-synthetic");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "synthetic-access" }),
      )
      .mockResolvedValueOnce(Response.json({ account_id: "synthetic-account" }))
      .mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(new Response("different revision"));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await downloadDocumentBytes(config, "/Synthetic Inbox/file.pdf", hash),
    ).toEqual(bytes);
    await expect(
      downloadDocumentBytes(config, "/Synthetic Inbox/file.pdf", hash),
    ).rejects.toThrow("changed since it was indexed");
    expect(fetcher.mock.calls[2]![0]).toBe(
      "https://content.dropboxapi.com/2/files/download",
    );
    expect(fetcher.mock.calls[2]![1].redirect).toBe("error");
  });
});
