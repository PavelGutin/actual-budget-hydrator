import { selectOne } from "./dom";
import { type ParsedOrder, parseOrder } from "./parse-order";
import * as sel from "./selectors";

export type { ParsedItem, ParsedOrder, RefundBreakdown } from "./parse-order";

/**
 * Port of AmazonOrders.parse_order_details: the details entity on the page, parsed with full details.
 * Returns null when the page has no order-details container (not found / changed markup) -- upstream raises.
 * `orderNumber` is the ID the page was fetched for, used when the page doesn't render its own.
 */
export function parseOrderDetails(doc: Document, orderNumber?: string | null): ParsedOrder | null {
	const root = selectOne(doc, sel.ORDER_DETAILS_ENTITY_SELECTOR);
	if (!root) return null;
	return parseOrder(root, { fullDetails: true, orderNumber });
}

/** Whether a (post-redirect) details URL is a Whole Foods Market page rather than the standard one. */
export function isWholeFoodsDetailsUrl(url: string): boolean {
	return sel.WHOLE_FOODS_DETAILS_ROUTES.some((route) => url.includes(route));
}
