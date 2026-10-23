import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseOrderDetails } from "../src/retailers/amazon/parse-order-details";

/**
 * Ground truth for this fixture comes from amazon-orders' own test suite
 * (tests/testcase.py: assert_order_112_9685975_5907428_multiple_items_shipments_sellers),
 * not re-derived by us -- this spike is validating our TS port against their already-verified
 * expectations, not inventing new ones.
 */
describe("parseOrderDetails (amazon-orders fixture port)", () => {
	const html = readFileSync(
		new URL("./fixtures/amazon-orders/order-details-112-9685975-5907428.html", import.meta.url),
		"utf-8",
	);
	const doc = new JSDOM(html).window.document;
	const order = parseOrderDetails(doc);

	it("parses the order number", () => {
		expect(order.orderNumber).toBe("112-9685975-5907428");
	});

	it("parses the totals", () => {
		expect(order.grandTotal).toBe(46.61);
		expect(order.subtotal).toBe(43.23);
		expect(order.shippingTotal).toBe(0.0);
		expect(order.estimatedTax).toBe(3.38);
	});

	it("parses both items with titles and prices", () => {
		expect(order.items).toHaveLength(2);

		const cadeya = order.items.find((i) => i.title.includes("Cadeya"));
		const swiffer = order.items.find((i) => i.title.includes("Swiffer"));

		expect(cadeya).toBeDefined();
		expect(swiffer).toBeDefined();
		expect(cadeya?.price).toBe(14.99);

		expect(cadeya?.title).toBe(
			"Cadeya Egg Cleaning Brush Silicone, Egg Scrubber for Fresh Eggs, Reusable Cleaning Tools for Egg Washer (Pink)",
		);
		expect(swiffer?.title).toBe(
			"Swiffer WetJet Hardwood and Floor Spray Mop Cleaner Starter Kit, Includes: 1 Power Mop, 10 Pads, Cleaning Solution, Batteries",
		);
	});
});
