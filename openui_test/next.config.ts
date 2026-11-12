import type { NextConfig } from "next";

// The browser only ever talks to this Next.js origin. Every /api/* call is
// forwarded to the FastAPI backend, which owns authentication, routing,
// MongoDB access and all API keys.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
const isDev = process.env.NODE_ENV !== "production";

// Content-Security-Policy. Everything is served from this origin (API calls
// go through the /api rewrite), so scripts, fonts and fetches are 'self'.
// 'unsafe-inline' scripts are needed by Next.js without per-request nonces;
// the policy still blocks plugins, foreign scripts and fetches, <base>
// hijacking, framing and cross-site form posts. Dev adds eval + HMR sockets.
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  // Next 16.3 + Vercel's adapter skips next-server.js.nft.json when standalone
  // is on; Vercel ignores standalone anyway. Keep it for Docker / self-host.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  // Keep streamed (SSE) chat responses unbuffered through the rewrite.
  compress: false,
  turbopack: {
    root: process.cwd(),
  },
  experimental: {
    turbopackMinify: false,
    // Chat answers can take longer than the 30 s default proxy timeout.
    proxyTimeout: 180_000,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
          // Browsers ignore HSTS on plain HTTP, so this is safe on localhost.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
