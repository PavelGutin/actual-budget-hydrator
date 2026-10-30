import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { parseOrderDetails } from "../src/retailers/amazon/parse-order-details";
import { parseOrderHistory } from "../src/retailers/amazon/parse-order-history";
import { parseTransactionsNextData } from "../src/retailers/amazon/parse-transactions";
import { computeItemSplits } from "../src/splitting/compute-item-splits";

/**
 * Synthetic markup mirroring the structure of live amazon.com pages captured 2026-10-23.
 * The real captures stay in fixtures/live/ (gitignored: personal data); these reproduce
 * only the shapes the parsers depend on, with made-up order numbers, titles and amounts.
 */

const doc = (html: string) => new JSDOM(html).window.document;

function subtotalRow(label: string, value: string): string {
	return `<div class="a-row od-line-item-row">
		<div class="a-column a-span7 od-line-item-row-label"><span class="a-size-base"><span>${label}</span></span></div>
		<div class="a-column a-span5 od-line-item-row-content a-span-last"><span class="a-size-base a-color-base">${value}</span></div>
	</div>`;
}

function item(title: string, price: string): string {
	return `<div data-component="purchasedItems"><div class="a-fixed-left-grid">
		<div data-component="itemTitle"><a href="#">${title}</a></div>
		<div data-component="unitPrice"><span class="a-price a-text-price"><span class="a-offscreen">${price}</span><span aria-hidden="true">${price}</span></span></div>
	</div></div>`;
}

function orderDetailsPage(items: string[], rows: [string, string][]): string {
	return `<html><body><div id="orderDetails">
		<div data-component="orderId"><span>111-0000000-0000001</span></div>
		${items.join("")}
		<div id="od-subtotals">${rows.map(([l, v]) => subtotalRow(l, v)).join("")}</div>
	</div></body></html>`;
}

describe("parseOrderDetails (live 2026-10 subtotal rows)", () => {
	const giftCardOrder = parseOrderDetails(
		doc(
			orderDetailsPage(
				[item("Item A", "$40.41"), item("Item B", "$20.00")],
				[
					["Order Summary", ""],
					["Item(s) Subtotal:", "$60.41"],
					["Shipping &amp; Handling:", "$2.99"],
					["Your Coupon Savings:", "-$2.02"],
					["Free Shipping:", "-$2.99"],
					["Total before tax:", "$58.39"],
					["Estimated tax to be collected:", "$1.80"],
					["Gift Card Amount:", "-$48.00"],
					["Grand Total:", "$12.19"],
				],
			),
		),
	);

	it("parses free shipping and gift card rows", () => {
		expect(giftCardOrder?.shippingTotal).toBe(2.99);
		expect(giftCardOrder?.freeShipping).toBe(-2.99);
		expect(giftCardOrder?.couponSavings).toBe(-2.02);
		expect(giftCardOrder?.giftCard).toBe(-48);
		expect(giftCardOrder?.grandTotal).toBe(12.19);
	});

	it("leaves absent adjustment rows null", () => {
		expect(giftCardOrder?.promotionApplied).toBeNull();
		expect(giftCardOrder?.giftWrap).toBeNull();
	});

	it("reconstructs the grand total from parsed fields, so the whole-order split reconciles", () => {
		const splits = computeItemSplits(giftCardOrder!, -1219);
		expect(splits.reduce((sum, s) => sum + s.amountCents, 0)).toBe(-1219);
		expect(splits).toHaveLength(2);
	});

	it("reconciles a free-shipping order whose shipping row is cancelled out", () => {
		const o = parseOrderDetails(
			doc(
				orderDetailsPage(
					[item("Item A", "$30.00"), item("Item B", "$19.99")],
					[
						["Item(s) Subtotal:", "$49.99"],
						["Shipping &amp; Handling:", "$2.99"],
						["Free Shipping:", "-$2.99"],
						["Estimated tax to be collected:", "$0.00"],
						["Grand Total:", "$49.99"],
					],
				),
			),
		);
		expect(o?.freeShipping).toBe(-2.99);
		const splits = computeItemSplits(o!, -4999);
		expect(splits.reduce((sum, s) => sum + s.amountCents, 0)).toBe(-4999);
	});
});

