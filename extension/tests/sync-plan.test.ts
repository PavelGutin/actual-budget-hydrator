import { describe, expect, it } from "vitest";
import type { OrderDetailsResult, ScanReport } from "../src/live/scan";
import type { ParsedOrder } from "../src/retailers/amazon/parse-order";
import type { ParsedTransaction } from "../src/retailers/amazon/parse-transactions";
import { buildApply, buildRevert, type ParentSource } from "../src/sync/batch";
import { type ActualTxn, alreadyProcessed, buildPlan, orderNoteUrl, type PlanOptions, resolveRow } from "../src/sync/plan";

const A = "111-0000000-0000001";
const B = "111-0000000-0000002";
const R = "111-0000000-0000003";

const order = (n: string, items: [string, number, number?][], extra: Partial<ParsedOrder> = {}): ParsedOrder => ({
	orderNumber: n,
	orderDetailsLink: null,
	orderPlacedDate: null,
	grandTotal: null,
	cancelled: false,
	isWholeFoods: false,
	itemCount: null,
	items: items.map(([title, price, quantity]) => ({ title, price, quantity: quantity ?? null })),
	subtotal: null,
	shippingTotal: null,
	freeShipping: null,
	promotionApplied: null,
	couponSavings: null,
	rewardPoints: null,
	subscriptionDiscount: null,
	totalBeforeTax: null,
	estimatedTax: null,
	refundTotal: null,
	multibuyDiscount: null,
	amazonDiscount: null,
	giftCard: null,
	giftWrap: null,
	refundBreakdown: null,
	...extra,
});

const tx = (n: string | null, date: string, amount: number, p: Partial<ParsedTransaction> = {}): ParsedTransaction => ({
	completedDate: date,
	paymentMethod: "Visa ****0000",
	paymentMethodLast4: "0000",
	grandTotal: amount,
	isRefund: amount > 0,
	orderNumber: n,
	orderDetailsLink: null,
	seller: null,
	status: "Approved",
	isPending: false,
	isGiftCard: false,
	...p,
});

const detail = (o: ParsedOrder): OrderDetailsResult => ({
	orderNumber: o.orderNumber as string,
	order: o,
	fromCache: false,
	reconstructedTotal: null,
	reconciles: true,
	error: null,
});

const scan = (transactions: ParsedTransaction[], orders: ParsedOrder[]): ScanReport =>
	({ transactions, orderDetails: orders.map(detail) }) as unknown as ScanReport;

const actual = (id: string, date: string, cents: number, p: Partial<ActualTxn> = {}): ActualTxn => ({
	id,
	account: "acct",
	date,
	amount: cents,
	payeeName: "Amazon",
	notes: null,
	category: null,
	isParent: false,
	isChild: false,
	transferId: null,
	cleared: false,
	...p,
});

const OPTS: PlanOptions = { payeeSubstrings: ["amazon", "amzn"], stateFilter: "uncategorized", sinceDate: "2026-07-25" };

