import type { TextSelector } from "./dom";

/**
 * CSS selectors and page text ported from amazon-orders' selectors.py (MIT,
 * github.com/alexdlaird/amazon-orders), synced with upstream as of 2026-10-23 for the fields this
 * extension uses. Kept as plain data so they stay a 1:1 diff against upstream when Amazon's markup moves.
 */

export const BASE_URL = "https://www.amazon.com";
export const ORDER_DETAILS_URL = `${BASE_URL}/gp/your-account/order-details`;
export const ORDER_ID_QUERY_PARAM = "orderID";
export const DISABLE_CSD_QUERY_PARAM = "disableCsd";
export const DISABLE_CSD_NO_JS = "no-js";
export const WHOLE_FOODS_DETAILS_ROUTES = ["/fopo/order-details", "/wholefoodsmarket/receipts/order/"];

// ---- Pages / entities -------------------------------------------------------------------------

export const ORDER_HISTORY_ENTITY_SELECTOR = ["div.order-card", "div.order"];
/** Readable pages also encrypt single fields in this, so a card is encrypted only if its order number is unreadable. */
export const ORDER_HISTORY_CSD_ENCRYPTED_SELECTOR = "div.csd-encrypted-sensitive";
/** Not upstream: the card's analytics slot id carries the order number even when the card is encrypted. */
export const ORDER_CARD_SLOT_ID_ATTRIBUTE = "data-csa-c-slot-id";
export const ORDER_DETAILS_ENTITY_SELECTOR = ["div#orderDetails", "div#ordersContainer", "div#odp-main-section"];
export const ORDER_DETAILS_ERROR_SELECTOR = "[data-component='errorbanner']";

export const ITEM_ENTITY_SELECTOR = [
	"[data-component='purchasedItems'] .a-fixed-left-grid",
	"div:has(> div.yohtmlc-item)",
	".item-box, .yo-enhanced-flex-card, .yo-enhanced-card",
	// WFM in-store line items
	"div.a-row.a-spacing-base:has(img.ufpo-itemListWidget-image)",
];

export const ORDER_PHYSICAL_STORE_TEXT = "Purchased at Amazon";
export const ORDER_WHOLE_FOODS_TEXT = "Whole Foods Market";
export const ORDER_CANCELLED_TEXT = "Cancelled";
export const ORDER_SERVICE_CANCELLED_TEXT = "Service cancelled";

/** We can't reliably parse items for these (Amazon Fresh, WFM receipts, physical stores). */
export const ORDER_SKIP_ITEMS: (string | TextSelector)[] = [
	".brand-info-box .brand-logo img",
	"a.yohtmlc-order-details-link[href^='/wholefoodsmarket']",
	{ css: "div.yohtmlc-shipment-status-primaryText", text: ORDER_PHYSICAL_STORE_TEXT },
];
/** A Whole Foods Market purchase; unlike ORDER_SKIP_ITEMS these still expose a grand total. */
export const ORDER_WHOLE_FOODS: (string | TextSelector)[] = [
	"a[href*='/wholefoodsmarket/receipts/order/']",
	"a[href*='/fopo/order-details']",
	{ css: "div.yohtmlc-shipment-status-primaryText", textContains: ORDER_WHOLE_FOODS_TEXT },
	"img.ufpo-itemListWidget-image",
];
export const ORDER_SKIP_TOTALS: (string | TextSelector)[] = [
	{ css: "div.yohtmlc-shipment-status-primaryText", text: ORDER_CANCELLED_TEXT },
	{ css: "div.yohtmlc-shipment-status-primaryText", text: ORDER_SERVICE_CANCELLED_TEXT },
	{ css: "h4.a-alert-heading", textContains: ORDER_CANCELLED_TEXT },
];
export const ORDER_SHIPMENT_STATUS_SELECTOR = "h4.od-status-message";
export const ORDER_SHIPMENT_CANCELLED_SELECTOR: TextSelector = {
	css: ORDER_SHIPMENT_STATUS_SELECTOR,
	textContains: ORDER_CANCELLED_TEXT,
};

// ---- Item fields ------------------------------------------------------------------------------

export const FIELD_ITEM_QUANTITY_SELECTOR = [
	".od-item-view-qty",
	"span.item-view-qty",
	"span.product-image__qty",
	".hzsearch-item-view-qty",
	// Not upstream: live (Oct 2026) detail pages carry an (empty when 1) quantity slot per item
	"[data-component='quantity']",
];
export const FIELD_ITEM_WHOLE_FOODS_QUANTITY_SELECTOR = ["span.a-size-small"];
export const FIELD_ITEM_WHOLE_FOODS_QUANTITY_REGEX = "^Qty:\\s*{count}$";
export const FIELD_ITEM_TITLE_SELECTOR = [
	"[data-component='itemTitle']",
	".yohtmlc-item a",
	".yohtmlc-product-title",
	"div.a-column.a-span10 > a",
	"div.a-column.a-span10 > span",
	".yo-enhanced-title a",
	"div.a-col-right a > p",
];
export const FIELD_ITEM_PRICE_SELECTOR = [
	"[data-component='unitPrice'] .a-text-price :not(.a-offscreen)",
	".yohtmlc-item .a-color-price",
	"div.a-section.a-text-right span.a-size-small",
];

// ---- Order fields -----------------------------------------------------------------------------

