// Where a document added from the Edit investment drawer lands in Dropbox.
// The server decides the path; the browser names only the file, so the file
// name must never climb out of the investment's folder.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/kith/document-content", () => ({ accessToken: vi.fn() }));

import type { DropboxDocumentConfig } from "./document-content";
import { investmentFolder, safeSegment, uploadPath } from "./investment-upload";

const config = {
  roots: [
    { sourceAccountId: "a", alias: "dropbox-inbox", path: "/Inbox" },
    {
      sourceAccountId: "a",
      alias: "dropbox-investing",
      path: "/Fin/Investing/",
    },
  ],
} as unknown as DropboxDocumentConfig;

describe("investmentFolder", () => {
  it("reuses the folder most of the investment's documents are in", () => {
    expect(
      investmentFolder("Ocella", [
        "fs://dropbox-investing/Ateios%20-%20Ocella/a.pdf",
        "fs://dropbox-investing/Ateios%20-%20Ocella/Legal/b.pdf",
        "fs://dropbox-investing/Other/c.pdf",
        "fs://dropbox-investing/root-file.pdf",
        "fs://dropbox-taxes/Ocella/k1.pdf",
        null,
      ]),
    ).toBe("Ateios - Ocella");
  });

  it("falls back to a folder named for the investment", () => {
    expect(
      investmentFolder("Beyond Silicon", [
        "fs://dropbox-investing/Complete_with_Docusign_Beyond_Silicon_SAFE_-.pdf",
      ]),
    ).toBe("Beyond Silicon");
    expect(investmentFolder("A/B: C", [])).toBe("A B C");
  });
});

describe("uploadPath", () => {
  it("files under the Investing root and keeps only the base name", () => {
    expect(uploadPath(config, "Beyond Silicon", "../../etc/SAFE.pdf")).toBe(
      "/Fin/Investing/Beyond Silicon/SAFE.pdf",
    );
    expect(uploadPath(config, "X", "C:\\Users\\me\\side letter.pdf")).toBe(
      "/Fin/Investing/X/side letter.pdf",
    );
  });

  it("refuses an unusable name or a missing root", () => {
    expect(uploadPath(config, "X", "..")).toBeNull();
    expect(
      uploadPath(
        { roots: [] } as unknown as DropboxDocumentConfig,
        "X",
        "a.pdf",
      ),
    ).toBeNull();
  });

  it("strips characters Dropbox rejects", () => {
    expect(safeSegment('  a:b*c?"d<e>|f  ')).toBe("a b c d e f");
  });
});
