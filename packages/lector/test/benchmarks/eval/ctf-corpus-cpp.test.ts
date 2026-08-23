/**
 * Same fixture self-test discipline as ctf-corpus.test.ts/ctf-corpus-python.test.ts/
 * ctf-corpus-go.test.ts/ctf-corpus-rust.test.ts, applied to the C/C++ corpus.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CTF_CORPUS_CPP } from "../../../benchmarks/eval/ctf-corpus-cpp.ts";
import { type CppReferenceFixture, materializeCppReferenceFixture } from "../../support/cpp-reference-fixture.ts";

let fixture: CppReferenceFixture | undefined;
afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
});

describe("CTF_CORPUS_CPP", () => {
	it("has no duplicate task ids", () => {
		const ids = CTF_CORPUS_CPP.map((task) => task.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers rename, move, and extract-interface categories", () => {
		const categories = new Set(CTF_CORPUS_CPP.map((task) => task.category));
		expect(categories).toEqual(new Set(["rename", "move", "extract-interface"]));
	});

	it("rename-RunCheckout-to-ExecuteCheckout: scores a real correct rename as a full pass", async () => {
		fixture = materializeCppReferenceFixture();
		const headerPath = join(fixture.root, "include/app/checkout.h");
		const cppPath = join(fixture.root, "src/checkout.cpp");
		const originalHeader = await readFile(headerPath, "utf-8");
		const originalCpp = await readFile(cppPath, "utf-8");
		await writeFile(headerPath, originalHeader.replace(/RunCheckout\b/g, "ExecuteCheckout").replace("ExecuteCheckoutTwice", "RunCheckoutTwice"));
		await writeFile(cppPath, originalCpp.replace(/RunCheckout\b/g, "ExecuteCheckout").replace("ExecuteCheckoutTwice", "RunCheckoutTwice"));

		const task = CTF_CORPUS_CPP.find((entry) => entry.id === "rename-RunCheckout-to-ExecuteCheckout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("rename-RunCheckout-to-ExecuteCheckout: scores an incomplete rename (a missed call site) as a failure", async () => {
		fixture = materializeCppReferenceFixture();
		const cppPath = join(fixture.root, "src/checkout.cpp");
		const original = await readFile(cppPath, "utf-8");
		// Renames the definition but leaves the call inside RunCheckoutTwice unchanged.
		await writeFile(cppPath, original.replace("contracts::Receipt RunCheckout(", "contracts::Receipt ExecuteCheckout("));

		const task = CTF_CORPUS_CPP.find((entry) => entry.id === "rename-RunCheckout-to-ExecuteCheckout");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);

	it("move-RunCheckoutTwice-to-new-file: scores a real correct move as a full pass", async () => {
		fixture = materializeCppReferenceFixture();
		const headerPath = join(fixture.root, "include/app/checkout.h");
		const cppPath = join(fixture.root, "src/checkout.cpp");
		const batchHeaderPath = join(fixture.root, "include/app/checkout_batch.h");
		const batchCppPath = join(fixture.root, "src/checkout_batch.cpp");

		await writeFile(
			headerPath,
			'#pragma once\n\n#include "contracts/payment.h"\n\nnamespace app {\n\n' +
				"contracts::Receipt RunCheckout(contracts::PaymentProcessor& processor, const contracts::Order& order);\n\n" +
				"}  // namespace app\n",
		);
		await writeFile(
			cppPath,
			'#include "app/checkout.h"\n\n#include "app/templates.h"\n\nnamespace app {\n\n' +
				"contracts::Receipt RunCheckout(contracts::PaymentProcessor& processor, const contracts::Order& order) {\n" +
				"\tint amount = MaxValue(order.amount, 0);\n\tcontracts::Order normalized{amount};\n\treturn processor.Process(normalized);\n}\n\n" +
				"}  // namespace app\n",
		);
		await writeFile(
			batchHeaderPath,
			'#pragma once\n\n#include "contracts/payment.h"\n\nnamespace app {\n\n' +
				"contracts::Receipt RunCheckoutTwice(contracts::PaymentProcessor& processor, const contracts::Order& order);\n\n" +
				"}  // namespace app\n",
		);
		await writeFile(
			batchCppPath,
			'#include "app/checkout_batch.h"\n\n#include "app/checkout.h"\n\nnamespace app {\n\n' +
				"contracts::Receipt RunCheckoutTwice(contracts::PaymentProcessor& processor, const contracts::Order& order) {\n" +
				"\tRunCheckout(processor, order);\n\treturn RunCheckout(processor, order);\n}\n\n" +
				"}  // namespace app\n",
		);

		const task = CTF_CORPUS_CPP.find((entry) => entry.id === "move-RunCheckoutTwice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("move-RunCheckoutTwice-to-new-file: scores a copy-not-move (left behind in the old file) as a failure", async () => {
		fixture = materializeCppReferenceFixture();
		const cppPath = join(fixture.root, "src/checkout.cpp");
		const batchCppPath = join(fixture.root, "src/checkout_batch.cpp");
		const original = await readFile(cppPath, "utf-8");
		await writeFile(batchCppPath, original);

		const task = CTF_CORPUS_CPP.find((entry) => entry.id === "move-RunCheckoutTwice-to-new-file");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);

	it("extract-Processor-interface-from-StripeProcessor: scores a real correct extraction as a full pass", async () => {
		fixture = materializeCppReferenceFixture();
		const headerPath = join(fixture.root, "include/app/stripe.h");
		await writeFile(
			headerPath,
			'#pragma once\n\n#include "contracts/payment.h"\n\nnamespace app {\n\n' +
				"class Processor {\npublic:\n\tvirtual ~Processor() = default;\n" +
				"\tvirtual contracts::Receipt Process(const contracts::Order& order) = 0;\n};\n\n" +
				"class StripeProcessor : public contracts::PaymentProcessor, public Processor {\npublic:\n" +
				"\tcontracts::Receipt Process(const contracts::Order& order) override;\n};\n\n" +
				"contracts::PaymentProcessor* CreateProcessor();\n\n}  // namespace app\n",
		);

		const task = CTF_CORPUS_CPP.find((entry) => entry.id === "extract-Processor-interface-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result).toEqual({ pass: true, score: 1, errors: [] });
	}, 60_000);

	it("extract-Processor-interface-from-StripeProcessor: scores a missing extraction as a failure", async () => {
		fixture = materializeCppReferenceFixture();
		const task = CTF_CORPUS_CPP.find((entry) => entry.id === "extract-Processor-interface-from-StripeProcessor");
		if (!task) throw new Error("task not found");
		const result = await task.checker.check({ executions: [], workspace: fixture.root });
		expect(result.pass).toBe(false);
	}, 60_000);
});
