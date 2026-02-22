// app/layout.tsx
import type { Metadata } from "next";
import type { Viewport } from "next";
import "./globals.css";
import AuthSyncGuard from "./auth-sync-guard";

const SOCIAL_ORIGIN = "https://kozmos.social";
const SOCIAL_SHARE_VERSION =
  (process.env.NEXT_PUBLIC_SOCIAL_SHARE_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "v1")
    .trim()
    .slice(0, 16);

function withShareVersion(url: string) {
  const u = new URL(url);
  u.searchParams.set("v", SOCIAL_SHARE_VERSION);
  return u.toString();
}

const SOCIAL_PREVIEW_IMAGE = withShareVersion(
  `${SOCIAL_ORIGIN}/opengraph-image.png`
);
const SOCIAL_PREVIEW_TWITTER_IMAGE = withShareVersion(
  `${SOCIAL_ORIGIN}/twitter-image.png`
);
const SOCIAL_SHARE_URL = withShareVersion(`${SOCIAL_ORIGIN}/`);

export const metadata: Metadata = {
  metadataBase: new URL(SOCIAL_ORIGIN),
  title: "KOZMOS·",
  description: "A shared social space for presence, not performance.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "KOZMOS·",
    description: "A shared social space for presence, not performance.",
    url: SOCIAL_SHARE_URL,
    siteName: "KOZMOS·",
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
    title: "KOZMOS·",
    description: "A shared social space for presence, not performance.",
    images: [SOCIAL_PREVIEW_TWITTER_IMAGE],
  },
  other: {
    "og:image:secure_url": SOCIAL_PREVIEW_IMAGE,
    "og:image:type": "image/png",
    "twitter:image": SOCIAL_PREVIEW_TWITTER_IMAGE,
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
