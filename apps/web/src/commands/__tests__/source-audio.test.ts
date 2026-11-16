import { expect, test } from "bun:test";
import { ToggleSourceAudioSeparationCommand } from "@/commands";
import { clip, openEditor, s, tracksWith } from "./editor";

test("extracting both clips' sound at a crossfade puts them on two tracks, overlapping across it", () => {
	const editor = openEditor({
		tracks: tracksWith({
			elements: [
				clip({ id: "one", start: 0, length: 5, params: { echoEnabled: true } }),
				clip({ id: "two", start: 5, length: 5 }),
			],
			transitions: [
				{
					id: "dissolve",
					fromElementId: "one",
					toElementId: "two",
					type: "cross-dissolve",
					duration: s(1),
					alignment: "center",
					params: {},
					crossfadeAudio: true,
				},
			],
		}),
	});

	for (const elementId of ["one", "two"]) {
		editor.command.execute({
			command: new ToggleSourceAudioSeparationCommand({
				trackId: "main",
				elementId,
			}),
		});
	}

	// Each track's clips, by seconds, and whether its echo is on.
	const spans = editor.scenes
		.getActiveScene()
		.tracks.audio.map((track) =>
			track.elements.map((element) => [
				element.startTime / s(1),
				(element.startTime + element.duration) / s(1),
				element.params.echoEnabled === true,
			]),
		)
		.sort(([a], [b]) => Number(a[0]) - Number(b[0]));
	expect(spans).toEqual([[[0, 5.5, true]], [[4.5, 10, false]]]);
});