describe("buildPlan", () => {
	const orderA = order(A, [["Widget", 20], ["Gadget", 10]], { grandTotal: 32.4, estimatedTax: 2.4 });
	const orderB = order(B, [["Book", 7.5]], { grandTotal: 7.5 });

	it("matches and splits a multi-item charge so the splits sum to the bank amount", () => {
		const plan = buildPlan([actual("t1", "2026-10-21", -3240)], scan([tx(A, "2026-10-20", -32.4)], [orderA]), OPTS);
		const [row] = plan.rows;
		expect(row.status).toBe("ready");
		expect(row.splits.map((s) => s.title)).toEqual(["Widget", "Gadget"]);
		expect(row.splits.reduce((a, s) => a + s.amountCents, 0)).toBe(-3240);
	});

	it("marks a one-item order single-item", () => {
		const plan = buildPlan([actual("t1", "2026-10-21", -750)], scan([tx(B, "2026-10-20", -7.5)], [orderB]), OPTS);
		expect(plan.rows[0].status).toBe("single-item");
	});

	it("only considers Amazon payees, in the window, not transfers, not already done, uncategorized", () => {
		const plan = buildPlan(
			[
				actual("other-payee", "2026-10-21", -3240, { payeeName: "Target" }),
				actual("too-old", "2026-07-01", -3240),
				actual("transfer", "2026-10-21", -3240, { transferId: "x" }),
				actual("split", "2026-10-21", -3240, { isParent: true }),
				actual("noted", "2026-10-21", -3240, { notes: `x ${orderNoteUrl(A)}` }),
				actual("legacy-note", "2026-10-21", -3240, { notes: "AMZN-ORDER: 1" }),
				actual("categorized", "2026-10-21", -3240, { category: "c" }),
				actual("t1", "2026-10-21", -3240, { payeeName: "AMZN Mktp US" }),
			],
			scan([tx(A, "2026-10-20", -32.4)], [orderA]),
			OPTS,
		);
		expect(plan.rows.map((r) => r.txn.id)).toEqual(["t1"]);
		expect(plan.skippedAlreadyDone).toBe(3);
		expect(plan.skippedByState).toBe(1);
	});

	it("state filters: uncleared, either, all", () => {
		const txns = [
			actual("cat-cleared", "2026-10-21", -3240, { category: "c", cleared: true }),
			actual("cat-uncleared", "2026-10-21", -3240, { category: "c", cleared: false }),
			actual("uncat-cleared", "2026-10-21", -3240, { cleared: true }),
		];
		const ids = (stateFilter: PlanOptions["stateFilter"]) =>
			buildPlan(txns, scan([tx(A, "2026-10-20", -32.4)], [orderA]), { ...OPTS, stateFilter }).rows.map((r) => r.txn.id).sort();
		expect(ids("uncategorized")).toEqual(["uncat-cleared"]);
		expect(ids("uncleared")).toEqual(["cat-uncleared"]);
		expect(ids("uncategorized-or-uncleared")).toEqual(["cat-uncleared", "uncat-cleared"]);
		expect(ids("all")).toEqual(["cat-cleared", "cat-uncleared", "uncat-cleared"]);
	});

	it("limits to chosen accounts, and skips the payee check on Amazon-only accounts", () => {
		const txns = [
			actual("chase-amazon", "2026-10-21", -3240, { account: "chase", payeeName: "Payment Thank You" }),
			actual("checking-amazon", "2026-10-21", -750, { account: "checking", payeeName: "Amazon" }),
			actual("checking-other", "2026-10-21", -750, { account: "checking", payeeName: "Target" }),
			actual("excluded", "2026-10-21", -750, { account: "savings", payeeName: "Amazon" }),
		];
		const plan = buildPlan(txns, scan([tx(A, "2026-10-20", -32.4), tx(B, "2026-10-20", -7.5)], [orderA, orderB]), {
			...OPTS,
			accounts: ["chase", "checking"],
			amazonOnlyAccounts: ["chase"],
		});
		expect(plan.rows.map((r) => [r.txn.id, r.status])).toEqual([
			["chase-amazon", "ready"],
			["checking-amazon", "single-item"],
		]);
	});

	it("reports no-match, pending, and missing order details distinctly", () => {
		const plan = buildPlan(
			[actual("none", "2026-10-21", -999), actual("pend", "2026-10-21", -4999), actual("nodet", "2026-10-21", -1234)],
			scan([tx(A, "2026-10-21", -49.99, { isPending: true, status: "Pending" }), tx(B, "2026-10-20", -12.34)], []),
			OPTS,
		);
		expect(plan.rows.map((r) => r.status)).toEqual(["no-match", "pending", "no-order-details"]);
	});

	it("never matches a gift-card portion", () => {
		const plan = buildPlan([actual("t1", "2026-10-20", -4800)], scan([tx(A, "2026-10-20", -48, { isGiftCard: true })], [orderA]), OPTS);
		expect(plan.rows[0].status).toBe("no-match");
	});

	it("matches a refund to the refund, and uses the order's refund breakdown when proportional fails", () => {
		// 3 items; the refund (B+C + their tax) isn't a clean proportional subset -> breakdown fallback.
		const refunded = order(R, [["A", 20], ["B", 12.5], ["C", 8.5]], {
			grandTotal: 43.6,
			estimatedTax: 2.6,
			refundBreakdown: { totalCents: 2226, itemRefundCents: 2100, otherCents: { "Tax refund": 126 } },
		});
		const plan = buildPlan(
			[actual("ref", "2026-10-22", 2226)],
			scan([tx(R, "2026-10-01", -43.6), tx(R, "2026-10-21", 22.26)], [refunded]),
			OPTS,
		);
		const [row] = plan.rows;
		expect(row.charge?.isRefund).toBe(true);
		expect(row.status).toBe("ready");
		expect(row.usedRefundBreakdown).toBe(true);
		expect(row.splits.reduce((a, s) => a + s.amountCents, 0)).toBe(2226);
		expect(row.splits.map((s) => s.title).sort()).toEqual(["B", "C"]);
	});

	it("doesn't use the cumulative breakdown when the order has two refunds this run", () => {
		const refunded = order(R, [["A", 20], ["B", 12.5], ["C", 8.5]], {
			grandTotal: 43.6,
			estimatedTax: 2.6,
			refundBreakdown: { totalCents: 4452, itemRefundCents: 4200, otherCents: { Tax: 252 } },
		});
		const plan = buildPlan(
			[actual("r1", "2026-10-22", 2226), actual("r2", "2026-10-23", 2226)],
			scan([tx(R, "2026-10-21", 22.26), tx(R, "2026-10-22", 22.26)], [refunded]),
			OPTS,
		);
		expect(plan.rows.every((r) => !r.usedRefundBreakdown)).toBe(true);
	});

	it("offers equally good charges for an ambiguous match, and splits the one picked", () => {
		const o1 = order(A, [["Poems", 15.99]], { grandTotal: 16.95, estimatedTax: 0.96 });
		const o2 = order(B, [["Dress", 15.99]], { grandTotal: 16.95, estimatedTax: 0.96 });
		const plan = buildPlan(
			[actual("t1", "2026-09-28", -1695)],
			scan([tx(A, "2026-09-27", -16.95), tx(B, "2026-09-29", -16.95)], [o1, o2]),
			OPTS,
		);
		const [row] = plan.rows;
		expect(row.status).toBe("ambiguous-match");
		expect(row.candidates.map((c) => c.orderNumber).sort()).toEqual([A, B]);
		const picked = resolveRow(row.txn, row.candidates.find((c) => c.orderNumber === B)!, plan.orders, plan.refundEvents);
		expect([picked.status, picked.splits[0].title, picked.splits[0].amountCents]).toEqual(["single-item", "Dress", -1695]);
	});

	it("trusts an order number already in the notes over amount/date", () => {
		const plan = buildPlan(
			[actual("t1", "2026-10-21", -750, { notes: `Book | (${B})` })],
			scan([tx(A, "2026-10-21", -7.5), tx(B, "2026-09-01", -7.5)], [orderA, orderB]),
			OPTS,
		);
		expect(plan.rows[0].charge?.orderNumber).toBe(B);
	});
});

