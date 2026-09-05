#!/usr/bin/env node
/**
 * Renders the brand SVGs to PNGs for ecosystem listings and form uploads.
 *
 *   node scripts/make-logo-png.mjs
 *
 * Writes into web/public/brand/. Most listing forms reject SVG and want a square raster, so the
 * primary output is a 1024x1024 square with the mark centred on transparency.
 *
 * The wordmark SVG paints its text with `currentColor`, which resolves to black when rendered
 * standalone rather than inside the page. Each wordmark variant therefore substitutes an explicit
 * colour before rasterising.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const out = join(pub, "brand");
mkdirSync(out, { recursive: true });

const mark = readFileSync(join(pub, "mark.svg"), "utf8");
const lockup = readFileSync(join(pub, "logo.svg"), "utf8");

/** Strips the outer <svg> tag so the guts can be re-mounted on a different canvas. */
function innerOf(svg) {
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

/**
 * Centres the 72x104 mark on a square canvas.
 * Scaled to 78% of the canvas height so it has breathing room inside a circular avatar crop,
 * which is how most ecosystem pages display it.
 */
function squareMark(bg) {
  const S = 128;
  const h = S * 0.78;
  const scale = h / 104;
  const w = 72 * scale;
  const bgRect = bg ? `<rect width="${S}" height="${S}" rx="28" fill="${bg}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
${bgRect}
<g transform="translate(${(S - w) / 2} ${(S - h) / 2}) scale(${scale})">
${innerOf(mark)}
</g>
</svg>`;
}

function wordmark(color, bg) {
  const W = 320, H = 104, PAD = 16;
  const bgRect = bg ? `<rect width="${W + PAD * 2}" height="${H + PAD * 2}" fill="${bg}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + PAD * 2} ${H + PAD * 2}" width="${W + PAD * 2}" height="${H + PAD * 2}">
${bgRect}
<g transform="translate(${PAD} ${PAD})">
${innerOf(lockup).replace(/currentColor/g, color)}
</g>
</svg>`;
}

const jobs = [
  ["nimseal-logo-1024.png", squareMark(null), 1024, 1024],
  ["nimseal-logo-512.png", squareMark(null), 512, 512],
  ["nimseal-logo-dark-1024.png", squareMark("#0B0B12"), 1024, 1024],
  ["nimseal-logo-white-1024.png", squareMark("#FFFFFF"), 1024, 1024],
  ["nimseal-wordmark-dark-text.png", wordmark("#0F172A", null), 1408, 528],
  ["nimseal-wordmark-light-text.png", wordmark("#FFFFFF", null), 1408, 528],
];

for (const [name, svg, w, h] of jobs) {
  const buf = await sharp(Buffer.from(svg)).resize(w, h, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(out, name), buf);
  console.log(`${name.padEnd(34)} ${w}x${h}  ${(buf.length / 1024).toFixed(0)} KB`);
}

console.log(`\nWrote ${jobs.length} files to web/public/brand/`);