export const FIELD_ORDER_DETAILS_LINK_SELECTOR = [
	"a.yohtmlc-order-details-link",
	"a[href*='/wholefoodsmarket/receipts/order/']",
	"a[href*='/fopo/order-details']",
	"div.a-col-right > div.a-row > a[href*='/your-orders/order-details']",
	// Not upstream: live (Oct 2026) cards dropped .yohtmlc-order-details-link for a plain link
	"a[href*='/your-orders/order-details']",
];
export const FIELD_ORDER_NUMBER_SELECTOR = [
	"[data-component='orderId']",
	"[data-component='briefOrderInfo'] div.a-column",
	".order-date-invoice-item :is(bdi, span)[dir='ltr']",
	".yohtmlc-order-id :is(bdi, span)[dir='ltr']",
	":is(bdi, span)[dir='ltr']",
];
export const FIELD_ORDER_GRAND_TOTAL_SELECTOR = [
	"div.yohtmlc-order-total span.value",
	"div.order-header div.a-column.a-span2",
	"div.order-header div.a-col-left .a-span9",
	"#wfm-grand-total-amount",
];
export const FIELD_ORDER_GRAND_TOTAL_PREFIX = "total";
export const FIELD_ORDER_WHOLE_FOODS_SUBTOTAL_SELECTOR = "#wfm-subtotal-amount";
export const FIELD_ORDER_WHOLE_FOODS_TAX_SELECTOR = "#wfm-tax-total-amount";
export const FIELD_ORDER_PLACED_DATE_SELECTOR = [
	"[data-component='orderDate']",
	"span.order-date-invoice-item",
	"[data-component='briefOrderInfo'] div.a-column",
	"div:is(.a-span3, .a-span12)",
];
export const FIELD_ORDER_PLACED_DATE_SUFFIX = "Order #";

export const FIELD_ORDER_SUBTOTALS_TAG_ITERATOR_SELECTOR = [
	"[data-component='orderSubtotals'] div.a-row",
	"div#od-subtotals div.a-row",
	"[data-component='chargeSummary'] div.od-line-item-row",
];
export const FIELD_ORDER_SUBTOTALS_TAG_POPOVER_PRELOAD_SELECTOR = ".a-popover-preload";
export const FIELD_ORDER_SUBTOTALS_INNER_TAG_SELECTOR = "div.a-span-last";

/** A label is a lowercase substring of the row text, or a regex searched in it. */
export type Label = string | RegExp;

export const FIELD_ORDER_GRAND_TOTAL_LABELS: Label[] = ["grand total", "total for this order"];
export const FIELD_ORDER_SUBTOTAL_LABELS: Label[] = ["subtotal"];
export const FIELD_ORDER_SHIPPING_TOTAL_LABELS: Label[] = ["shipping", "postage"];
export const FIELD_ORDER_FREE_SHIPPING_LABELS: Label[] = ["free shipping"];
export const FIELD_ORDER_PROMOTION_APPLIED_LABELS: Label[] = ["promotion"];
export const FIELD_ORDER_COUPON_SAVINGS_LABELS: Label[] = ["coupon"];
export const FIELD_ORDER_REWARD_POINTS_LABELS: Label[] = ["reward"];
export const FIELD_ORDER_SUBSCRIPTION_DISCOUNT_LABELS: Label[] = ["subscribe", "subscription"];
export const FIELD_ORDER_TOTAL_BEFORE_TAX_LABELS: Label[] = ["before tax", "before vat"];
export const FIELD_ORDER_ESTIMATED_TAX_LABELS: Label[] = ["estimated tax", "tax collected", "estimated vat", /^\s*vat\b/];
export const FIELD_ORDER_REFUND_TOTAL_LABELS: Label[] = ["refund total"];
export const FIELD_ORDER_MULTIBUY_DISCOUNT_LABELS: Label[] = ["multibuy discount"];
export const FIELD_ORDER_AMAZON_DISCOUNT_LABELS: Label[] = ["amazon discount"];
export const FIELD_ORDER_GIFT_CARD_LABELS: Label[] = ["gift card amount", "gift card"];
export const FIELD_ORDER_GIFT_WRAP_LABELS: Label[] = ["gift wrap"];

export const FIELD_ORDER_ITEM_COUNT_SELECTOR = ["div.a-fixed-left-grid-col.a-col-right span", "span"];
export const FIELD_ORDER_ITEM_COUNT_REGEX = "{count}\\s+items?\\s+in this purchase";

// ---- Refund breakdown (from the Python CLI's refund_scrape.py, not upstream) -------------------

/** Older layout: the breakdown rows sit in a preloaded popover on the details page. */
export const REFUND_BREAKDOWN_PRELOAD_SELECTOR = "#a-popover-orderRefundBreakdown";
/** Newer layout: the rows are HTML inside a `data-a-popover` JSON attribute's `inlineContent`. */
export const REFUND_BREAKDOWN_POPOVER_ATTR = "data-a-popover";
export const REFUND_BREAKDOWN_ROW_SELECTOR = "div.od-line-item-row, div.a-row";
export const REFUND_BREAKDOWN_VALUE_SELECTOR = ".od-line-item-row-content, .a-span-last";
export const REFUND_TOTAL_LABEL = "Refund Total";
export const REFUND_ITEMS_LABEL = "Item(s) refund";
