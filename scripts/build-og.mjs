// Build-time only: render public/og.svg -> public/og.png (1200x630) so social
// platforms (which don't render SVG previews) show a proper share image.
// Run with: bun run scripts/build-og.mjs
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";

const svg = readFileSync(new URL("../public/og.svg", import.meta.url), "utf8");

const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  background: "#080b12",
  font: { loadSystemFonts: true },
});

const png = resvg.render().asPng();
writeFileSync(new URL("../public/og.png", import.meta.url), png);
console.log(`wrote public/og.png (${png.length} bytes)`);
