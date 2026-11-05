// Cloudflare's build machines allow few open files. OpenNext's code patcher
// opens every traced server file at once (2,000+ with per-icon chunks) and
// fails with "EMFILE: too many open files". This rewrites that one loop to
// work through the files 32 at a time. Safe to run more than once.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = "dist/build/patch/codePatcher.js";
const file = [
  path.join(app, "node_modules/@opennextjs/aws", rel),
  path.join(app, "node_modules/@opennextjs/cloudflare/node_modules/@opennextjs/aws", rel),
].find((candidate) => existsSync(candidate));
if (!file) {
  console.warn("OpenNext code patcher not found; EMFILE patch not applied.");
  process.exit(0);
}

let src = readFileSync(file, "utf8");
if (src.includes("__mapLimit")) {
  console.log("OpenNext code patcher already limited.");
  process.exit(0);
}
const head = "await Promise.all(tracedFiles.map(async (filePath) => {";
if (!src.includes(head)) {
  console.warn("OpenNext code patcher changed; EMFILE patch not applied.");
  process.exit(0);
}
src = src.replace(head, "await __mapLimit(tracedFiles, (async (filePath) => {");
src += `
async function __mapLimit(items, fn, limit = 32) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const item = items[next++];
            await fn(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
`;
writeFileSync(file, src);
console.log("Limited OpenNext code patcher to 32 open files at a time.");
