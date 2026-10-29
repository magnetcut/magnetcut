/**
 * Draws the app's icon, a horseshoe magnet made of film, and writes the files
 * it goes in.
 *
 * - public/logos/magnetcut/icon.svg: the icon on Apple's 824 px grid inside
 *   1024, shadows included, as macOS drew icons before version 26.
 * - public/logos/magnetcut/symbol.svg: the magnet alone, flat white, for the
 *   menus.
 * - public/favicon.ico: 16, 32 and 48 px, cropped to the tile (no margin at
 *   that size), as PNGs inside the ICO.
 * - ../desktop/icons/MagnetCut.icon: the layers as Icon Composer saves them,
 *   full bleed. actool (Xcode 26 or later) compiles them into the icon that
 *   macOS 26 shapes and lights itself. On a tile of its own, as in icon.svg,
 *   the icon would sit in a grey frame there.
 * - the path given with --png: the full 1024 px icon, margin included, for
 *   the desktop shell's icon generator. In apps/desktop,
 *   `cargo tauri icon <png> -o icons`, then delete the android and ios
 *   folders it adds.
 *
 * Run: bun scripts/make-icons.ts [--png <path>]
 * Deps: sharp (a devDependency)
 */

import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const LOGO_DIR = join(PUBLIC_DIR, "logos", "magnetcut");
const ICON_LAYERS = join(
	__dirname,
	"..",
	"..",
	"desktop",
	"icons",
	"MagnetCut.icon",
);
const FAVICON_SIZES = [16, 32, 48];
const NOTICE = "<!-- Drawn by apps/web/scripts/make-icons.ts. -->";

// The tile: Apple's 824 px grid inside the 1024 px canvas.
const TILE = { inset: 100, side: 824, radius: 185 };

// The magnet upright, open at the top, with its bend centred on (0, 0).
const OUTER = 250; // the bend's outer radius
const INNER = 100; // and its inner one
const ARM = OUTER - INNER;
const HEIGHT = 235; // from the bend's centre to the top of the poles
const POLE = 112; // a pole's length, with the gap under it
const GAP = 14; // between a pole and the body: the cut
// Tilted, and placed where it looks centred on the tile.
const PLACE = { x: 466, y: 548, tilt: 40 };

// Film perforations along both edges, square, turned with the strip.
const HOLE = 22;
const HOLE_INSET = 29; // from the strip's edge to a hole's centre
const HOLE_STEP = 46; // between holes' centres

const round = (value: number) => Number(value.toFixed(1));

function bodyPath(): string {
	const top = -HEIGHT + POLE;
	return [
		`M ${-OUTER} ${top}`,
		`L ${-OUTER} 0`,
		`A ${OUTER} ${OUTER} 0 0 0 ${OUTER} 0`,
		`L ${OUTER} ${top}`,
		`L ${INNER} ${top}`,
		`L ${INNER} 0`,
		`A ${INNER} ${INNER} 0 0 1 ${-INNER} 0`,
		`L ${-INNER} ${top}`,
		"Z",
	].join(" ");
}

// Each pole is a rectangle per paint, one over the other, from its top left
// corner.
function poles({ paints }: { paints: string[] }): string {
	return [-OUTER, INNER]
		.map(
			(x) =>
				`<g transform="translate(${x} ${-HEIGHT})">${paints
					.map(
						(paint) =>
							`<rect width="${ARM}" height="${POLE - GAP}" rx="14" ${paint}/>`,
					)
					.join("")}</g>`,
		)
		.join("\n");
}

function perforations(): string {
	const holes: string[] = [];
	const hole = ({ x, y, angle }: { x: number; y: number; angle: number }) =>
		holes.push(
			`<rect x="${-HOLE / 2}" y="${-HOLE / 2}" width="${HOLE}" height="${HOLE}" rx="4.5" transform="translate(${round(x)} ${round(y)}) rotate(${round(angle)})"/>`,
		);
	for (const radius of [OUTER - HOLE_INSET, INNER + HOLE_INSET]) {
		// Round the bend from left to right, spaced as near the step as fits.
		const count = Math.round((Math.PI * radius) / HOLE_STEP);
		for (let i = 0; i <= count; i++) {
			const angle = Math.PI * (1 - i / count);
			hole({
				x: Math.cos(angle) * radius,
				y: Math.sin(angle) * radius,
				angle: (angle * 180) / Math.PI + 90,
			});
		}
		// Then up both arms, short of the poles.
		for (let y = -HOLE_STEP; y >= -HEIGHT + POLE + 26; y -= HOLE_STEP) {
			hole({ x: -radius, y, angle: 90 });
			hole({ x: radius, y, angle: 90 });
		}
	}
	return holes.join("\n");
}

