/**
 * Fixture self-test discipline (Alef's own `Evaluation.fixture` pattern, applied throughout this
 * repo's eval work): hand-apply the CORRECT mutation for each CTF task to a real materialized
 * fixture copy, and confirm its own checker actually recognizes it as a pass -- a checker that
 * can't recognize a known-correct answer is worthless before it's ever run against a real trace.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS } from "../../../benchmarks/eval/ctf-corpus.ts";
import { materializeTypeScriptReferenceFixture, type TypeScriptReferenceFixture } from "../../support/typescript-reference-fixture.ts";

let fixture: TypeScriptReferenceFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("CTF_CORPUS", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers rename, move, and extract-interface categories", () => {
		const categories = new Set(CTF_CORPUS.map((task) => task.category));
		expect(categories).toEqual(new Set(["rename", "move", "extract-interface"]));
	});

	it("rename-runCheckout-to-executeCheckout: scores a real correct rename as a full pass", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const path = join(fixture.root, "packages/app/src/checkout.ts");
		const original = await readFile(path, "utf-8");
		await writeFile(path, original.replace(/runCheckout\b/g, "executeCheckout").replace("executeCheckoutTwice", "runCheckoutTwice"));

		const task = CTF_CORPUS.find((entry) => entry.id === "rename-runCheckout-to-executeCheckout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 30_000);

	it("rename-runCheckout-to-executeCheckout: scores an incomplete rename (a missed call site) as a failure", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const path = join(fixture.root, "packages/app/src/checkout.ts");
		// Renames the declaration but leaves the call inside runCheckoutTwice unchanged -- a real,
		// plausible mistake this checker must actually catch, not merely assume it would.
		const original = await readFile(path, "utf-8");
		await writeFile(path, original.replace("export async function runCheckout(", "export async function executeCheckout("));

		const task = CTF_CORPUS.find((entry) => entry.id === "rename-runCheckout-to-executeCheckout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);

	it("move-runCheckoutTwice-to-new-file: scores a real correct move as a full pass", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");
		const batchPath = join(fixture.root, "packages/app/src/checkout-batch.ts");
		const original = await readFile(checkoutPath, "utf-8");

		await writeFile(
			checkoutPath,
			'import type { Order, PaymentProcessor, Receipt } from "@fixture/contracts";\n\n' +
				"export async function runCheckout(processor: PaymentProcessor, order: Order): Promise<Receipt> {\n" +
				"\treturn processor.process(order);\n}\n",
		);
		await writeFile(
			batchPath,
			'import type { Order, PaymentProcessor, Receipt } from "@fixture/contracts";\n' +
				'import { runCheckout } from "./checkout.js";\n\n' +
				"export async function runCheckoutTwice(processor: PaymentProcessor, order: Order): Promise<readonly Receipt[]> {\n" +
				"\treturn Promise.all([runCheckout(processor, order), runCheckout(processor, order)]);\n}\n",
		);
		void original;

		const task = CTF_CORPUS.find((entry) => entry.id === "move-runCheckoutTwice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 30_000);

	it("move-runCheckoutTwice-to-new-file: scores a copy-not-move (left behind in the old file) as a failure", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");
		const batchPath = join(fixture.root, "packages/app/src/checkout-batch.ts");
		const original = await readFile(checkoutPath, "utf-8");
		// Copies runCheckoutTwice into the new file but never removes it from checkout.ts.
		await writeFile(batchPath, original);

		const task = CTF_CORPUS.find((entry) => entry.id === "move-runCheckoutTwice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 30_000);

	it("extract-interface-from-StripeProcessor: scores a real correct extraction as a full pass", async () => {
		fixture = materializeTypeScriptReferenceFixture();
		const path = join(fixture.root, "packages/app/src/stripe.ts");
		await writeFile(
			path,
			'import type { Order, PaymentProcessor, Receipt } from "@fixture/contracts";\n\n' +
				"export interface Processor {\n\tprocess(order: Order): Promise<Receipt>;\n}\n\n" +
				"export class StripeProcessor implements PaymentProcessor, Processor {\n" +
				"\tasync process(order: Order): Promise<Receipt> {\n" +
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal TS source text being written to a file, not a template string in this test itself.
				"\t\treturn Promise.resolve({ transactionId: `stripe:${order.id}:${order.amountCents}` });\n\t}\n}\n\n" +
				"export interface ProcessorFactory {\n\tcreate(): PaymentProcessor;\n}\n\n" +
				"export class StripeProcessorFactory implements ProcessorFactory {\n" +
				"\tcreate(): StripeProcessor {\n\t\treturn new StripeProcessor();\n\t}\n}\n",
		);

		const task = CTF_CORPUS.find((entry) => entry.id === "extract-interface-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 30_000);
});
