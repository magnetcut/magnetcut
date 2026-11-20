import { describe, expect, test } from "bun:test";
import { confirmsDeletion } from "../delete-project-dialog";

describe("deleting projects", () => {
	test("needs DELETE typed", () => {
		expect(confirmsDeletion({ typed: "" })).toBe(false);
		expect(confirmsDeletion({ typed: "DELET" })).toBe(false);
		expect(confirmsDeletion({ typed: "DELETE IT" })).toBe(false);
		expect(confirmsDeletion({ typed: "DELETE" })).toBe(true);
		expect(confirmsDeletion({ typed: " delete " })).toBe(true);
	});
});
