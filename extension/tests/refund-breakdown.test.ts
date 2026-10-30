import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseRefundBreakdown } from "../src/retailers/amazon/parse-order";
import { parseOrderDetails } from "../src/retailers/amazon/parse-order-details";
import { computeItemSplitsFromBreakdown } from "../src/splitting/compute-item-splits";
import { ReconciliationError, type SplittableOrder } from "../src/splitting/types";

const load = (name: string) =>
	new JSDOM(readFileSync(new URL(`./fixtures/amazon-orders/${name}`, import.meta.url), "utf-8"), {
		virtualConsole: new VirtualConsole(),
	}).window.document;

/** Amounts as rendered in the fixtures' own "Refund Total" popovers (amazon-orders test resources). */
describe("parseRefundBreakdown (preloaded popover layout)", () => {
	it("reads a full refund", () => {
		expect(parseOrderDetails(load("order-details-112-2961628-4757846.html"))?.refundBreakdown).toEqual({
			totalCents: 7611,
			itemRefundCents: 6999,
			otherCents: { "Tax refund": 612 },
		});
	});

	it("reads a partial refund", () => {
		expect(parseOrderDetails(load("order-details-coupon-savings.html"))?.refundBreakdown).toEqual({
			totalCents: 2383,
			itemRefundCents: 2201,
			otherCents: { "Tax refund": 182 },
		});
	});

	it("is null for an order that was never refunded", () => {
		expect(parseOrderDetails(load("order-details-112-9685975-5907428.html"))?.refundBreakdown).toBeNull();
	});
});

describe("parseRefundBreakdown (data-a-popover inlineContent layout, as the Python CLI reads it)", () => {
	const row = (label: string, value: string) =>
		`<div class="a-row od-line-item-row"><div class="od-line-item-row-label">${label}</div><div class="od-line-item-row-content">${value}</div></div>`;
	const inline = [row("Item(s) refund", "$20.00"), row("Tax refund", "$1.20"), row("Refund Total", "$21.20")].join("");
	const doc = new JSDOM(
		`<div id="orderDetails"><span data-a-popover='${JSON.stringify({ name: "x", inlineContent: inline }).replace(/'/g, "&#39;")}'>Refund Total</span></div>`,
	).window.document;

	it("parses the rows out of the popover's JSON", () => {
		expect(parseRefundBreakdown(doc)).toEqual({ totalCents: 2120, itemRefundCents: 2000, otherCents: { "Tax refund": 120 } });
	});
});

describe("computeItemSplitsFromBreakdown", () => {
	const order: SplittableOrder = {
		orderNumber: "111-0000000-0000001",
		grandTotal: 43.6,
		items: [
			{ title: "A", price: 20 },
			{ title: "B", price: 12.5 },
			{ title: "C", price: 8.5 },
		],
		estimatedTax: 2.6,
	};

	it("picks the refunded items from the breakdown and spreads tax over just those", () => {
		const splits = computeItemSplitsFromBreakdown(
			order,
			{ totalCents: 2226, itemRefundCents: 2100, otherCents: { "Tax refund": 126 } },
			2226,
		);
		expect(splits.map((s) => s.title).sort()).toEqual(["B", "C"]);
		expect(splits.reduce((a, s) => a + s.amountCents, 0)).toBe(2226);
	});

	it("treats a breakdown covering every item as a full refund", () => {
		const splits = computeItemSplitsFromBreakdown(order, { totalCents: 4360, itemRefundCents: 4100, otherCents: { Tax: 260 } }, 4360);
		expect(splits).toHaveLength(3);
		expect(splits.reduce((a, s) => a + s.amountCents, 0)).toBe(4360);
	});

	it("refuses when no item subset matches the breakdown", () => {
		expect(() =>
			computeItemSplitsFromBreakdown(order, { totalCents: 1000, itemRefundCents: 999, otherCents: {} }, 1000),
		).toThrow(ReconciliationError);
	});

	it("refuses when the breakdown doesn't add up to the matched transaction", () => {
		expect(() =>
			computeItemSplitsFromBreakdown(order, { totalCents: 2226, itemRefundCents: 2100, otherCents: { Tax: 126 } }, 3000),
		).toThrow(ReconciliationError);
	});
});
