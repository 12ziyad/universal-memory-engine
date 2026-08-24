/* Regenerate the raster favicons from the canonical SVG.
 * The SVG carries a cream tile so the mark stays legible against dark browser
 * chrome; the PNG fallbacks must be rendered from that same source or a
 * bookmark bar shows the old ink-on-transparent version. */
import sharp from "sharp";
import { readFileSync, statSync } from "node:fs";

const svg = readFileSync("public/assets/brand/itsuki-bonsai-favicon.svg");
const jobs = [
	["public/assets/brand/itsuki-bonsai-favicon-16.png", 16],
	["public/assets/brand/itsuki-bonsai-favicon-32.png", 32],
	["public/assets/brand/itsuki-bonsai-favicon-48.png", 48],
	["public/assets/brand/itsuki-bonsai-apple-180.png", 180],
];

for (const [out, size] of jobs) {
	await sharp(svg, { density: 512 }).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
	console.log(`${out} ${size}px ${statSync(out).size}b`);
}
