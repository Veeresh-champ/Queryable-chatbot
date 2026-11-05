import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // CommonJS build helpers (e.g. scripts/emfile-guard.cjs) must use require().
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Archived pre-refactor copies; not part of the build.
    "legacy/**",
    // Cloudflare (OpenNext/wrangler) build output.
    ".open-next/**",
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
