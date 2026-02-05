import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kozmos",
  description: "Presence over performance.",
  metadataBase: new URL("https://kozmos.social"),
  openGraph: {
    title: "Kozmos",
    description: "Presence over performance.",
    url: "https://kozmos.social",
    siteName: "Kozmos",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Kozmos",
      },
    ],
    type: "website",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
<html lang="en" style={{ colorScheme: "dark", background: "#0b0b0b" }}>
     <body
  className={`${geistSans.variable} ${geistMono.variable} antialiased`}
  style={{ background: "#0b0b0b", color: "#eaeaea" }}
>
  {children}
</body>
    </html>
  );
}