describe("parseOrderHistory (live 2026-10 order card)", () => {
	it("finds the order-details link after .yohtmlc-order-details-link was dropped", () => {
		const [order] = parseOrderHistory(
			doc(`<html><body><div class="order-card">
				<div class="order-header">
					<div class="a-column a-span2">Total $49.99</div>
					<div class="yohtmlc-order-id"><span dir="ltr">111-0000000-0000001</span></div>
					<ul><li class="order-header__header-list-item yohtmlc-order-level-connections">
						<a class="a-link-normal" href="https://www.amazon.com/your-orders/order-details?orderID=111-0000000-0000001&amp;ref=ppx_yo2ov_dt_b_fed_order_details">View order details</a>
						<a class="a-link-normal" href="https://www.amazon.com/gp/css/summary/print.html?orderID=111-0000000-0000001">View invoice</a>
					</li></ul>
				</div>
			</div></body></html>`),
		);
		expect(order.orderDetailsLink).toBe(
			"https://www.amazon.com/your-orders/order-details?orderID=111-0000000-0000001&ref=ppx_yo2ov_dt_b_fed_order_details",
		);
	});
});

describe("parseOrderHistory (live 2026-10 fetched HTML, client-side-encrypted cards)", () => {
	it("takes the order number from the card's slot id and flags the card as encrypted", () => {
		const orders = parseOrderHistory(
			doc(`<html><body>
				<div class="order-card js-order-card" data-csa-c-slot-id="amzn1.yourorders.order-card.111-0000000-0000001">
					<div class="a-box-group"><script>/* decryptor */</script>
						<div class="csd-encrypted-sensitive" id="x"><script>/* ciphertext */</script></div>
					</div>
				</div>
			</body></html>`),
		);
		expect(orders).toHaveLength(1);
		expect(orders[0].orderNumber).toBe("111-0000000-0000001");
		expect(orders[0].contentEncrypted).toBe(true);
		expect(orders[0].grandTotal).toBeNull();
	});
});

describe("parseTransactionsNextData (live 2026-10 statusInfo + gift card rows)", () => {
	const raw = (amount: string, status: string, payment: object) => ({
		formattedAmount: amount,
		formattedDate: "Oct 19, 2026",
		orderData: [{ orderDisplayString: "Order #111-0000000-0000001", orderDetailsUrl: "/x" }],
		statementDescriptor: "AMZN Mktp US",
		statusInfo: { status, label: status, amountDetailsStatusType: "Charge" },
		paymentMethodDisplayStringData: payment,
	});
	const nextData = {
		props: {
			pageProps: {
				token: "t",
				request: { locale: "en_US", widgetName: "ViewTransactions" },
				state: {
					transactionResponseState: {
						hasMore: false,
						visibleTransactionResponse: {
							transactionList: [
								raw("-$12.19", "Approved", {
									paymentMethodName: "Prime Visa",
									paymentMethodNumber: { prefix: "••••", lastDigits: "0000" },
								}),
								raw("-$48.00", "Approved", { paymentMethodName: "Amazon Gift Card" }),
								raw("-$49.99", "Pending", {
									paymentMethodName: "Prime Visa",
									paymentMethodNumber: { prefix: "••••", lastDigits: "0000" },
								}),
							],
						},
					},
				},
			},
		},
	};
	const { transactions } = parseTransactionsNextData(
		doc(`<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`),
	);

	it("flags the gift card portion of a split-payment order", () => {
		expect(transactions.map((t) => t.isGiftCard)).toEqual([false, true, false]);
		expect(transactions[1].paymentMethodLast4).toBeNull();
	});

	it("exposes pending status", () => {
		expect(transactions.map((t) => t.status)).toEqual(["Approved", "Approved", "Pending"]);
		expect(transactions.map((t) => t.isPending)).toEqual([false, false, true]);
	});
});
