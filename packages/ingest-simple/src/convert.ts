// File-to-pages conversion. PDF pages come from poppler's `pdftotext`, split
// on the form-feed character it emits between pages; a page with fewer than
// 40 non-whitespace characters (a scan with no text layer, or a mostly-blank
// page pdftotext under-read) is re-rendered with `pdftoppm` and OCR'd through
// `ocr.ts`. Text, Markdown and CSV are one page each, read as UTF-8.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SupportedExtension } from "./walk.js";
import { loadOcrConfig, ocrConverterFingerprint, ocrPageImage, type OcrFetch } from "./ocr.js";

const run = promisify(execFile);

const MIN_NON_WHITESPACE_CHARS = 40;
const PLAIN_TEXT_CONVERTER = "ingest-simple-plain-text-v1";
const MEDIA_TYPES: Record<SupportedExtension, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};

export type ConvertedDocument = {
  pages: string[];
  /** Identifies the converter (and, when used, the OCR model) that produced
   * `pages`. Feeds the text version's `extraction_fingerprint`: a converter
   * or OCR model change here must change this string, since it changes what
   * "the same extraction" means for that revision. */
  converterFingerprint: string;
  mediaType: string;
  ocrPagesUsed: number;
};

export type ConvertOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: OcrFetch;
  /** Called once per run the first time OCR would help but no provider is
   * configured, so the caller can log it without spamming per page. */
  onOcrUnconfigured?: () => void;
  /** Called once per run the first time an OCR request itself fails. */
  onOcrFailed?: (error: unknown) => void;
};

let cachedPdftotextVersion: string | undefined;

