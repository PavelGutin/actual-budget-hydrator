import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseOrderDetails } from "../src/retailers/amazon/parse-order-details";

/** Ground truth from amazon-orders' tests/unit/entity/test_order.py::test_order_coupon_savings. */
describe("parseOrderDetails (coupon savings row)", () => {
	it("parses a negative coupon-savings amount", () => {
		const html = readFileSync(
			new URL("./fixtures/amazon-orders/order-details-coupon-savings.html", import.meta.url),
			"utf-8",
		);
		const doc = new JSDOM(html).window.document;
		const order = parseOrderDetails(doc);

		expect(order.couponSavings).toBe(-3.89);
	});
});
