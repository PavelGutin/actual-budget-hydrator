import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseOrderHistory } from "../src/retailers/amazon/parse-order-history";

/** Ground truth from amazon-orders' tests/testcase.py::assert_order_112_0399923_3070642 (full_details=False). */
describe("parseOrderHistory (amazon-orders fixture port)", () => {
	const html = readFileSync(
		new URL("./fixtures/amazon-orders/order-history-2018-0.html", import.meta.url),
		"utf-8",
	);
	const doc = new JSDOM(html).window.document;
	const orders = parseOrderHistory(doc);

	it("parses all 10 orders on the page", () => {
		expect(orders).toHaveLength(10);
	});

	it("parses order #3's summary fields", () => {
		const order = orders[3];
		expect(order.index).toBe(3);
		expect(order.orderNumber).toBe("112-0399923-3070642");
		expect(order.grandTotal).toBe(34.01);
		expect(order.orderPlacedDate).toBe("2018-12-21");
		expect(order.orderDetailsLink).toBeTruthy();
	});
});
