import { describe, expect, it } from "bun:test";
import { assertAbsolutePath, RelativeWorkspacePath } from "../../src/domain/assert-absolute-path.ts";

describe("assertAbsolutePath", () => {
	it("accepts a real absolute path without throwing", () => {
		expect(() => assertAbsolutePath("/home/user/project")).not.toThrow();
	});

	it("rejects a relative path, naming it in the error", () => {
		expect(() => assertAbsolutePath(".")).toThrow(RelativeWorkspacePath);
		expect(() => assertAbsolutePath("./project")).toThrow(RelativeWorkspacePath);
		expect(() => assertAbsolutePath("project/src")).toThrow(RelativeWorkspacePath);
		expect(() => assertAbsolutePath("..")).toThrow(RelativeWorkspacePath);
		try {
			assertAbsolutePath("relative/dir");
		} catch (error) {
			expect(error).toBeInstanceOf(RelativeWorkspacePath);
			expect((error as RelativeWorkspacePath).path).toBe("relative/dir");
			expect((error as Error).message).toContain("relative/dir");
		}
	});

	it("rejects an empty string -- never resolvable against anything meaningful", () => {
		expect(() => assertAbsolutePath("")).toThrow(RelativeWorkspacePath);
	});
});
