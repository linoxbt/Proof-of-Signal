// MapLibre GL JS v6 loads its web worker from a URL next to the main module.
// Bundlers rename chunks, so copy the self-contained worker into public/ and
// point MapLibre at it with setWorkerUrl() (see src/components/map/deck-map.tsx).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("maplibre-gl/package.json"));
const outDir = path.join(here, "..", "public", "vendor");
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(pkgDir, "dist", "maplibre-gl-worker.mjs"), path.join(outDir, "maplibre-gl-worker.mjs"));
console.log("copied maplibre-gl-worker.mjs to public/vendor/");
