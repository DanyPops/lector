/**
 * Same fixture self-test discipline as ctf-corpus.test.ts/ctf-corpus-python.test.ts, applied to
 * the Go corpus.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_GO } from "../../../benchmarks/eval/ctf-corpus-go.ts";
import { type GoReferenceFixture, materializeGoReferenceFixture } from "../../support/go-reference-fixture.ts";

let fixture: GoReferenceFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("CTF_CORPUS_GO", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_GO.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers rename, move, and extract-interface categories", () => {
		const categories = new Set(CTF_CORPUS_GO.map((task) => task.category));
		expect(categories).toEqual(new Set(["rename", "move", "extract-interface"]));
	});

	it("rename-RunCheckout-to-ExecuteCheckout: scores a real correct rename as a full pass", async () => {
		fixture = materializeGoReferenceFixture();
		const path = join(fixture.root, "app/checkout.go");
		const original = await readFile(path, "utf-8");
		await writeFile(path, original.replace(/RunCheckout\b/g, "ExecuteCheckout").replace("ExecuteCheckoutTwice", "RunCheckoutTwice"));

		const task = CTF_CORPUS_GO.find((entry) => entry.id === "rename-RunCheckout-to-ExecuteCheckout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("rename-RunCheckout-to-ExecuteCheckout: scores an incomplete rename (a missed call site) as a failure", async () => {
		fixture = materializeGoReferenceFixture();
		const path = join(fixture.root, "app/checkout.go");
		const original = await readFile(path, "utf-8");
		await writeFile(path, original.replace("func RunCheckout(", "func ExecuteCheckout("));

		const task = CTF_CORPUS_GO.find((entry) => entry.id === "rename-RunCheckout-to-ExecuteCheckout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);

	it("move-RunCheckoutTwice-to-new-file: scores a real correct move as a full pass", async () => {
		fixture = materializeGoReferenceFixture();
		const checkoutPath = join(fixture.root, "app/checkout.go");
		const batchPath = join(fixture.root, "app/checkout_batch.go");

		await writeFile(
			checkoutPath,
			'package app\n\nimport "fixture.lector.invalid/gomod-reference/contracts"\n\n' +
				"func RunCheckout(processor contracts.PaymentProcessor, order contracts.Order) (contracts.Receipt, error) {\n" +
				"\treturn processor.Process(order)\n}\n",
		);
		await writeFile(
			batchPath,
			'package app\n\nimport "fixture.lector.invalid/gomod-reference/contracts"\n\n' +
				"func RunCheckoutTwice(processor contracts.PaymentProcessor, order contracts.Order) (contracts.Receipt, error) {\n" +
				"\tif _, err := RunCheckout(processor, order); err != nil {\n\t\treturn contracts.Receipt{}, err\n\t}\n" +
				"\treturn RunCheckout(processor, order)\n}\n",
		);

		const task = CTF_CORPUS_GO.find((entry) => entry.id === "move-RunCheckoutTwice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("move-RunCheckoutTwice-to-new-file: scores a copy-not-move (left behind in the old file) as a failure", async () => {
		fixture = materializeGoReferenceFixture();
		const checkoutPath = join(fixture.root, "app/checkout.go");
		const batchPath = join(fixture.root, "app/checkout_batch.go");
		const original = await readFile(checkoutPath, "utf-8");
		await writeFile(batchPath, original);

		const task = CTF_CORPUS_GO.find((entry) => entry.id === "move-RunCheckoutTwice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);

	it("extract-Processor-interface-from-StripeProcessor: scores a real correct extraction as a full pass", async () => {
		fixture = materializeGoReferenceFixture();
		const path = join(fixture.root, "app/stripe.go");
		await writeFile(
			path,
			'package app\n\nimport "fixture.lector.invalid/gomod-reference/contracts"\n\n' +
				"type Processor interface {\n\tProcess(order contracts.Order) (contracts.Receipt, error)\n}\n\n" +
				"type StripeProcessor struct{}\n\n" +
				"func (StripeProcessor) Process(order contracts.Order) (contracts.Receipt, error) {\n" +
				"\treturn contracts.Receipt{Order: order, Processed: true}, nil\n}\n\n" +
				"func CreateProcessor() contracts.PaymentProcessor {\n\treturn StripeProcessor{}\n}\n",
		);

		const task = CTF_CORPUS_GO.find((entry) => entry.id === "extract-Processor-interface-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("extract-Processor-interface-from-StripeProcessor: scores a missing interface as a failure", async () => {
		fixture = materializeGoReferenceFixture();
		const task = CTF_CORPUS_GO.find((entry) => entry.id === "extract-Processor-interface-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);
});
