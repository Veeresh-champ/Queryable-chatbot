import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Inter, Instrument_Serif, Manrope, Montserrat, Space_Mono } from "next/font/google";
import "./globals.css";
import "./queryable.css";
import "./tools.css";
import "./settings.css";
import "./lab.css";
import "./admin.css";
import "./workspace.css";
import "./viz.css";
import "./brand.css";
import "./brand-editions.css";
import { BRAND } from "@/lib/brand";

const sans = Manrope({
  subsets: ["latin"],
  variable: "--font-sans",
});

const display = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-display",
});

// Brand edition faces. preload: false keeps the neutral build's <head> unchanged;
// only the faces a brand's CSS actually uses are downloaded.
const brandHead = Montserrat({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-brand-head", preload: false });
const brandBody = Inter({ subsets: ["latin"], variable: "--font-brand-body", preload: false });
const lakeMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-brand-mono-lake", preload: false });
const spanMono = Space_Mono({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-brand-mono-span", preload: false });
const brandFonts = BRAND.id ? ` ${brandHead.variable} ${brandBody.variable} ${lakeMono.variable} ${spanMono.variable}` : "";

export const metadata: Metadata = {
  title: BRAND.productName,
  description: "Ask business questions in plain language; answers come from MongoDB and render as interactive OpenUI views.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0a08" },
    { media: "(prefers-color-scheme: light)", color: "#faf7f0" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-brand={BRAND.id ?? undefined}
      // Read by the composer footnote in brand.css; CSS content cannot import brand.ts.
      style={BRAND.id ? ({ "--b-disclaimer": JSON.stringify(BRAND.disclaimer) } as React.CSSProperties) : undefined}
    >
      <head>
        {/* @openuidev/react-lang auto-mounts the OpenUI Inspect widget (the
            floating dog button, bottom-right) in development unless this
            global flag is already set. Runs before any app bundle. */}
        <script
          dangerouslySetInnerHTML={{ __html: 'globalThis[Symbol.for("openui.devtools.autoMount")]=true;' }}
        />
      </head>
      <body className={`${sans.variable} ${display.variable}${brandFonts}`}>
        {children}
      </body>
    </html>
  );
}
