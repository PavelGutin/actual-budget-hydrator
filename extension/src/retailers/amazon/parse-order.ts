import { isTruthyValue, select, selectOne, simpleParse, squish, textOf, toCount } from "./dom";
import { parseCurrency } from "./parse-currency";
import { parseFuzzyDate } from "./parse-fuzzy-date";
import { parseOrderNumber } from "./parse-order-number";
import * as sel from "./selectors";

/**
 * Port of amazon-orders' entity/order.py + entity/item.py (MIT, github.com/alexdlaird/amazon-orders)
 * for the fields this extension needs. `fullDetails` mirrors upstream's flag: history cards parse
 * summary fields only; detail pages also parse subtotal rows.
 */

export interface ParsedItem {
	title: string;
	price: number | null;
	/** null when the page shows none (treat as 1) or for items sold by weight. */
	quantity: number | null;
}

export interface RefundBreakdown {
	totalCents: number;
	itemRefundCents: number;
	/** Every other row ("Tax refund", "Shipping refund", ...), keyed by label without the colon. */
	otherCents: Record<string, number>;
}

export interface ParsedOrder {
	orderNumber: string | null;
	orderDetailsLink: string | null;
	orderPlacedDate: string | null;
	grandTotal: number | null;
	cancelled: boolean;
	isWholeFoods: boolean;
	itemCount: number | null;
	items: ParsedItem[];
	subtotal: number | null;
	shippingTotal: number | null;
	freeShipping: number | null;
	promotionApplied: number | null;
	couponSavings: number | null;
	rewardPoints: number | null;
	subscriptionDiscount: number | null;
	totalBeforeTax: number | null;
	estimatedTax: number | null;
	refundTotal: number | null;
	multibuyDiscount: number | null;
	amazonDiscount: number | null;
	giftCard: number | null;
	giftWrap: number | null;
	refundBreakdown: RefundBreakdown | null;
}

export interface ParseOrderOptions {
	fullDetails: boolean;
	/** Fallback when the page doesn't render its own order number (upstream's `order_number` param). */
	orderNumber?: string | null;
}

function parseCurrencyRow(root: ParentNode, label: sel.Label, combineMultiple: boolean): number | null {
	let value: number | null = null;
	for (const row of select(root, sel.FIELD_ORDER_SUBTOTALS_TAG_ITERATOR_SELECTOR)) {
		const rowText = textOf(row).toLowerCase();
		const matches = typeof label === "string" ? rowText.includes(label) : label.test(rowText);
		if (!matches || selectOne(row, sel.FIELD_ORDER_SUBTOTALS_TAG_POPOVER_PRELOAD_SELECTOR)) continue;
		const inner = selectOne(row, sel.FIELD_ORDER_SUBTOTALS_INNER_TAG_SELECTOR);
		if (inner) {
			const currency = parseCurrency(textOf(inner));
			if (currency !== null) value = (value ?? 0) + currency;
			if (!combineMultiple) break;
		}
	}
	return value === null ? null : Math.round(value * 100) / 100;
}

/** Port of Order._parse_labeled_currency: each label in turn; the first that yields an amount wins. */
export function parseLabeledCurrency(root: ParentNode, labels: sel.Label[], combineMultiple = false): number | null {
	for (const label of labels) {
		const value = parseCurrencyRow(root, label, combineMultiple);
		if (value !== null) return value;
	}
	return null;
}

function parseItem(itemRoot: Element): ParsedItem | null {
	const title = simpleParse(itemRoot, sel.FIELD_ITEM_TITLE_SELECTOR);
	if (!title) return null;
	return {
		title: squish(title),
		price: parseCurrency(simpleParse(itemRoot, sel.FIELD_ITEM_PRICE_SELECTOR)),
		quantity: parseQuantity(itemRoot),
	};
}

function parseQuantity(itemRoot: Element): number | null {
	for (const tag of select(itemRoot, sel.FIELD_ITEM_QUANTITY_SELECTOR)) {
		const q = toCount(textOf(tag), "^\\s*{count}\\s*$");
		if (q !== null) return q;
	}
	for (const tag of select(itemRoot, sel.FIELD_ITEM_WHOLE_FOODS_QUANTITY_SELECTOR)) {
		const q = toCount(textOf(tag).trim(), sel.FIELD_ITEM_WHOLE_FOODS_QUANTITY_REGEX);
		if (q !== null) return q;
	}
	return null;
}

