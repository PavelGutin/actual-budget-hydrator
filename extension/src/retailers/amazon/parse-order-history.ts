import { select, selectOne, textOf } from "./dom";
import { parseOrder } from "./parse-order";
import { parseOrderNumber } from "./parse-order-number";
import * as sel from "./selectors";

export interface OrderSummary {
	/** Position within this page's list (upstream Order.index with start_index 0). */
	index: number;
	orderNumber: string | null;
	grandTotal: number | null;
	orderPlacedDate: string | null;
	orderDetailsLink: string | null;
	cancelled: boolean;
	isWholeFoods: boolean;
	/** Card contents were client-side encrypted: only orderNumber (from the slot id) is available. */
	contentEncrypted: boolean;
}

/**
 * Port of AmazonOrders._is_csd_encrypted: the card holds the decryption container and its order
 * number isn't readable (a readable card can still encrypt a single field the same way).
 */
export function isCsdEncrypted(card: Element): boolean {
	if (!selectOne(card, sel.ORDER_HISTORY_CSD_ENCRYPTED_SELECTOR)) return false;
	const n = selectOne(card, sel.FIELD_ORDER_NUMBER_SELECTOR);
	return !(n && textOf(n).trim());
}

export function hasCsdEncryptedOrders(doc: Document): boolean {
	return select(doc, sel.ORDER_HISTORY_ENTITY_SELECTOR).some(isCsdEncrypted);
}

/** The same URL as Amazon's no-JavaScript fallback, which renders encrypted cards readable. */
export function withDisableCsd(url: string): string {
	const u = new URL(url);
	u.searchParams.set(sel.DISABLE_CSD_QUERY_PARAM, sel.DISABLE_CSD_NO_JS);
	return u.toString();
}

/**
 * Port of AmazonOrders.parse_orders (summary fields, full_details=False). Unlike upstream, an
 * encrypted card doesn't throw: it yields its order number from the card's slot id and nulls elsewhere.
 */
export function parseOrderHistory(doc: Document): OrderSummary[] {
	return select(doc, sel.ORDER_HISTORY_ENTITY_SELECTOR).map((card, index) => {
		const contentEncrypted = isCsdEncrypted(card);
		if (contentEncrypted) {
			return {
				index,
				orderNumber: parseOrderNumber(card.getAttribute(sel.ORDER_CARD_SLOT_ID_ATTRIBUTE)),
				grandTotal: null,
				orderPlacedDate: null,
				orderDetailsLink: null,
				cancelled: false,
				isWholeFoods: false,
				contentEncrypted,
			};
		}
		const o = parseOrder(card, { fullDetails: false });
		return {
			index,
			orderNumber: o.orderNumber,
			grandTotal: o.grandTotal,
			orderPlacedDate: o.orderPlacedDate,
			orderDetailsLink: o.orderDetailsLink,
			cancelled: o.cancelled,
			isWholeFoods: o.isWholeFoods,
			contentEncrypted,
		};
	});
}
