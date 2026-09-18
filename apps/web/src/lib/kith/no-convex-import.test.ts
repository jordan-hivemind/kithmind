// i7b's standing guard: nothing under `apps/web/src` imports Convex.
//
// Row i5 shipped a narrower version of this, which had to exempt each
// `page.tsx`'s `convex-*` sibling and could only name two files under
// `src/lib/mcp`, because that directory was dual-surface by design. i7b
// deleted the Convex branch, so the exemptions are gone and the whole source
// tree is scanned instead.
//
// The pattern covers the ways this codebase used to reach Convex: `convex/*`
// (`convex/react`, `convex/browser`, `convex/server`, ...), `@repo/db` bare
// or with a subpath (`@repo/db/convex/_generated/api`), and `@convex-dev/*`
// (`@convex-dev/auth/nextjs/server`). It matches a dynamic `import(...)` the
// same way it matches a static one, since either reaches the same module.
//
// The tree is scanned rather than hand-listed, so a new file is covered
// without this test needing to be told about it by name. Its own text would
// match, so it excludes itself.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const SELF = "src/lib/kith/no-convex-import.test.ts";

/** Every spelling this codebase used to reach Convex, static or dynamic. */
const CONVEX_IMPORT =
  /(?:from\s+["']|import\(\s*["'])(convex\/|convex["']|@repo\/db(?:\/|["'])|@convex-dev\/)/;

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

describe("apps/web never imports Convex", () => {
  test.each(
    filesUnder("src").filter(
      (file) => file !== SELF && /\.tsx?$/.test(file),
    ),
  )("%s", (relativePath) => {
    expect(readFileSync(path.join(ROOT, relativePath), "utf8")).not.toMatch(
      CONVEX_IMPORT,
    );
  });
});

/**
 * The other half of rule 3: "the test must prove the redirect comes from the
 * page's own check, not only middleware." `postgres-pages.test.ts` proves the
 * loader half of that in a real read-only transaction -- a forged or missing
 * cookie returns `null` -- for every one of these loaders. This proves the
 * other half statically: each page is wired to redirect on exactly that
 * `null`, so the two together are the whole path from a
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
