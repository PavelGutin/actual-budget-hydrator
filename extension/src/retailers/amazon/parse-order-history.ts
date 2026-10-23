import { parseCurrency } from "./parse-currency";
import { parseFuzzyDate } from "./parse-fuzzy-date";
import { parseOrderNumber } from "./parse-order-number";
import * as sel from "./selectors";

export interface OrderSummary {
	index: number;
	orderNumber: string | null;
	grandTotal: number | null;
	orderPlacedDate: string | null;
	orderDetailsLink: string | null;
}

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

/**
 * Port of amazon-orders' AmazonOrders.parse_order_history (summary fields only -- full_details=False,
 * i.e. no items/shipments, matching what the history list page alone renders). `index` mirrors the
 * Python Order.index: position within this page's list, for correlating with `start_index` paging.
 */
export function parseOrderHistory(doc: Document): OrderSummary[] {
	const cards = selectFirst(doc, sel.ORDER_HISTORY_ENTITY_SELECTOR);

	return cards.map((card, index) => {
		const orderNumberEl = selectOneFirst(card, sel.FIELD_ORDER_NUMBER_SELECTOR);
		const grandTotalEl = selectOneFirst(card, sel.FIELD_ORDER_GRAND_TOTAL_SELECTOR);
		const dateEl = selectOneFirst(card, sel.FIELD_ORDER_PLACED_DATE_SELECTOR);
		const linkEl = selectOneFirst(card, sel.FIELD_ORDER_DETAILS_LINK_SELECTOR) as HTMLAnchorElement | null;

		return {
			index,
			orderNumber: parseOrderNumber(text(orderNumberEl)),
			grandTotal: grandTotalEl ? parseCurrency(text(grandTotalEl)) : null,
			orderPlacedDate: parseFuzzyDate(text(dateEl)),
			orderDetailsLink: linkEl?.getAttribute("href") ?? null,
		};
	});
}
