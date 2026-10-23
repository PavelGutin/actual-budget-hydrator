import { describe, expect, it } from "vitest";
import { extractOrderNumberFromNotes, matchTransactions } from "../src/matching/match";
import type { Charge, MatchableTransaction } from "../src/matching/types";

function txn(overrides: Partial<MatchableTransaction>): MatchableTransaction {
	return { id: "t1", date: "2026-01-10", amount: -20, notes: null, ...overrides };
}

/** grandTotal carries the same signed convention as Actual's amount: negative for a
 * charge, positive for a refund (per amazon-orders' Transaction.grand_total). */
function charge(overrides: Partial<Charge>): Charge {
	return {
		completedDate: "2026-01-10",
		grandTotal: -20,
		orderNumber: "111-1234567-1234567",
		paymentMethodLast4: "1234",
		isRefund: false,
		...overrides,
	};
}

describe("extractOrderNumberFromNotes", () => {
	it("extracts a standard order number from a legacy-format note", () => {
		expect(extractOrderNumberFromNotes("Item Title | (114-3284007-7925856)")).toBe(
			"114-3284007-7925856",
		);
	});

	it("extracts an international (letter-prefixed) order number", () => {
		expect(extractOrderNumberFromNotes("Something | (D01-7485423-1791348)")).toBe(
			"D01-7485423-1791348",
		);
	});

	it("returns null when there's no order number", () => {
		expect(extractOrderNumberFromNotes("just some note")).toBeNull();
		expect(extractOrderNumberFromNotes(null)).toBeNull();
	});
});

describe("matchTransactions", () => {
	it("matches a single exact charge by amount and date", () => {
		const [result] = matchTransactions([txn({})], [charge({})]);
		expect(result.charge).not.toBeNull();
		expect(result.ambiguousCandidates).toHaveLength(0);
	});

	it("does not match a charge whose refund sign disagrees with the transaction's", () => {
		// txn.amount is negative (a charge); the only charge candidate is a refund.
		const [result] = matchTransactions(
			[txn({ amount: -20 })],
			[charge({ isRefund: true, grandTotal: 20 })],
		);
		expect(result.charge).toBeNull();
	});

	it("rejects an amount outside tolerance", () => {
		const [result] = matchTransactions([txn({ amount: -20 })], [charge({ grandTotal: -20.05 })]);
		expect(result.charge).toBeNull();
	});

	it("rejects a date outside the 5-day tolerance", () => {
		const [result] = matchTransactions(
			[txn({ date: "2026-01-10" })],
			[charge({ completedDate: "2026-01-20" })],
		);
		expect(result.charge).toBeNull();
	});

	it("picks the closer-dated charge when two match equally on amount", () => {
		const t = txn({ date: "2026-01-10" });
		const near = charge({ completedDate: "2026-01-11", orderNumber: "near" });
		const far = charge({ completedDate: "2026-01-14", orderNumber: "far" });
		const [result] = matchTransactions([t], [far, near]);
		expect(result.charge?.orderNumber).toBe("near");
	});

	it("flags ambiguous when two charges are equally close in date", () => {
		const t = txn({ date: "2026-01-10" });
		const a = charge({ completedDate: "2026-01-11", orderNumber: "a" });
		const b = charge({ completedDate: "2026-01-09", orderNumber: "b" });
		const [result] = matchTransactions([t], [a, b]);
		expect(result.charge).toBeNull();
		expect(result.ambiguousCandidates).toHaveLength(2);
	});

	it("trusts an order number already in the transaction's notes over amount/date guessing", () => {
		const t = txn({
			notes: "Some Item | (111-1234567-1234567)",
			date: "2026-03-01", // far outside date tolerance of the noted charge
		});
		const noted = charge({ orderNumber: "111-1234567-1234567", completedDate: "2026-01-10" });
		const [result] = matchTransactions([t], [noted]);
		expect(result.charge).toBe(noted);
	});

	it("doesn't double-assign the same charge to two transactions", () => {
		const t1 = txn({ id: "t1", amount: -20 });
		const t2 = txn({ id: "t2", amount: -20 });
		const onlyCharge = charge({ grandTotal: -20 });
		const [r1, r2] = matchTransactions([t1, t2], [onlyCharge]);
		expect(r1.charge).toBe(onlyCharge);
		expect(r2.charge).toBeNull();
	});
});
