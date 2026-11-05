// Preloaded into every Node process of the Cloudflare build (NODE_OPTIONS
// --require). Cloudflare's build machines allow few open files, and the
// OpenNext build reads/writes thousands of server chunks at once, failing
// with "EMFILE: too many open files". This caps concurrent fs.promises file
// operations and retries any call that still hits EMFILE/ENFILE.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");

const MAX_ACTIVE = 64;
const RETRIES = 60;
let active = 0;
const waiting = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tooMany = (error) => error && (error.code === "EMFILE" || error.code === "ENFILE");

async function acquire() {
  while (active >= MAX_ACTIVE) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}
function release() {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

function guardPromise(fn, limit) {
  return async function guarded(...args) {
    if (limit) await acquire();
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await fn.apply(this, args);
        } catch (error) {
          if (!tooMany(error) || attempt >= RETRIES) throw error;
          await sleep(25 * (attempt + 1));
        }
      }
    } finally {
      if (limit) release();
    }
  };
}

for (const name of ["readFile", "writeFile", "appendFile", "copyFile"]) {
  if (typeof fsp[name] === "function") fsp[name] = guardPromise(fsp[name], true);
}
// open() hands back a handle the caller keeps, so only retry it.
if (typeof fsp.open === "function") fsp.open = guardPromise(fsp.open, false);

// Callback APIs: retry on EMFILE after a short wait.
for (const name of ["open", "readFile", "writeFile", "copyFile"]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function guardedCallback(...args) {
    const callback = args[args.length - 1];
    if (typeof callback !== "function") return original.apply(this, args);
    let attempt = 0;
    const run = () =>
      original.apply(this, [
        ...args.slice(0, -1),
        (error, ...rest) => {
          if (tooMany(error) && attempt < RETRIES) {
            attempt += 1;
            setTimeout(run, 25 * attempt);
            return;
          }
          callback(error, ...rest);
        },
      ]);
    run();
  };
}

syncBuiltinESMExports();
