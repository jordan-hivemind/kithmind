// The root layout: the plain document, the stylesheet and the typeface.
//
// i7b deleted the Convex providers this used to mount under
// `KITH_POSTGRES_SURFACE=convex`, together with the client they configured.
//
// ADM-1 adds `globals.css` (Tailwind v4 plus the owner's tokens) and Inter,
// self-hosted through `next/font` so nothing the admin screens paint needs a
// request to a font CDN. The pages that predate the admin panel keep their
// inline styles; Tailwind's preflight is all this changes for them.

import "./globals.css";

import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

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
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