async function pdftotextVersion(): Promise<string> {
  if (cachedPdftotextVersion) return cachedPdftotextVersion;
  try {
    // pdftotext -v writes its version banner to stderr and exits non-zero
    // (it also complains about missing arguments), so both streams are read.
    await run("pdftotext", ["-v"]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const match = /pdftotext version (\S+)/.exec(stderr);
    cachedPdftotextVersion = match?.[1] ?? "unknown";
    return cachedPdftotextVersion;
  }
  cachedPdftotextVersion = "unknown";
  return cachedPdftotextVersion;
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

async function renderPagePng(pdfPath: string, pageNumber: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "ingest-simple-ocr-"));
  try {
    const prefix = join(dir, "page");
    await run("pdftoppm", [
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      "-r",
      "200",
      "-png",
      "-singlefile",
      pdfPath,
      prefix,
    ]);
    return await readFile(`${prefix}.png`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function convertPdf(
  absolutePath: string,
  options: ConvertOptions,
): Promise<ConvertedDocument> {
  const { stdout } = await run("pdftotext", ["-layout", absolutePath, "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  // pdftotext emits a form-feed between pages; poppler versions differ on
  // whether a trailing one follows the last page, so a trailing empty page is
  // dropped rather than counted.
  const rawPages = stdout.split("\f");
  if (rawPages.length > 1 && rawPages[rawPages.length - 1] === "") rawPages.pop();
  const pages = rawPages.length > 0 ? rawPages : [""];

  const poppler = await pdftotextVersion();
  let converterFingerprint = `pdftotext-poppler@${poppler}`;
  let ocrPagesUsed = 0;
  let warnedUnconfigured = false;
  let warnedFailed = false;
  const ocrConfig = loadOcrConfig(options.env ?? process.env);

  for (let index = 0; index < pages.length; index += 1) {
    if (nonWhitespaceLength(pages[index]!) >= MIN_NON_WHITESPACE_CHARS) continue;
    if (!ocrConfig) {
      if (!warnedUnconfigured) {
        options.onOcrUnconfigured?.();
        warnedUnconfigured = true;
      }
      continue;
    }
    try {
      const png = await renderPagePng(absolutePath, index + 1);
      const text = await ocrPageImage(png, ocrConfig, options.fetchImpl);
      if (text.length > 0) {
        pages[index] = text;
        ocrPagesUsed += 1;
      }
    } catch (error) {
      if (!warnedFailed) {
        options.onOcrFailed?.(error);
        warnedFailed = true;
      }
    }
  }
  if (ocrPagesUsed > 0 && ocrConfig) {
    converterFingerprint += `+${ocrConverterFingerprint(ocrConfig)}`;
  }
  return { pages, converterFingerprint, mediaType: MEDIA_TYPES[".pdf"], ocrPagesUsed };
}

async function convertPlainText(
  absolutePath: string,
  extension: Exclude<SupportedExtension, ".pdf">,
): Promise<ConvertedDocument> {
  const text = await readFile(absolutePath, "utf8");
  return {
    pages: [text],
    converterFingerprint: PLAIN_TEXT_CONVERTER,
    mediaType: MEDIA_TYPES[extension],
    ocrPagesUsed: 0,
  };
}

export async function convertFile(
  absolutePath: string,
  extension: SupportedExtension,
  options: ConvertOptions = {},
): Promise<ConvertedDocument> {
  if (extension === ".pdf") return convertPdf(absolutePath, options);
  return convertPlainText(absolutePath, extension);
}

export type ConvertedPage1 = {
  pageText: string;
  /** The original document's total page count: for a PDF, from `pdfinfo`
   * (cheap -- it does not extract text); 1 for every other supported
   * extension, which `convert.ts` always treats as one page. */
  totalPageCount: number;
  converterFingerprint: string;
  mediaType: string;
  ocrPagesUsed: number;
};

/** Parses poppler's `pdfinfo` `Pages: N` line. Thrown, not defaulted, on a
 * missing or unparseable line: a page count this wrong would misreport how
 * much of the document a glance-depth summary actually saw. */
async function pdfPageCount(absolutePath: string): Promise<number> {
  const { stdout } = await run("pdfinfo", [absolutePath]);
  const match = /^Pages:\s+(\d+)\s*$/m.exec(stdout);
  if (!match) throw new Error("pdfinfo did not report a page count");
  return Number(match[1]);
}

async function convertPdfPage1(
  absolutePath: string,
  options: ConvertOptions,
): Promise<ConvertedPage1> {
  const [{ stdout }, totalPageCount] = await Promise.all([
    run("pdftotext", ["-f", "1", "-l", "1", "-layout", absolutePath, "-"], {
      maxBuffer: 64 * 1024 * 1024,
    }),
    pdfPageCount(absolutePath),
  ]);
  let pageText = stdout.endsWith("\f") ? stdout.slice(0, -1) : stdout;

  const poppler = await pdftotextVersion();
  let converterFingerprint = `pdftotext-poppler@${poppler}`;
  let ocrPagesUsed = 0;
  const ocrConfig = loadOcrConfig(options.env ?? process.env);

  if (nonWhitespaceLength(pageText) < MIN_NON_WHITESPACE_CHARS) {
    if (!ocrConfig) {
      options.onOcrUnconfigured?.();
    } else {
      try {
        const png = await renderPagePng(absolutePath, 1);
        const text = await ocrPageImage(png, ocrConfig, options.fetchImpl);
        if (text.length > 0) {
          pageText = text;
          ocrPagesUsed = 1;
        }
      } catch (error) {
        options.onOcrFailed?.(error);
      }
    }
  }
  if (ocrPagesUsed > 0 && ocrConfig) {
    converterFingerprint += `+${ocrConverterFingerprint(ocrConfig)}`;
  }
  return { pageText, totalPageCount, converterFingerprint, mediaType: MEDIA_TYPES[".pdf"], ocrPagesUsed };
}

/**
 * The `glance` depth's conversion: page 1 only (OCR'd the same way a
 * full-document low-text page would be) plus the document's real total page
 * count, without ever extracting or rendering any other page. For every
 * non-PDF extension this is identical to `convertFile` -- those are already
 * one page each, so there is nothing further a glance could omit.
 */
export async function convertFilePage1(
  absolutePath: string,
  extension: SupportedExtension,
  options: ConvertOptions = {},
): Promise<ConvertedPage1> {
  if (extension === ".pdf") return convertPdfPage1(absolutePath, options);
  const whole = await convertPlainText(absolutePath, extension);
  return {
    pageText: whole.pages[0]!,
    totalPageCount: 1,
    converterFingerprint: whole.converterFingerprint,
    mediaType: whole.mediaType,
    ocrPagesUsed: 0,
  };
}
