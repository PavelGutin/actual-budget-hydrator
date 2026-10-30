import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { selectOne } from "../src/retailers/amazon/dom";
import { parseOrder } from "../src/retailers/amazon/parse-order";
import { parseOrderDetails } from "../src/retailers/amazon/parse-order-details";
import { hasCsdEncryptedOrders, parseOrderHistory } from "../src/retailers/amazon/parse-order-history";
import { parseTransactionsNextData } from "../src/retailers/amazon/parse-transactions";
import { ORDER_DETAILS_ENTITY_SELECTOR } from "../src/retailers/amazon/selectors";

/**
 * Field-by-field parity with upstream amazon-orders: golden.json holds upstream's own parse results
 * for its fixtures (regenerate with fixtures/amazon-orders/generate_golden.py).
 */

const dir = new URL("./fixtures/amazon-orders/", import.meta.url);
const golden = JSON.parse(readFileSync(new URL("golden.json", dir), "utf-8"));
const load = (name: string) =>
	new JSDOM(readFileSync(new URL(name, dir), "utf-8"), { virtualConsole: new VirtualConsole() }).window.document;

type Json = Record<string, unknown>;
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()).replace(/Last4$/, "Last4");
const squish = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : s);
/** Details links are compared by the order they point at: we prefer the card's real link where upstream builds one. */
const orderIdOf = (url: unknown) => (typeof url === "string" ? (url.match(/orderI[Dd]=([^&]+)/)?.[1] ?? url) : url);

/** Returns a list of "field: ours != upstream" mismatches (empty when equal). */
function diff(ours: Json, upstream: Json, fields: string[], path = ""): string[] {
	const out: string[] = [];
	for (const f of fields) {
		const link = f === "order_details_link";
		const a = link ? orderIdOf(ours[camel(f)]) : ours[camel(f)];
		const b = link ? orderIdOf(upstream[f]) : upstream[f];
		const equal =
			typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.005 : JSON.stringify(squish(a)) === JSON.stringify(squish(b));
		if (!equal) out.push(`${path}${f}: ours=${JSON.stringify(a)} upstream=${JSON.stringify(b)}`);
	}
	return out;
}

const ORDER_FIELDS = [
	"order_number", "order_details_link", "order_placed_date", "grand_total", "cancelled", "is_whole_foods",
	"item_count", "subtotal", "shipping_total", "free_shipping", "promotion_applied", "coupon_savings",
	"reward_points", "subscription_discount", "total_before_tax", "estimated_tax", "refund_total",
	"multibuy_discount", "amazon_discount", "gift_card", "gift_wrap",
];

function orderDiff(ours: Json, up: Json): string[] {
	const out = diff(ours, up, ORDER_FIELDS);
	const oi = (ours.items as Json[]) ?? [];
	const ui = (up.items as Json[]) ?? [];
	if (oi.length !== ui.length) out.push(`items.length: ours=${oi.length} upstream=${ui.length}`);
	else ui.forEach((u, i) => out.push(...diff(oi[i], u, ["title", "price", "quantity"], `items[${i}].`)));
	return out;
}

describe("upstream parity: order details", () => {
	for (const [name, up] of Object.entries(golden.details as Record<string, Json>)) {
		it(name, () => {
			const m = name.match(/fopo-(\d{3}-\d{7}-\d{7})/);
			const ours = parseOrderDetails(load(name), m ? m[1] : null);
			if ("error" in up) {
				// Upstream refuses the page; we must not produce a usable order from it either.
				expect(ours === null || ours.orderNumber === null).toBe(true);
				return;
			}
			expect(ours).not.toBeNull();
			expect(orderDiff(ours as unknown as Json, up)).toEqual([]);
		});
	}
});

describe("upstream parity: order snippets", () => {
	for (const [name, up] of Object.entries(golden.snippets as Record<string, Json>)) {
		it(name, () => {
			const doc = load(name);
			const root = selectOne(doc, ORDER_DETAILS_ENTITY_SELECTOR) ?? doc.documentElement;
			const ours = parseOrder(root, { fullDetails: true });
			// Snippets have no order number/date context; compare the amounts they exist to cover.
			const fields = ORDER_FIELDS.filter((f) => !["order_number", "order_details_link", "order_placed_date"].includes(f));
			expect(diff(ours as unknown as Json, up, fields)).toEqual([]);
		});
	}
});

describe("upstream parity: order history", () => {
	for (const [name, up] of Object.entries(golden.history as Record<string, Json[] | Json>)) {
		it(name, () => {
			const doc = load(name);
			if (!Array.isArray(up)) {
				if (String(up.error).includes("encrypted")) expect(hasCsdEncryptedOrders(doc)).toBe(true);
				else expect(parseOrderHistory(doc)).toEqual([]);
				return;
			}
			const ours = parseOrderHistory(doc);
			expect(ours.length).toBe(up.length);
			const fields = ["order_number", "grand_total", "order_placed_date", "order_details_link", "cancelled", "is_whole_foods", "index"];
			expect(ours.flatMap((o, i) => diff(o as unknown as Json, up[i], fields, `[${i}].`))).toEqual([]);
		});
	}
});

describe("upstream parity: transactions (Next.js variant)", () => {
	for (const [name, up] of Object.entries(golden.transactions as Record<string, Json[] | Json>)) {
		it(name, () => {
			const doc = load(name);
			if (!doc.querySelector("script#__NEXT_DATA__")) return; // legacy form-tag page: not ported
			expect(Array.isArray(up)).toBe(true);
			const ours = parseTransactionsNextData(doc).transactions;
			expect(ours.length).toBe((up as Json[]).length);
			const fields = ["completed_date", "grand_total", "is_refund", "order_number", "payment_method", "payment_method_last_4", "seller"];
			expect(ours.flatMap((t, i) => diff(t as unknown as Json, (up as Json[])[i], fields, `[${i}].`))).toEqual([]);
		});
	}
});
