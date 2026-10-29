import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./catalog/catalog.css";
import "./inventory/inventory.css";
import "./quote/quote.css";
import "./quote/general.css";
import "./order-extras.css";
import "./service-history/history.css";
import "./reminders/forecast.css";
import "./reminders/retention.css";
import "./receipt.css";
import "./design-lab/design-lab.css";
import "./theme/base.css";
import "./theme/commerce.css";
import "./theme/shell.css";
import "./theme/home.css";
import "./theme/sale.css";
import "./theme/workshop.css";
import "./theme/login.css";
import "./theme/motion.css";
import { AuthGuard } from "@/components/auth-guard";
import { AppShell } from "@/components/app-shell";
import { PwaRegister } from "@/components/pwa-register";

const switzer = localFont({
  src: [
    { path: "./fonts/switzer/switzer-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/switzer/switzer-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/switzer/switzer-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/switzer/switzer-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "./fonts/switzer/switzer-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-switzer",
  display: "swap",
  fallback: ["Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Lubricenter OS",
  description: "Operación, caja y nómina de Lubricenter",
  manifest: "/manifest.webmanifest",
  applicationName: "Lubricenter OS",
  icons: {
    icon: [
      { url: "/icon", type: "image/png", sizes: "64x64" },
      { url: "/lubricenter-brand.svg", type: "image/svg+xml" }
    ],
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }]
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Lubricenter OS"
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" className={switzer.variable}>
      <body>
        <PwaRegister />
        <AuthGuard>
          <AppShell>{children}</AppShell>
        </AuthGuard>
      </body>
    </html>
  );
}

