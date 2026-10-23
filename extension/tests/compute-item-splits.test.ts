import { describe, expect, it } from "vitest";
import { computeItemSplits } from "../src/splitting/compute-item-splits";
import { AmbiguousSplitError, ReconciliationError, type SplittableOrder } from "../src/splitting/types";

function order(overrides: Partial<SplittableOrder>): SplittableOrder {
	return { orderNumber: "111-1234567-1234567", grandTotal: null, items: [], ...overrides };
}

describe("computeItemSplits", () => {
	it("assigns the whole amount to a single item regardless of tax/shipping noise", () => {
		const o = order({ items: [{ title: "Widget", price: 10 }], estimatedTax: 0.83 });
		const splits = computeItemSplits(o, -1083);
		expect(splits).toEqual([{ title: "Widget", amountCents: -1083 }]);
	});

	it("prorates tax across items for a whole-order charge, absorbing rounding into the largest item", () => {
		const o = order({
			items: [
				{ title: "A", price: 14.99 },
				{ title: "B", price: 28.24 },
			],
			estimatedTax: 3.38,
			grandTotal: 46.61,
		});
		const splits = computeItemSplits(o, -4661);
		expect(splits.reduce((a, s) => a + s.amountCents, 0)).toBe(-4661);
		const b = splits.find((s) => s.title === "B")!;
		// B is the larger item, so any largest-remainder rounding slack lands on it.
		expect(Math.abs(b.amountCents)).toBeGreaterThanOrEqual(2824);
	});

	it("finds the matching subset when the transaction covers only one item of a multi-item order", () => {
		const o = order({
			items: [
				{ title: "A", price: 10 },
				{ title: "B", price: 25 },
				{ title: "C", price: 40 },
			],
		});
		const splits = computeItemSplits(o, -2500);
		expect(splits).toHaveLength(1);
		expect(splits[0].title).toBe("B");
		expect(splits[0].amountCents).toBe(-2500);
	});

	it("throws AmbiguousSplitError when two items tie for a subset match", () => {
		const o = order({
			items: [
				{ title: "A", price: 15 },
				{ title: "B", price: 15 },
				{ title: "C", price: 40 },
			],
		});
		expect(() => computeItemSplits(o, -1500)).toThrow(AmbiguousSplitError);
	});

	it("throws ReconciliationError when no subset or whole-order total matches", () => {
		const o = order({
			items: [
				{ title: "A", price: 10 },
				{ title: "B", price: 25 },
			],
		});
		expect(() => computeItemSplits(o, -1234)).toThrow(ReconciliationError);
	});

	it("falls back to the order's grandTotal when named adjustment fields don't account for the full gap", () => {
		// Items sum to $40, but an unlabeled adjustment brings the real order total to $42 --
		// the transaction for the whole order should still be treated as whole-order, not
		// misread as a (nonexistent) partial subset.
		const o = order({
			items: [
				{ title: "A", price: 10 },
				{ title: "B", price: 30 },
			],
			grandTotal: 42,
		});
		const splits = computeItemSplits(o, -4200);
		expect(splits).toHaveLength(2);
		expect(splits.reduce((a, s) => a + s.amountCents, 0)).toBe(-4200);
	});

	it("matches the exact cent allocation for the real order-112-9685975-5907428 fixture", () => {
		// Same order validated in amazon-order-details.test.ts: $14.99 + $28.24 items,
		// $3.38 tax, $46.61 grand total -- confirms the split lands on 16.16 / 30.45.
		const o = order({
			items: [
				{ title: "Cadeya Egg Cleaning Brush", price: 14.99 },
				{ title: "Swiffer WetJet Starter Kit", price: 28.24 },
			],
			estimatedTax: 3.38,
			grandTotal: 46.61,
		});
		const splits = computeItemSplits(o, -4661);
		expect(splits).toEqual([
			{ title: "Cadeya Egg Cleaning Brush", amountCents: -1616 },
			{ title: "Swiffer WetJet Starter Kit", amountCents: -3045 },
		]);
	});

	it("handles a refund (positive target) with the same proration logic", () => {
		const o = order({
			items: [
				{ title: "A", price: 10 },
				{ title: "B", price: 20 },
			],
			estimatedTax: 2.4,
			grandTotal: 32.4,
		});
		const splits = computeItemSplits(o, 3240);
		expect(splits.every((s) => s.amountCents >= 0)).toBe(true);
		expect(splits.reduce((a, s) => a + s.amountCents, 0)).toBe(3240);
	});

	it("respects item quantity when weighting the base price", () => {
		const o = order({
			items: [
				{ title: "A", price: 5, quantity: 3 }, // $15
				{ title: "B", price: 25 },
			],
		});
		// Whole order: $15 + $25 = $40
		const splits = computeItemSplits(o, -4000);
		const a = splits.find((s) => s.title === "A")!;
		expect(a.amountCents).toBe(-1500);
	});
});
