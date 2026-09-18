// The root layout: the plain document and nothing else.
//
// i7b deleted the Convex providers this used to mount under
// `KITH_POSTGRES_SURFACE=convex`, together with the client they configured.

export const metadata = {
  title: "Kith Mind",
  description: "Your personal AI memory layer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
