import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Image from "next/image";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KOZMOS·",
  description: "A shared social space for presence, not performance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/kozmos-logo1.png" />
      </head>

      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {/* Üst orta logo – viewport’a kilitli */}
        <header
          style={{
            position: "fixed",
            top: "32px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "auto",
          }}
        >
          <Link href="/" aria-label="Kozmos welcome">
            <Image
  src="/kozmos-logomother.PNG"
  alt="Kozmos"
  width={120}
  height={40}
  priority
  className="kozmos-logo"
/>
          </Link>
        </header>

        {children}
      </body>
    </html>
  );
}