describe("buildApply / buildRevert", () => {
	const parent: ParentSource = {
		id: "p1",
		account: "acct",
		date: "2026-10-21",
		amount: -3240,
		payee: "payee-amazon",
		category: "cat-old",
		notes: "bank memo",
		cleared: true,
		reconciled: false,
	};
	const orderA = order(A, [["Widget", 20], ["Gadget", 10]], { grandTotal: 32.4, estimatedTax: 2.4 });
	const plan = buildPlan([actual("p1", "2026-10-21", -3240)], scan([tx(A, "2026-10-20", -32.4)], [orderA]), OPTS);
	let n = 0;
	const ids = () => `child-${++n}`;

	it("turns the bank transaction into a parent with item children like Actual's own split", () => {
		const { batch, change } = buildApply(plan.rows[0], parent, ids, () => "now");
		expect(batch.updated).toEqual([{ id: "p1", is_parent: true, category: null, notes: orderNoteUrl(A) }]);
		expect(batch.added?.map((c) => [c.notes, c.amount, c.parent_id, c.is_child, c.payee, c.account, c.date, c.cleared, c.category])).toEqual([
			["Widget", -2160, "p1", true, "payee-amazon", "acct", "2026-10-21", true, "cat-old"],
			["Gadget", -1080, "p1", true, "payee-amazon", "acct", "2026-10-21", true, "cat-old"],
		]);
		expect(change.previous).toEqual({ notes: "bank memo", category: "cat-old" });
		expect(change.childIds).toEqual(batch.added?.map((c) => c.id));
	});

	it("leaves children uncategorized when the transaction had no category", () => {
		const { batch } = buildApply(plan.rows[0], { ...parent, category: null }, ids);
		expect(batch.added?.map((c) => c.category)).toEqual([null, null]);
	});

	it("reverts by deleting the children and restoring the parent", () => {
		const { change } = buildApply(plan.rows[0], parent, ids);
		expect(buildRevert(change)).toEqual({
			deleted: change.childIds.map((id) => ({ id })),
			updated: [{ id: "p1", is_parent: false, notes: "bank memo", category: "cat-old" }],
		});
	});

	it("splits a single-item order into one child, with only the order link on the parent", () => {
		const one = buildPlan(
			[actual("p1", "2026-10-21", -750)],
			scan([tx(B, "2026-10-20", -7.5)], [order(B, [["Book", 7.5]], { grandTotal: 7.5 })]),
			OPTS,
		);
		const { batch, change } = buildApply(one.rows[0], { ...parent, amount: -750 }, ids);
		expect(batch.updated).toEqual([{ id: "p1", is_parent: true, category: null, notes: orderNoteUrl(B) }]);
		expect(batch.added?.map((c) => [c.notes, c.amount, c.parent_id])).toEqual([["Book", -750, "p1"]]);
		expect(buildRevert(change).deleted).toEqual(change.childIds.map((id) => ({ id })));
	});

	it("refuses to write when the transaction changed since the plan was made", () => {
		expect(() => buildApply(plan.rows[0], { ...parent, amount: -3000 }, ids)).toThrow();
	});
});
