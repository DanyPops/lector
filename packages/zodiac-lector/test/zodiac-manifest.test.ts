import { describe, expect, it } from "bun:test";
import packageJson from "../package.json";
import contribution from "../src/zodiac-entry.ts";

describe("package-owned Zodiac entry", () => {
	it("declares one bounded editor entry and default-exports the real Lector contribution", () => {
		expect(packageJson.zodiac).toEqual({ integrations: [{ kind: "editor", entry: "./dist/zodiac-entry.js" }] });
		expect(contribution.describe()).toMatchObject({ id: "lector", title: "Lector", resourceSchemes: ["lector"] });
	});
});
