// A document's title is the only thing shown in a list without opening it,
// so a glance-depth document (most of the owner's tax-support paperwork,
// stored as page 1 only -- see depthPolicy.ts) needs to be findable by year
// from that title alone, without any change to the read path: `getDocument`
// and search already surface `documents.title` as-is. When both a kind and a
// tax year are detected, the title becomes `<kind label> <taxYear> ·
// <filename>` ("Tax return 2018 · 2018-1040.pdf"); otherwise it stays the
// filename, exactly as before this module existed.

import type { DocumentKind } from "./classify.js";

const KIND_LABELS: Record<DocumentKind, string> = {
  tax_return: "Tax return",
  k1: "K-1",
  tax_support: "Tax support",
  statement: "Statement",
  other: "Other",
};

function baseFilename(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** `kind` is always present (`detectKind` never returns nothing -- "other" is
 * its default), so in practice this composes a title exactly when
 * `detectTaxYear` found a year, for every kind including `statement`/`other`.
 * The filename keeps its extension in the composed form (it is the
 * document's real name, alongside a description) but not in the fallback,
 * matching this module's previous, extension-stripped `titleFor` behavior. */
export function buildTitle(
  relativePath: string,
  kind: DocumentKind,
  taxYear: number | undefined,
): string {
  if (taxYear === undefined) return withoutExtension(baseFilename(relativePath));
  return `${KIND_LABELS[kind]} ${taxYear} · ${baseFilename(relativePath)}`;
}
