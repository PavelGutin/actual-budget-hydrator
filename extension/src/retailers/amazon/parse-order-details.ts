import { parseCurrency } from "./parse-currency";
import { parseOrderNumber as extractOrderNumber } from "./parse-order-number";
import * as sel from "./selectors";

export interface ParsedItem {
	title: string;
	price: number | null;
}

export interface ParsedOrder {
	orderNumber: string | null;
	grandTotal: number | null;
	subtotal: number | null;
	shippingTotal: number | null;
	estimatedTax: number | null;
	couponSavings: number | null;
	items: ParsedItem[];
}

/** Tries each selector in turn, returning the first non-empty NodeList (mirrors amazon-orders' `util.select`). */
function selectFirst(root: ParentNode, selectors: string[]): Element[] {
	for (const selector of selectors) {
		const found = Array.from(root.querySelectorAll(selector));
		if (found.length > 0) return found;
	}
	return [];
}

function selectOneFirst(root: ParentNode, selectors: string[]): Element | null {
	for (const selector of selectors) {
		const found = root.querySelector(selector);
		if (found) return found;
	}
	return null;
}

function text(el: Element | null | undefined): string {
	return (el?.textContent ?? "").trim();
}

/** Port of Order._parse_currency / _parse_labeled_currency: scans subtotal rows for a label match. */
function parseLabeledCurrency(doc: Document, labels: string[]): number | null {
	const rows = selectFirst(doc, sel.FIELD_ORDER_SUBTOTALS_TAG_ITERATOR_SELECTOR);
	for (const label of labels) {
		for (const row of rows) {
			const rowText = text(row).toLowerCase();
			if (!rowText.includes(label)) continue;
			if (row.querySelector(sel.FIELD_ORDER_SUBTOTALS_TAG_POPOVER_PRELOAD_SELECTOR)) continue;

			const innerTag = row.querySelector(sel.FIELD_ORDER_SUBTOTALS_INNER_TAG_SELECTOR);
			if (innerTag) {
				const value = parseCurrency(text(innerTag));
				if (value !== null) return value;
			}
			break;
		}
	}
	return null;
}

function parseOrderNumber(doc: Document): string | null {
	for (const selector of sel.FIELD_ORDER_NUMBER_SELECTOR) {
		const el = doc.querySelector(selector);
		if (!el) continue;
		const orderNumber = extractOrderNumber(text(el));
		if (orderNumber) return orderNumber;
	}
	return null;
}

function parseGrandTotal(doc: Document): number | null {
	const el = selectOneFirst(doc, sel.FIELD_ORDER_GRAND_TOTAL_SELECTOR);
	let raw = el ? text(el) : null;

	if (!raw) {
		return parseLabeledCurrency(doc, sel.FIELD_ORDER_GRAND_TOTAL_LABELS);
	}
	if (raw.toLowerCase().startsWith(sel.FIELD_ORDER_GRAND_TOTAL_PREFIX)) {
		raw = raw.slice(sel.FIELD_ORDER_GRAND_TOTAL_PREFIX.length).trim();
	}
	return parseCurrency(raw);
}

function parseItems(doc: Document): ParsedItem[] {
	const itemTags = selectFirst(doc, sel.ITEM_ENTITY_SELECTOR);
	const items: ParsedItem[] = [];
	for (const tag of itemTags) {
		const titleEl = selectOneFirst(tag, sel.FIELD_ITEM_TITLE_SELECTOR);
		if (!titleEl) continue;
		const title = text(titleEl);
		if (!title) continue;

		const priceEl = selectOneFirst(tag, sel.FIELD_ITEM_PRICE_SELECTOR);
		items.push({ title, price: priceEl ? parseCurrency(text(priceEl)) : null });
	}
	items.sort((a, b) => a.title.localeCompare(b.title));
	return items;
}

export function parseOrderDetails(doc: Document): ParsedOrder {
	return {
		orderNumber: parseOrderNumber(doc),
		grandTotal: parseGrandTotal(doc),
		subtotal: parseLabeledCurrency(doc, sel.FIELD_ORDER_SUBTOTAL_LABELS),
		shippingTotal: parseLabeledCurrency(doc, sel.FIELD_ORDER_SHIPPING_TOTAL_LABELS),
		estimatedTax: parseLabeledCurrency(doc, sel.FIELD_ORDER_ESTIMATED_TAX_LABELS),
		couponSavings: parseLabeledCurrency(doc, sel.FIELD_ORDER_COUPON_SAVINGS_LABELS),
		items: parseItems(doc),
	};
}
