import { describe, expect, test } from "bun:test";
import { HOLD_SETTLE_MS, OutputHold } from "../compositor/output-hold";

/** A canvas with what the hold reads and sets: what was copied into it. */
function fakeCanvas({ name }: { name: string }) {
	const copied: string[] = [];
	const canvas = {
		name,
		width: 1920,
		height: 1080,
		style: {} as Record<string, string>,
		copied,
		getContext: () => ({
			drawImage: (source: { name: string }) => copied.push(source.name),
		}),
	};
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a stand-in with only what the hold uses.
	return canvas as unknown as HTMLCanvasElement & {
		name: string;
		copied: string[];
	};
}

describe("the preview's frame held while frames are drawn for others", () => {
	test("is copied once, over the canvas it hides, until the preview draws", () => {
		let now = 0;
		const cover = fakeCanvas({ name: "cover" });
		const hold = new OutputHold({ createCanvas: () => cover, now: () => now });
		const output = fakeCanvas({ name: "output" });

		hold.hold({ output });
		expect(cover.copied).toEqual(["output"]);
		expect(cover.style.display).toBe("block");
		expect(output.style.visibility).toBe("hidden");
		// A second frame for someone else: the preview's copy stays.
		hold.hold({ output });
		expect(cover.copied).toEqual(["output"]);

		// Still drawing for others: the preview waits.
		now += HOLD_SETTLE_MS - 1;
		expect(hold.isSettled()).toBe(false);
		now += 1;
		expect(hold.isSettled()).toBe(true);

		hold.release({ output });
		expect(hold.isHeld()).toBe(false);
		expect(cover.style.display).toBe("none");
		expect(output.style.visibility).toBe("");
		expect(cover.width).toBe(0);
	});

	test("hides a canvas made while held", () => {
		const hold = new OutputHold({
			createCanvas: () => fakeCanvas({ name: "cover" }),
		});
		hold.hold({ output: null });
		expect(hold.isHeld()).toBe(true);
		const output = fakeCanvas({ name: "output" });
		hold.hold({ output });
		expect(output.style.visibility).toBe("hidden");
	});
});
