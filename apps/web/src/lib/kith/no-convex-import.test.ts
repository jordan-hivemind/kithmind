// Section 6 row i5, rule 1: every page renders under `postgres` "with no
// Convex import on that path".
//
// "That path" is narrower than "the file": under `postgres` a `page.tsx`
// still statically imports its sibling `convex-*` component so it can render
// it under `convex` -- `app/(authenticated)/page.tsx` imports
// `ConvexDashboard`, which imports `convex/react`, and that import is
// reachable from every build regardless of which surface answers a given
// request. That is by design until i7 deletes the Convex branch entirely, so
// this test does not (and cannot, by construction) prove a `page.tsx` file
// has zero Convex imports; it proves the postgres path's *own* files -- the
// `kith-*` components, the `lib/kith/*` loaders and route handlers, and the
// five `page.tsx` files' non-component code -- have none. The five
// `page.tsx` files are checked with a narrower pattern than the rest for
// exactly that reason: it would otherwise fail on the `convex-*` import
// every one of them legitimately has.
//
// The pattern covers the ways this codebase reaches Convex: `convex/*`
// (`convex/react`, `convex/browser`, `convex/server`, ...), `@repo/db` bare
// or with a subpath (`@repo/db/convex/_generated/api`), and
// `@convex-dev/*` (`@convex-dev/auth/nextjs/server`, the one other Convex
// package this app imports). It matches a dynamic `import(...)` the same way
// it matches a static one, since either reaches the same module.
//
// The directories are scanned rather than hand-listed, so a new file dropped
// into `src/components`, `src/lib/kith` or `src/app/api/kith` is covered
// without this test needing to be told about it by name.

import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** Every spelling this codebase uses to reach Convex, static or dynamic. */
const CONVEX_IMPORT =
  /(?:from\s+["']|import\(\s*["'])(convex\/|convex["']|@repo\/db(?:\/|["'])|@convex-dev\/)/;

/**
 * The `convex-*` sibling a `page.tsx` imports for its `convex` branch. Only
 * that one import is allowed to name Convex indirectly; the module comment
 * above says why.
 */
const CONVEX_SIBLING_IMPORT = /from\s+["']@\/components\/convex-/;

function fileText(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function assertNoConvexImport(relativePath: string): void {
  expect(fileText(relativePath)).not.toMatch(CONVEX_IMPORT);
}

/** Every file under `dir` (recursively), as paths relative to `ROOT`. */
function filesUnder(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  return readdirSync(absolute).flatMap((name) => {
    const relative = `${dir}/${name}`;
    return statSync(path.join(ROOT, relative)).isDirectory()
      ? filesUnder(relative)
      : [relative];
  });
}

describe("the postgres surface never imports Convex", () => {
  test.each(PAGE_FILES)(
    "%s imports Convex only through its convex-* sibling",
    (relativePath) => {
      // Drop the one allowed import line (the `convex-*` sibling this page
      // renders under `convex`), then require every remaining line to be
      // free of a Convex import: anything left over would be this page
      // reaching Convex on its own account rather than through the
      // component that owns that branch.
      const withoutSibling = fileText(relativePath)
        .split("\n")
        .filter((line) => !CONVEX_SIBLING_IMPORT.test(line))
        .join("\n");
      expect(withoutSibling).not.toMatch(CONVEX_IMPORT);
    },
  );

  test.each(
    readdirSync(path.join(ROOT, "src/components")).filter(
      (name) => name.startsWith("kith-") && !name.startsWith("convex-"),
    ),
  )("components/%s", (file) => assertNoConvexImport(`src/components/${file}`));

  test.each(
    readdirSync(path.join(ROOT, "src/lib/kith")).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    ),
  )("lib/kith/%s", (file) => assertNoConvexImport(`src/lib/kith/${file}`));

  test.each(
    filesUnder("src/app/api/kith").filter((file) => !file.endsWith(".test.ts")),
  )("%s", assertNoConvexImport);
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
