// Cloudflare Worker entry: the OpenNext site unchanged, plus a cron job that
// keeps the Render backend awake. Render's free plan sleeps after ~15 minutes
// without traffic and then takes 30-60 s to start, which shows as
// "Waking up the server..." in the UI. The cron in wrangler.jsonc calls this
// every 10 minutes so the first visitor never waits.
import handler from "./.open-next/worker.js";

export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";

const DEFAULT_BACKEND_URL = "https://queryable-chatbot-api.onrender.com";

const worker = {
  fetch: handler.fetch,

  async scheduled(_controller, env, ctx) {
    const base = (env.BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
    ctx.waitUntil(
      fetch(`${base}/api/livez`, {
        headers: { "user-agent": "queryable-chatbot-keep-warm" },
        signal: AbortSignal.timeout(90_000),
      })
        .then((res) => console.log(`keep-warm ${res.status}`))
        .catch((err) => console.log(`keep-warm failed: ${err}`)),
    );
  },
};

export default worker;