// Across the strip, from its inner edge to its outer one: shade, a highlight
// towards the outside, shade again. A tube, lit from the front.
function tubeStops(): string {
	const inner = INNER / OUTER;
	const at = (fraction: number) =>
		Number((inner + (1 - inner) * fraction).toFixed(3));
	return [
		`<stop offset="0" stop-color="#000" stop-opacity="0.2"/>`,
		`<stop offset="${at(0)}" stop-color="#000" stop-opacity="0.2"/>`,
		`<stop offset="${at(0.3)}" stop-color="#fff" stop-opacity="0"/>`,
		`<stop offset="${at(0.62)}" stop-color="#fff" stop-opacity="0.26"/>`,
		`<stop offset="${at(0.82)}" stop-color="#fff" stop-opacity="0"/>`,
		`<stop offset="1" stop-color="#000" stop-opacity="0.22"/>`,
	].join("\n");
}

// The red film body, its perforations cut out, and steel poles. The bend's
// shading is radial; the arms' is the same across them, reflected.
function magnet({ shadow }: { shadow: boolean }): string {
	const body = bodyPath();
	return `<defs>
<linearGradient id="red" x1="${-OUTER}" y1="${-HEIGHT}" x2="${OUTER}" y2="${OUTER}" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#FF7B63"/>
<stop offset="0.45" stop-color="#F23F4E"/>
<stop offset="1" stop-color="#B8193D"/>
</linearGradient>
<radialGradient id="tube-bend" cx="0" cy="0" r="${OUTER}" gradientUnits="userSpaceOnUse">
${tubeStops()}
</radialGradient>
<linearGradient id="tube-arms" x1="0" y1="0" x2="${OUTER}" y2="0" spreadMethod="reflect" gradientUnits="userSpaceOnUse">
${tubeStops()}
</linearGradient>
<linearGradient id="metal" x1="0" y1="0" x2="${ARM}" y2="0" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#B4BCC8"/>
<stop offset="0.3" stop-color="#FFFFFF"/>
<stop offset="0.55" stop-color="#E6EAF0"/>
<stop offset="1" stop-color="#A3ACB9"/>
</linearGradient>
<linearGradient id="steel" x1="0" y1="0" x2="0" y2="${POLE}" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#FFFFFF"/>
<stop offset="0.55" stop-color="#E4E8EE"/>
<stop offset="1" stop-color="#B9C1CC"/>
</linearGradient>
<clipPath id="bend"><rect x="-400" y="0" width="800" height="400"/></clipPath>
<clipPath id="arms"><rect x="-400" y="-400" width="800" height="400"/></clipPath>
<mask id="film" maskUnits="userSpaceOnUse" x="-400" y="-400" width="800" height="800">
<rect x="-400" y="-400" width="800" height="800" fill="white"/>
<g fill="black">
${perforations()}
</g>
</mask>
${shadow ? `<filter id="magnet-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#05060F" flood-opacity="0.55"/></filter>` : ""}
</defs>
<g transform="translate(${PLACE.x} ${PLACE.y}) rotate(${PLACE.tilt})"${shadow ? ` filter="url(#magnet-shadow)"` : ""}>
<g mask="url(#film)">
<path d="${body}" fill="url(#red)"/>
<path d="${body}" fill="url(#tube-bend)" clip-path="url(#bend)"/>
<path d="${body}" fill="url(#tube-arms)" clip-path="url(#arms)"/>
</g>
${poles({ paints: ['fill="url(#metal)"', 'fill="url(#steel)" opacity="0.35"'] })}
</g>`;
}

// Indigo, lighter at the top, with a glow behind the magnet. Square for the
// layers, which macOS shapes; a rounded tile otherwise.
function background({
	rounded,
	shadow,
}: {
	rounded: boolean;
	shadow: boolean;
}): string {
	const { inset, side } = TILE;
	const radius = rounded ? TILE.radius : 0;
	const rect = `x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}"`;
	return `<defs>
<linearGradient id="indigo" x1="0" y1="${inset}" x2="0" y2="${inset + side}" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#34386A"/>
<stop offset="1" stop-color="#121427"/>
</linearGradient>
<radialGradient id="glow" cx="512" cy="430" r="${round(side * 0.55)}" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#6F78D8" stop-opacity="0.45"/>
<stop offset="1" stop-color="#6F78D8" stop-opacity="0"/>
</radialGradient>
${shadow ? `<filter id="tile-shadow"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.3"/></filter>` : ""}
</defs>
<rect ${rect} fill="url(#indigo)"${shadow ? ` filter="url(#tile-shadow)"` : ""}/>
<rect ${rect} fill="url(#glow)"/>`;
}

// 1024 px wide whatever the view box, so renderPng's density holds.
function svgDocument({
	viewBox,
	body,
}: {
	viewBox: string;
	body: string;
}): string {
	return `<svg width="1024" height="1024" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">\n${NOTICE}\n${body}\n</svg>\n`;
}

