// Section 6 row i5, rule 1: every page renders under `postgres` "with no
// Convex import on that path". Rather than rendering each page (this
// project's vitest setup has no JSX transform plugin, and section "Tests"
// says to test loaders and route handlers directly rather than render
// pages), this reads every file on the postgres path -- the four ported
// `page.tsx` files, `app/invite/page.tsx`, every `kith-*` component and every
// `lib/kith/*` loader -- and asserts none of them imports Convex. The
// directories are scanned rather than hand-listed, so a new file dropped into
// either one is covered without this test needing to be told about it by
// name.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

const PAGE_FILES = [
  "src/app/(authenticated)/page.tsx",
  "src/app/(authenticated)/browse/page.tsx",
  "src/app/(authenticated)/settings/page.tsx",
  "src/app/(authenticated)/spaces/page.tsx",
  "src/app/invite/page.tsx",
];

const CONVEX_IMPORT = /from\s+["'](convex\/|@repo\/db\/convex)/;

function assertNoConvexImport(relativePath: string): void {
  const text = readFileSync(path.join(ROOT, relativePath), "utf8");
  expect(text).not.toMatch(CONVEX_IMPORT);
}

describe("the postgres surface never imports Convex", () => {
  test.each(PAGE_FILES)("%s", assertNoConvexImport);

  test.each(
    readdirSync(path.join(ROOT, "src/components")).filter((name) =>
      name.startsWith("kith-"),
    ),
  )("components/%s", (file) => assertNoConvexImport(`src/components/${file}`));

  test.each(
    readdirSync(path.join(ROOT, "src/lib/kith")).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    ),
  )("lib/kith/%s", (file) => assertNoConvexImport(`src/lib/kith/${file}`));
});

/**
 * The other half of rule 3: "the test must prove the redirect comes from the
 * page's own check, not only middleware." `postgres-pages.test.ts` proves the
 * loader half of that in a real read-only transaction -- a forged or missing
 * cookie returns `null` -- for every one of these loaders. This proves the
 * other half statically: each page's `postgres` branch is wired to redirect
 * on exactly that `null`, so the two together are the whole path from a
 * forged cookie to a `/sign-in` redirect, with no middleware anywhere in
 * either test.
 */
const REDIRECT_ON_NULL = [
  ["src/app/(authenticated)/page.tsx", /data === null\) redirect\("\/sign-in"\)/],
  ["src/app/(authenticated)/browse/page.tsx", /data === null\) redirect\("\/sign-in"\)/],
  ["src/app/(authenticated)/settings/page.tsx", /data === null\) redirect\("\/sign-in"\)/],
  ["src/app/(authenticated)/spaces/page.tsx", /overview === null\) redirect\("\/sign-in"\)/],
] as const;

describe("every ported page redirects on its own loader's null, not on the middleware's say-so", () => {
  test.each(REDIRECT_ON_NULL)("%s", (relativePath, pattern) => {
    const text = readFileSync(path.join(ROOT, relativePath), "utf8");
    expect(text).toMatch(pattern);
  });
});
