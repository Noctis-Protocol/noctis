import type { Metadata } from "next";
import { DM_Sans, Syne, JetBrains_Mono } from "next/font/google";
import { Web3Provider } from "@/providers/Web3Provider";
import { Toaster } from "sonner";
import "@/lib/polyfills";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
});

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700", "800"],
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Noctis | Private Uniswap desk",
  description:
    "Encrypted vault balances and private swap intents — settled through Uniswap as a proxy.",
  keywords: ["DeFi", "privacy", "FHE", "Uniswap", "desk", "ZAMA"],
  openGraph: {
    title: "Noctis",
    description: "Private Uniswap desk tool. Balances encrypted. Fill size clear at settlement.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${syne.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen font-sans antialiased desk-atmosphere" suppressHydrationWarning>
        <div className="desk-grain" aria-hidden />
        <Web3Provider>
          {children}
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            toastOptions={{
              duration: 5000,
            }}
          />
        </Web3Provider>
      </body>
    </html>
  );
}
