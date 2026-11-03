import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/cli/main.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  // package.json is "type": "module", so plain .js is ESM and matches the `bin` entries.
  fixedExtension: false,
  dts: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