function parseCancelled(root: Element): boolean {
	if (select(root, sel.ORDER_SKIP_TOTALS).length > 0) return true;
	const statuses = select(root, sel.ORDER_SHIPMENT_STATUS_SELECTOR);
	const cancelled = select(root, sel.ORDER_SHIPMENT_CANCELLED_SELECTOR);
	return statuses.length > 0 && cancelled.length === statuses.length;
}

function parseOrderNumberField(root: Element): string | null {
	for (const s of sel.FIELD_ORDER_NUMBER_SELECTOR) {
		const tag = selectOne(root, s);
		const n = tag ? parseOrderNumber(textOf(tag)) : null;
		if (n) return n;
	}
	return null;
}

function withBaseUrl(url: string): string {
	return url.startsWith("http") ? url : `${sel.BASE_URL}${url}`;
}

function parseGrandTotal(root: Element, cancelled: boolean, isWholeFoods: boolean, skipItems: boolean): number | null {
	if (cancelled) return null;
	if (!isWholeFoods && skipItems) return null;
	const raw = simpleParse(root, sel.FIELD_ORDER_GRAND_TOTAL_SELECTOR);
	if (!isTruthyValue(raw)) return parseLabeledCurrency(root, sel.FIELD_ORDER_GRAND_TOTAL_LABELS);
	let v = raw as string;
	if (v.toLowerCase().startsWith(sel.FIELD_ORDER_GRAND_TOTAL_PREFIX)) v = v.slice(sel.FIELD_ORDER_GRAND_TOTAL_PREFIX.length).trim();
	return parseCurrency(v);
}

function parseItemCount(root: Element): number | null {
	for (const tag of select(root, sel.FIELD_ORDER_ITEM_COUNT_SELECTOR)) {
		const n = toCount(textOf(tag), sel.FIELD_ORDER_ITEM_COUNT_REGEX);
		if (n !== null) return n;
	}
	return null;
}

