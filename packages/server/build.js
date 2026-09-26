// Bundles the server and the workspace packages it imports (shipped as
// TypeScript source) into one ESM file for production and the Docker image.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/server.mjs',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  // Bundled CommonJS dependencies call require(); give them one in ESM.
  banner: {
    js: "import { createRequire as __vwCreateRequire } from 'node:module'; const require = __vwCreateRequire(import.meta.url);",
  },
});
