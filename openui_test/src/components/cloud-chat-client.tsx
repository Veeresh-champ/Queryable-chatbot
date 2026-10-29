"use client";

import dynamic from "next/dynamic";

/**
 * Browser-only <CloudChat>. The chat app needs a signed-in session and runs
 * entirely client-side, so skipping SSR keeps @openuidev/react-ui and the
 * chart libraries out of the server bundle (Cloudflare's 3 MiB Worker limit).
 */
const CloudChat = dynamic(() => import("@/components/cloud-chat"), { ssr: false });

export default CloudChat;