function breakdownFromRows(rows: Element[]): RefundBreakdown | null {
	const amounts: Record<string, number> = {};
	for (const row of rows) {
		const valueEl = row.querySelector(sel.REFUND_BREAKDOWN_VALUE_SELECTOR);
		const labelEl = row.firstElementChild;
		if (!valueEl || !labelEl || labelEl === valueEl) continue;
		const label = squish(textOf(labelEl)).replace(/:$/, "");
		const amount = parseCurrency(textOf(valueEl));
		if (!label || amount === null || !/^[-+(]?\s*\$/.test(textOf(valueEl).trim())) continue;
		amounts[label] = Math.round(amount * 100);
	}
	if (!(sel.REFUND_TOTAL_LABEL in amounts)) return null;
	const { [sel.REFUND_TOTAL_LABEL]: totalCents, [sel.REFUND_ITEMS_LABEL]: itemRefundCents = 0, ...otherCents } = amounts;
	return { totalCents, itemRefundCents, otherCents };
}

/**
 * The order's cumulative refund breakdown (Item(s) refund, Tax refund, ... -> Refund Total), as the
 * Python CLI's refund_scrape.py reads it. Covers the preloaded-popover layout and the newer
 * `data-a-popover` JSON `inlineContent` layout. null when the order was never refunded.
 */
export function parseRefundBreakdown(root: ParentNode): RefundBreakdown | null {
	const preload = root.querySelector(sel.REFUND_BREAKDOWN_PRELOAD_SELECTOR);
	if (preload) {
		const found = breakdownFromRows(Array.from(preload.querySelectorAll(sel.REFUND_BREAKDOWN_ROW_SELECTOR)));
		if (found) return found;
	}
	for (const el of Array.from(root.querySelectorAll(`[${sel.REFUND_BREAKDOWN_POPOVER_ATTR}]`))) {
		const raw = el.getAttribute(sel.REFUND_BREAKDOWN_POPOVER_ATTR) ?? "";
		if (!raw.includes(sel.REFUND_TOTAL_LABEL)) continue;
		let inline: string | undefined;
		try {
			inline = JSON.parse(raw).inlineContent;
		} catch {
			continue;
		}
		if (!inline?.includes(sel.REFUND_TOTAL_LABEL)) continue;
		const doc = el.ownerDocument;
		const container = doc.createElement("div");
		container.innerHTML = inline;
		const found = breakdownFromRows(Array.from(container.querySelectorAll(sel.REFUND_BREAKDOWN_ROW_SELECTOR)));
		if (found) return found;
	}
	return null;
}

export function parseOrder(root: Element, opts: ParseOrderOptions): ParsedOrder {
	const cancelled = parseCancelled(root);
	const isWholeFoods = select(root, sel.ORDER_WHOLE_FOODS).length > 0;
	const skipItems = select(root, sel.ORDER_SKIP_ITEMS).length > 0;

	const items = skipItems
		? []
		: select(root, sel.ITEM_ENTITY_SELECTOR)
				.map(parseItem)
				.filter((i): i is ParsedItem => i !== null)
				.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));

	const orderNumber = parseOrderNumberField(root) ?? opts.orderNumber ?? null;
	const link = simpleParse(root, sel.FIELD_ORDER_DETAILS_LINK_SELECTOR, { attr: "href" });
	const orderDetailsLink = link
		? withBaseUrl(link)
		: orderNumber
			? `${sel.ORDER_DETAILS_URL}?${sel.ORDER_ID_QUERY_PARAM}=${orderNumber}`
			: null;

	const full = opts.fullDetails;
	const labeled = (labels: sel.Label[], combine = false) => (full ? parseLabeledCurrency(root, labels, combine) : null);
	const wfmAmount = (selector: string) => parseCurrency(simpleParse(root, selector));

	return {
		orderNumber,
		orderDetailsLink,
		orderPlacedDate: simpleParse(root, sel.FIELD_ORDER_PLACED_DATE_SELECTOR, {
			suffixSplit: sel.FIELD_ORDER_PLACED_DATE_SUFFIX,
			suffixSplitFuzzy: true,
			convert: parseFuzzyDate,
		}),
		grandTotal: parseGrandTotal(root, cancelled, isWholeFoods, skipItems),
		cancelled,
		isWholeFoods,
		itemCount: parseItemCount(root),
		items,
		subtotal: full
			? isWholeFoods
				? wfmAmount(sel.FIELD_ORDER_WHOLE_FOODS_SUBTOTAL_SELECTOR)
				: parseLabeledCurrency(root, sel.FIELD_ORDER_SUBTOTAL_LABELS)
			: null,
		shippingTotal: labeled(sel.FIELD_ORDER_SHIPPING_TOTAL_LABELS),
		freeShipping: labeled(sel.FIELD_ORDER_FREE_SHIPPING_LABELS),
		promotionApplied: labeled(sel.FIELD_ORDER_PROMOTION_APPLIED_LABELS, true),
		couponSavings: labeled(sel.FIELD_ORDER_COUPON_SAVINGS_LABELS, true),
		rewardPoints: labeled(sel.FIELD_ORDER_REWARD_POINTS_LABELS, true),
		subscriptionDiscount: labeled(sel.FIELD_ORDER_SUBSCRIPTION_DISCOUNT_LABELS),
		totalBeforeTax: labeled(sel.FIELD_ORDER_TOTAL_BEFORE_TAX_LABELS),
		estimatedTax: full
			? isWholeFoods
				? wfmAmount(sel.FIELD_ORDER_WHOLE_FOODS_TAX_SELECTOR)
				: parseLabeledCurrency(root, sel.FIELD_ORDER_ESTIMATED_TAX_LABELS)
			: null,
		refundTotal: labeled(sel.FIELD_ORDER_REFUND_TOTAL_LABELS),
		multibuyDiscount: labeled(sel.FIELD_ORDER_MULTIBUY_DISCOUNT_LABELS),
		amazonDiscount: labeled(sel.FIELD_ORDER_AMAZON_DISCOUNT_LABELS),
		giftCard: labeled(sel.FIELD_ORDER_GIFT_CARD_LABELS),
		giftWrap: labeled(sel.FIELD_ORDER_GIFT_WRAP_LABELS),
		refundBreakdown: full ? parseRefundBreakdown(root) : null,
	};
}
