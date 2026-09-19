// A Node module customization hook (`node:module`'s `register`), so
// `investments-import.mjs` can import `apps/web/src/lib/kith/investment-import.ts`
// unmodified.
//
// That file is reached, throughout the app, through the `@/*` -> `apps/web/src/*`
// alias Next.js's bundler resolves from `apps/web/tsconfig.json`. Plain Node
// does not read tsconfig paths, and rewriting that one import to a relative
// path would be the only file in the tree not using the alias -- a bigger,
// stranger diff than this dozen-line hook. Node 24 already strips TypeScript
// syntax from a `.ts` file with no flag and no build step (tested against the
// engines floor this repo already requires); the alias is the only gap this
// hook closes.

const WEB_SRC = new URL("../apps/web/src/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = new URL(`${specifier.slice(2)}.ts`, WEB_SRC);
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
