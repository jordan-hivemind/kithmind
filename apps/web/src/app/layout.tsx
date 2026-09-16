// The root layout, which decides whether the Convex providers are mounted.
//
// `ConvexClientProvider` constructs a `ConvexReactClient` from
// `NEXT_PUBLIC_CONVEX_URL` at module scope, so mounting it under the PostgreSQL
// surface would mean a deployment that no longer configures that variable
// throws before anything renders. Under `postgres` the tree is the plain
// document and nothing else.
//
// Neither the provider nor `ConvexClientProvider` is deleted here. Every page
// that still calls a Convex hook needs them until i5 moves those pages, and i2
// and i7 own the deletion.

import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";

import { kithPostgresSurface } from "@/lib/kith/surface";

import { ConvexClientProvider } from "./ConvexClientProvider";

export const metadata = {
  title: "Kith Mind",
  description: "Your personal AI memory layer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (kithPostgresSurface() === "postgres") {
    return (
      <html lang="en">
        <body>{children}</body>
      </html>
    );
  }

  return (
    <ConvexAuthNextjsServerProvider>
      <html lang="en">
        <body>
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
