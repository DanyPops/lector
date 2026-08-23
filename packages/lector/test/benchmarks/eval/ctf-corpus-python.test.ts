/**
 * Same fixture self-test discipline as ctf-corpus.test.ts, applied to the Python corpus: hand-
 * apply the CORRECT mutation for each CTF task, confirm its own checker recognizes it as a pass,
 * and hand-apply a real plausible MISTAKE, confirming the checker actually catches it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_PYTHON } from "../../../benchmarks/eval/ctf-corpus-python.ts";
import { materializePythonReferenceFixture, type PythonReferenceFixture } from "../../support/python-reference-fixture.ts";

let fixture: PythonReferenceFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("CTF_CORPUS_PYTHON", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_PYTHON.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers rename, move, and extract-interface categories", () => {
		const categories = new Set(CTF_CORPUS_PYTHON.map((task) => task.category));
		expect(categories).toEqual(new Set(["rename", "move", "extract-interface"]));
	});

	it("rename-run_checkout-to-execute_checkout: scores a real correct rename as a full pass", async () => {
		fixture = materializePythonReferenceFixture();
		const path = join(fixture.root, "app/checkout.py");
		const original = await readFile(path, "utf-8");
		await writeFile(path, original.replace(/run_checkout\b/g, "execute_checkout").replace("execute_checkout_twice", "run_checkout_twice"));

		const task = CTF_CORPUS_PYTHON.find((entry) => entry.id === "rename-run_checkout-to-execute_checkout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("rename-run_checkout-to-execute_checkout: scores an incomplete rename (a missed call site) as a failure", async () => {
		fixture = materializePythonReferenceFixture();
		const path = join(fixture.root, "app/checkout.py");
		// Renames the declaration but leaves the calls inside run_checkout_twice unchanged.
		const original = await readFile(path, "utf-8");
		await writeFile(path, original.replace("def run_checkout(", "def execute_checkout("));

		const task = CTF_CORPUS_PYTHON.find((entry) => entry.id === "rename-run_checkout-to-execute_checkout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);

	it("move-run_checkout_twice-to-new-file: scores a real correct move as a full pass", async () => {
		fixture = materializePythonReferenceFixture();
		const checkoutPath = join(fixture.root, "app/checkout.py");
		const batchPath = join(fixture.root, "app/checkout_batch.py");

		await writeFile(
			checkoutPath,
			"from contracts.payment import Order, PaymentProcessor, Receipt\n\n\n" +
				"def run_checkout(processor: PaymentProcessor, order: Order) -> Receipt:\n" +
				"    return processor.process(order)\n",
		);
		await writeFile(
			batchPath,
			"from contracts.payment import Order, PaymentProcessor, Receipt\n" +
				"from app.checkout import run_checkout\n\n\n" +
				"def run_checkout_twice(processor: PaymentProcessor, order: Order) -> Receipt:\n" +
				"    run_checkout(processor, order)\n" +
				"    return run_checkout(processor, order)\n",
		);

		const task = CTF_CORPUS_PYTHON.find((entry) => entry.id === "move-run_checkout_twice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("move-run_checkout_twice-to-new-file: scores a copy-not-move (left behind in the old file) as a failure", async () => {
		fixture = materializePythonReferenceFixture();
		const checkoutPath = join(fixture.root, "app/checkout.py");
		const batchPath = join(fixture.root, "app/checkout_batch.py");
		const original = await readFile(checkoutPath, "utf-8");
		// Copies run_checkout_twice into the new file but never removes it from checkout.py.
		await writeFile(batchPath, original);

		const task = CTF_CORPUS_PYTHON.find((entry) => entry.id === "move-run_checkout_twice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);

	it("extract-protocol-from-StripeProcessor: scores a real correct extraction as a full pass", async () => {
		fixture = materializePythonReferenceFixture();
		const path = join(fixture.root, "app/stripe.py");
		await writeFile(
			path,
			"from typing import Protocol\n\n" +
				"from contracts.payment import Order, PaymentProcessor, Receipt\n\n\n" +
				"class Processor(Protocol):\n" +
				"    def process(self, order: Order) -> Receipt: ...\n\n\n" +
				"class StripeProcessor(PaymentProcessor):\n" +
				"    def process(self, order: Order) -> Receipt:\n" +
				"        return Receipt(order, True)\n\n" +
				"    @staticmethod\n" +
				"    def create() -> PaymentProcessor:\n" +
				"        return StripeProcessor()\n",
		);

		const task = CTF_CORPUS_PYTHON.find((entry) => entry.id === "extract-protocol-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("extract-protocol-from-StripeProcessor: scores a missing Protocol class as a failure", async () => {
		fixture = materializePythonReferenceFixture();
		// Leaves stripe.py completely untouched -- no Processor Protocol was ever added.
		const task = CTF_CORPUS_PYTHON.find((entry) => entry.id === "extract-protocol-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);
});
