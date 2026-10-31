import { beforeAll, describe, expect, test } from "bun:test";
import { registerDefaultMasks } from "@/masks";
import { buildHideRegionMask } from "../region";
import {
	followRegion,
	maskToRegion,
	regionToMaskParams,
	type TrackFrame,
} from "../track";

beforeAll(() => registerDefaultMasks());

const WIDTH = 160;
const HEIGHT = 120;

/** Noise over the picture, and a square with a smooth pattern of its own. */
function frame({
	x,
	y,
	side,
}: {
	x: number;
	y: number;
	side: number;
}): TrackFrame {
	const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
	for (let py = 0; py < HEIGHT; py++) {
		for (let px = 0; px < WIDTH; px++) {
			const dx = px - x;
			const dy = py - y;
			let grey: number;
			if (Math.abs(dx) < side / 2 && Math.abs(dy) < side / 2) {
				const u = dx / side;
				const v = dy / side;
				grey =
					0.5 +
					0.25 *
						Math.sin(2 * Math.PI * 2 * u) *
						Math.cos(2 * Math.PI * 1.5 * v) +
					0.15 * Math.sin(2 * Math.PI * (u + 2 * v));
			} else {
				const hash = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453;
				grey = 0.3 + 0.4 * (hash - Math.floor(hash));
			}
			const at = (py * WIDTH + px) * 4;
			rgba[at] = rgba[at + 1] = rgba[at + 2] = Math.round(grey * 255);
			rgba[at + 3] = 255;
		}
	}
	return { rgba, width: WIDTH, height: HEIGHT };
}

describe("followRegion", () => {
	test("follows a square across the frames", async () => {
		const frames = async function* () {
			for (let i = 1; i <= 20; i++) {
				yield frame({ x: 40 + 2 * i, y: 40 + i, side: 30 });
			}
		};
		const { found, isLost } = await followRegion({
			start: frame({ x: 40, y: 40, side: 30 }),
			region: { centerX: 40, centerY: 40, width: 30, height: 30 },
			frames: frames(),
		});
		expect(isLost).toBe(false);
		expect(found).toHaveLength(20);
		const last = found[19];
		expect(Math.hypot(last.centerX - 80, last.centerY - 60)).toBeLessThan(1.5);
	});

	test("stops where the square is gone", async () => {
		const frames = async function* () {
			yield frame({ x: 42, y: 41, side: 30 });
			yield frame({ x: 44, y: 42, side: 0 });
			yield frame({ x: 46, y: 43, side: 30 });
		};
		const { found, isLost } = await followRegion({
			start: frame({ x: 40, y: 40, side: 30 }),
			region: { centerX: 40, centerY: 40, width: 30, height: 30 },
			frames: frames(),
		});
		expect(isLost).toBe(true);
		expect(found).toHaveLength(1);
	});
});

describe("a mask as a region", () => {
	test("goes there and back", () => {
		const size = { width: 640, height: 360 };
		const mask = buildHideRegionMask({ shape: "plate", canvasSize: size });
		const region = maskToRegion({ mask, size });
		expect(region?.centerX).toBeCloseTo(320);
		expect(region?.centerY).toBeCloseTo(180);
		const params = region ? regionToMaskParams({ region, size }) : {};
		expect(params.centerX).toBeCloseTo(0);
		expect("width" in mask.params && params.width).toBeCloseTo(
			"width" in mask.params ? mask.params.width : 0,
		);
	});
});
