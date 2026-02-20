// app/layout.tsx
import type { Metadata } from "next";
import type { Viewport } from "next";
import "./globals.css";
import AuthSyncGuard from "./auth-sync-guard";

const SOCIAL_PREVIEW_IMAGE =
  "https://kozmos.social/kozmos-logo2.png";

export const metadata: Metadata = {
  metadataBase: new URL("https://kozmos.social"),
  title: "KOZMOS.",
  description: "A shared social space for presence, not performance.",
  openGraph: {
    title: "KOZMOS.",
    description: "A shared social space for presence, not performance.",
    url: "https://kozmos.social",
    siteName: "KOZMOS.",
    type: "website",
    images: [
      {
        url: SOCIAL_PREVIEW_IMAGE,
        width: 1200,
        height: 630,
        alt: "KOZMOS logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "KOZMOS.",
    description: "A shared social space for presence, not performance.",
    images: [SOCIAL_PREVIEW_IMAGE],
  },
  other: {
    "og:image:secure_url": SOCIAL_PREVIEW_IMAGE,
    "og:image:type": "image/png",
    "twitter:image": SOCIAL_PREVIEW_IMAGE,
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0b",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      style={{
        background: "#0b0b0b",
        colorScheme: "dark",
      }}
    >
      <body
        style={{
          margin: 0,
          background: "#0b0b0b",
          color: "#eaeaea",
        }}
      >
        <AuthSyncGuard />
        {children}
      </body>
    </html>
  );
}