const FULL = "0 0 1024 1024";
const TILE_ONLY = `${TILE.inset} ${TILE.inset} ${TILE.side} ${TILE.side}`;

function iconSvg(): string {
	return svgDocument({
		viewBox: FULL,
		body: `${background({ rounded: true, shadow: true })}\n${magnet({ shadow: true })}`,
	});
}

// For the favicon: the tile's shadow would show in its corners.
function tileSvg(): string {
	return svgDocument({
		viewBox: TILE_ONLY,
		body: `${background({ rounded: true, shadow: false })}\n${magnet({ shadow: true })}`,
	});
}

// The view box is the tile, which then fills the canvas.
function layerSvg({ layer }: { layer: "background" | "magnet" }): string {
	return svgDocument({
		viewBox: TILE_ONLY,
		body:
			layer === "background"
				? background({ rounded: false, shadow: false })
				: magnet({ shadow: false }),
	});
}

// The magnet's outline on the canvas: the bend's outside and the poles' outer
// corners, tilted.
function magnetBounds() {
	const points: Array<[number, number]> = [];
	for (let i = 0; i <= 64; i++) {
		const angle = (Math.PI * i) / 64;
		points.push([Math.cos(angle) * OUTER, Math.sin(angle) * OUTER]);
	}
	for (const x of [-OUTER, -INNER, INNER, OUTER]) points.push([x, -HEIGHT]);
	const tilt = (PLACE.tilt * Math.PI) / 180;
	const xs = points.map(
		([x, y]) => PLACE.x + x * Math.cos(tilt) - y * Math.sin(tilt),
	);
	const ys = points.map(
		([x, y]) => PLACE.y + x * Math.sin(tilt) + y * Math.cos(tilt),
	);
	return {
		left: Math.min(...xs),
		top: Math.min(...ys),
		right: Math.max(...xs),
		bottom: Math.max(...ys),
	};
}

// White: the UI inverts it on light themes. No perforations, which would be
// noise at menu size.
function symbolSvg(): string {
	const { left, top, right, bottom } = magnetBounds();
	const side = Math.max(right - left, bottom - top) + 16;
	const x = round((left + right) / 2 - side / 2);
	const y = round((top + bottom) / 2 - side / 2);
	return `<svg width="400" height="400" viewBox="${x} ${y} ${round(side)} ${round(side)}" xmlns="http://www.w3.org/2000/svg">
${NOTICE}
<g transform="translate(${PLACE.x} ${PLACE.y}) rotate(${PLACE.tilt})">
<path d="${bodyPath()}" fill="white"/>
${poles({ paints: ['fill="white"'] })}
</g>
</svg>
`;
}

// As Icon Composer writes it, front to back. The magnet is glass, but solid:
// the background isn't glass at all.
const ICON_JSON = {
	groups: [
		{
			layers: [{ "image-name": "magnet.png", name: "magnet" }],
			translucency: { enabled: false, value: 0 },
		},
		{
			layers: [{ "image-name": "background.png", name: "background" }],
			shadow: { kind: "none", opacity: 0 },
			specular: false,
			translucency: { enabled: false, value: 0 },
		},
	],
	"supported-platforms": { squares: ["macOS"] },
};

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
	const icon = iconSvg();
	await writeFile(join(LOGO_DIR, "icon.svg"), icon);
	await writeFile(join(LOGO_DIR, "symbol.svg"), symbolSvg());
	console.log("icon.svg, symbol.svg");

	const tile = tileSvg();
	const images = await Promise.all(
		FAVICON_SIZES.map(async (size) => ({
			size,
			png: await renderPng({ svg: tile, size }),
		})),
	);
	await writeFile(join(PUBLIC_DIR, "favicon.ico"), packIco({ images }));
	console.log(`favicon.ico: ${FAVICON_SIZES.join(", ")} px`);

	await mkdir(join(ICON_LAYERS, "Assets"), { recursive: true });
	for (const layer of ["background", "magnet"] as const) {
		await writeFile(
			join(ICON_LAYERS, "Assets", `${layer}.png`),
			await renderPng({ svg: layerSvg({ layer }), size: 1024 }),
		);
	}
	await writeFile(
		join(ICON_LAYERS, "icon.json"),
		`${JSON.stringify(ICON_JSON, null, 2)}\n`,
	);
	console.log("MagnetCut.icon: background, magnet");

	const pngFlag = process.argv.indexOf("--png");
	if (pngFlag !== -1) {
		const target = process.argv[pngFlag + 1];
		await writeFile(target, await renderPng({ svg: icon, size: 1024 }));
		console.log(`${target}: 1024 px`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
