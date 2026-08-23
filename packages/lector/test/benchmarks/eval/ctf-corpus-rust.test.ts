/**
 * Same fixture self-test discipline as ctf-corpus.test.ts/ctf-corpus-python.test.ts/
 * ctf-corpus-go.test.ts, applied to the Rust corpus.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_RUST } from "../../../benchmarks/eval/ctf-corpus-rust.ts";
import { materializeRustReferenceFixture, type RustReferenceFixture } from "../../support/rust-reference-fixture.ts";

let fixture: RustReferenceFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("CTF_CORPUS_RUST", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_RUST.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers rename, move, and extract-interface categories", () => {
		const categories = new Set(CTF_CORPUS_RUST.map((task) => task.category));
		expect(categories).toEqual(new Set(["rename", "move", "extract-interface"]));
	});

	it("rename-run_checkout-to-execute_checkout: scores a real correct rename as a full pass", async () => {
		fixture = materializeRustReferenceFixture();
		const checkoutPath = join(fixture.root, "app/src/checkout.rs");
		const libPath = join(fixture.root, "app/src/lib.rs");
		const originalCheckout = await readFile(checkoutPath, "utf-8");
		const originalLib = await readFile(libPath, "utf-8");
		await writeFile(checkoutPath, originalCheckout.replace(/run_checkout\b/g, "execute_checkout").replace("execute_checkout_twice", "run_checkout_twice"));
		await writeFile(libPath, originalLib.replace("run_checkout,", "execute_checkout,"));

		const task = CTF_CORPUS_RUST.find((entry) => entry.id === "rename-run_checkout-to-execute_checkout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("rename-run_checkout-to-execute_checkout: scores an incomplete rename (a missed re-export) as a failure", async () => {
		fixture = materializeRustReferenceFixture();
		const checkoutPath = join(fixture.root, "app/src/checkout.rs");
		const original = await readFile(checkoutPath, "utf-8");
		// Renames the declaration but leaves lib.rs's own `pub use checkout::run_checkout` stale.
		await writeFile(checkoutPath, original.replace("pub fn run_checkout(", "pub fn execute_checkout("));

		const task = CTF_CORPUS_RUST.find((entry) => entry.id === "rename-run_checkout-to-execute_checkout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);

	it("move-run_checkout_twice-to-new-file: scores a real correct move as a full pass", async () => {
		fixture = materializeRustReferenceFixture();
		const checkoutPath = join(fixture.root, "app/src/checkout.rs");
		const batchPath = join(fixture.root, "app/src/checkout_batch.rs");
		const libPath = join(fixture.root, "app/src/lib.rs");
		const originalLib = await readFile(libPath, "utf-8");

		await writeFile(
			checkoutPath,
			"use contracts::{Order, PaymentProcessor, Receipt};\n\n" +
				"pub fn run_checkout(processor: &dyn PaymentProcessor, order: Order) -> Receipt {\n" +
				"    processor.process(order)\n}\n",
		);
		await writeFile(
			batchPath,
			"use contracts::{Order, PaymentProcessor, Receipt};\nuse crate::checkout::run_checkout;\n\n" +
				"pub fn run_checkout_twice(processor: &dyn PaymentProcessor, order: Order) -> Receipt {\n" +
				"    run_checkout(processor, order.clone());\n    run_checkout(processor, order)\n}\n",
		);
		await writeFile(
			libPath,
			originalLib
				.replace("mod checkout;", "mod checkout;\nmod checkout_batch;")
				.replace("pub use checkout::{run_checkout, run_checkout_twice};", "pub use checkout::run_checkout;\npub use checkout_batch::run_checkout_twice;"),
		);

		const task = CTF_CORPUS_RUST.find((entry) => entry.id === "move-run_checkout_twice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("move-run_checkout_twice-to-new-file: scores a copy-not-move (left behind in the old file) as a failure", async () => {
		fixture = materializeRustReferenceFixture();
		const checkoutPath = join(fixture.root, "app/src/checkout.rs");
		const batchPath = join(fixture.root, "app/src/checkout_batch.rs");
		const original = await readFile(checkoutPath, "utf-8");
		await writeFile(batchPath, original);

		const task = CTF_CORPUS_RUST.find((entry) => entry.id === "move-run_checkout_twice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);

	it("extract-Processor-trait-from-StripeProcessor: scores a real correct extraction as a full pass", async () => {
		fixture = materializeRustReferenceFixture();
		const path = join(fixture.root, "app/src/stripe.rs");
		await writeFile(
			path,
			"use contracts::{Order, PaymentProcessor, Receipt};\n\n" +
				"pub trait Processor {\n    fn process(&self, order: Order) -> Receipt;\n}\n\n" +
				"pub struct StripeProcessor;\n\n" +
				"impl PaymentProcessor for StripeProcessor {\n" +
				"    fn process(&self, order: Order) -> Receipt {\n        Receipt { order, processed: true }\n    }\n}\n\n" +
				"impl Processor for StripeProcessor {\n" +
				"    fn process(&self, order: Order) -> Receipt {\n        Receipt { order, processed: true }\n    }\n}\n\n" +
				"pub fn create_processor() -> impl PaymentProcessor {\n    StripeProcessor\n}\n",
		);

		const task = CTF_CORPUS_RUST.find((entry) => entry.id === "extract-Processor-trait-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("extract-Processor-trait-from-StripeProcessor: scores a missing trait implementation as a failure", async () => {
		fixture = materializeRustReferenceFixture();
		const task = CTF_CORPUS_RUST.find((entry) => entry.id === "extract-Processor-trait-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);
});
