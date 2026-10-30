import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseTransactionsDataResponse, parseTransactionsNextData } from "../src/retailers/amazon/parse-transactions";

/** Ground truth from amazon-orders' tests/unit/test_transactions.py::test_parse_transactions_embedded_data. */
describe("parseTransactionsNextData (amazon-orders fixture port)", () => {
	const html = readFileSync(
		new URL("./fixtures/amazon-orders/transactions-nextjs.html", import.meta.url),
		"utf-8",
	);
	const doc = new JSDOM(html).window.document;
	const { transactions, nextPageData } = parseTransactionsNextData(doc);

	it("parses all 20 transactions on the page", () => {
		expect(transactions).toHaveLength(20);
	});

	it("parses the first transaction's fields", () => {
		const t = transactions[0];
		expect(t.completedDate).toBe("2026-03-16");
		expect(t.paymentMethod).toBe("Visa Card ****7986");
		expect(t.paymentMethodLast4).toBe("7986");
		expect(t.grandTotal).toBe(-45.68);
		expect(t.orderNumber).toBe("112-2951294-1503648");
		expect(t.seller).toBe("AMZN Mktp US");
		expect(t.isRefund).toBe(false);
	});

	it("flags refunds (positive grand total) correctly", () => {
		expect(transactions.filter((t) => t.isRefund)).toHaveLength(4);
	});

	it("leaves seller null when the row's seller equals its own order number", () => {
		expect(transactions[13].seller).toBeNull();
	});

	it("surfaces the next-page cursor", () => {
		expect(nextPageData).toEqual({
			exclusiveStartKey: "REDACTED",
			token: "REDACTED",
			locale: "en_US",
			widgetName: "ViewTransactions",
		});
	});
});

/** Ground truth from amazon-orders' tests/unit/test_transactions.py::test_get_transactions_embedded_data_next_page / _last_page. */
describe("parseTransactionsDataResponse (paginated get-transactions POST)", () => {
	const body = JSON.parse(
		readFileSync(new URL("./fixtures/amazon-orders/transactions-nextjs-next-page.json", import.meta.url), "utf-8"),
	);

	it("parses a following page and its cursor", () => {
		const { transactions, lastEvaluatedKey } = parseTransactionsDataResponse(body);
		expect(transactions).toHaveLength(20);
		expect(transactions[0].completedDate).toBe("2026-02-14");
		expect(lastEvaluatedKey).toBe("REDACTED");
	});

	it("returns a null cursor on the last page", () => {
		const last = structuredClone(body);
		delete last.displayResponse.lastEvaluatedKey;
		const { transactions, lastEvaluatedKey } = parseTransactionsDataResponse(last);
		expect(transactions).toHaveLength(20);
		expect(lastEvaluatedKey).toBeNull();
	});

	it("throws on an unrecognized response shape", () => {
		expect(() => parseTransactionsDataResponse({ displayResponse: {} })).toThrow();
	});
});
