import { describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RetryingLectorClient } from "../../extension/src/lector-client.ts";
import { CachingOverlay } from "../../extension/src/workspace-cache/caching-overlay.ts";

function fakeClient(call: (operation: string, input: unknown) => Promise<unknown>): RetryingLectorClient {
	return {
		call: call as RetryingLectorClient["call"],
		callOnce: call as RetryingLectorClient["callOnce"],
	};
}

describe("CachingOverlay", () => {
	it("queries only caching jobs owned by its Pi session", async () => {
		let capturedInput: unknown;
		const overlay = new CachingOverlay(
			async () =>
				fakeClient(async (_operation, input) => {
					capturedInput = input;
					return { jobs: [] };
				}),
			"session-a",
		);
		overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
		await overlay.refresh();
		expect(capturedInput).toEqual({ ownerId: "session-a" });
	});

	it("registers the widget once refresh() finds at least one active caching job", async () => {
		let registeredKey: string | undefined;
		const uiCtx = {
			setWidget: (key: string, factory: unknown) => {
				if (factory !== undefined) registeredKey = key;
			},
		} as unknown as ExtensionUIContext;

		const overlay = new CachingOverlay(async () => fakeClient(async () => ({ jobs: [{ workspaceId: "ws-a", status: "running" }] })));
		overlay.setUI(uiCtx);
		await overlay.refresh();

		expect(registeredKey).toBeDefined();
	});

	it("hides (unregisters) the widget once refresh() finds nothing caching", async () => {
		let jobs: unknown[] = [{ workspaceId: "ws-a", status: "running" }];
		const setWidgetCalls: unknown[] = [];
		const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;

		const overlay = new CachingOverlay(async () => fakeClient(async () => ({ jobs })));
		overlay.setUI(uiCtx);
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeDefined();

		jobs = [];
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeUndefined();
	});

	it("never throws, even when the daemon is unreachable or rendering itself fails", async () => {
		const overlay = new CachingOverlay(async () => {
			throw new Error("daemon unavailable");
		});
		overlay.setUI({} as ExtensionUIContext);
		await expect(overlay.refresh()).resolves.toBeUndefined();
	});

	it("does nothing (no throw) when refresh() is called before setUI()", async () => {
		const overlay = new CachingOverlay(async () => fakeClient(async () => ({ jobs: [{ workspaceId: "ws-a", status: "running" }] })));
		await expect(overlay.refresh()).resolves.toBeUndefined();
	});

	it("startPolling/stopPolling/dispose manage a bounded fallback poll, same as every other overlay in this ecosystem", async () => {
		let calls = 0;
		const overlay = new CachingOverlay(async () =>
			fakeClient(async () => {
				calls += 1;
				return { jobs: [] };
			}),
		);
		overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);

		overlay.startPolling(5);
		await new Promise((resolve) => setTimeout(resolve, 25));
		overlay.stopPolling();
		const callsAfterStop = calls;
		expect(callsAfterStop).toBeGreaterThan(0);

		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(calls).toBe(callsAfterStop);

		overlay.dispose();
	});

	it("dispose() unregisters the widget and stops polling", async () => {
		const setWidgetCalls: unknown[] = [];
		const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;
		const overlay = new CachingOverlay(async () => fakeClient(async () => ({ jobs: [{ workspaceId: "ws-a", status: "running" }] })));
		overlay.setUI(uiCtx);
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeDefined();

		overlay.dispose();
		expect(setWidgetCalls.at(-1)).toBeUndefined();
	});
});
