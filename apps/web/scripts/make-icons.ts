/**
 * Renders the app's icons from public/logos/magnetcut/icon.svg.
 *
 * - public/favicon.ico: 16, 32 and 48 px, cropped to the tile (no margin at
 *   that size), as PNGs inside the ICO.
 * - the path given with --png: the full 1024 px icon, margin included, which
 *   the desktop shell's icon generator takes.
 *
 * Run: bun scripts/make-icons.ts [--png <path>]
 * Deps: sharp (a devDependency)
 */

import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const ICON_SVG = join(PUBLIC_DIR, "logos", "magnetcut", "icon.svg");
const FAVICON_SIZES = [16, 32, 48];
// The tile in icon.svg: Apple's 824 px grid inside the 1024 px canvas.
const TILE_VIEWBOX = "100 100 824 824";

async function renderPng({
	svg,
	size,
}: {
	svg: string;
	size: number;
}): Promise<Buffer> {
	// Rendered at 4x and scaled down, so small sizes keep their edges.
	return sharp(Buffer.from(svg), { density: (72 * size * 4) / 1024 })
		.resize(size, size)
		.png()
		.toBuffer();
}

// An ICO is a header, one 16-byte entry per image, then the images; PNG data
// is allowed as the image since Windows Vista.
function packIco({
	images,
}: {
	images: Array<{ size: number; png: Buffer }>;
}): Buffer {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, png }, index) => {
		const entry = 6 + 16 * index;
		header.writeUInt8(size >= 256 ? 0 : size, entry);
		header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
		header.writeUInt8(0, entry + 2);
		header.writeUInt8(0, entry + 3);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(png.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += png.length;
	});
	return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

async function main() {
	const svg = await readFile(ICON_SVG, "utf8");
	const tileSvg = svg.replace(
		'viewBox="0 0 1024 1024"',
		`viewBox="${TILE_VIEWBOX}"`,
	);

	const images = await Promise.all(
		FAVICON_SIZES.map(async (size) => ({
			size,
			png: await renderPng({ svg: tileSvg, size }),
		})),
	);
	await writeFile(join(PUBLIC_DIR, "favicon.ico"), packIco({ images }));
	console.log(`favicon.ico: ${FAVICON_SIZES.join(", ")} px`);

	const pngFlag = process.argv.indexOf("--png");
	if (pngFlag !== -1) {
		const target = process.argv[pngFlag + 1];
		await writeFile(target, await renderPng({ svg, size: 1024 }));
		console.log(`${target}: 1024 px`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
