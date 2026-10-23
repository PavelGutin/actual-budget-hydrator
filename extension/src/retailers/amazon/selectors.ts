/**
 * CSS selectors ported from amazon-orders' selectors.py (MIT, github.com/alexdlaird/amazon-orders).
 * Kept as plain strings/lists so they stay a 1:1 diff against upstream when Amazon's markup moves.
 */

export const ITEM_ENTITY_SELECTOR = [
	"[data-component='purchasedItems'] .a-fixed-left-grid",
	"div:has(> div.yohtmlc-item)",
	".item-box, .yo-enhanced-flex-card, .yo-enhanced-card",
	"div.a-row.a-spacing-base:has(img.ufpo-itemListWidget-image)",
];

export const FIELD_ITEM_TITLE_SELECTOR = [
	"[data-component='itemTitle']",
	".yohtmlc-item a",
	".yohtmlc-product-title",
	"div.a-column.a-span10 > a",
	"div.a-column.a-span10 > span",
	".yo-enhanced-title a",
];

export const FIELD_ITEM_PRICE_SELECTOR = [
	"[data-component='unitPrice'] .a-text-price :not(.a-offscreen)",
	".yohtmlc-item .a-color-price",
	"div.a-section.a-text-right span.a-size-small",
];

export const ORDER_HISTORY_ENTITY_SELECTOR = ["div.order-card", "div.order"];

export const FIELD_ORDER_DETAILS_LINK_SELECTOR = ["a.yohtmlc-order-details-link"];

export const FIELD_ORDER_PLACED_DATE_SELECTOR = [
	"[data-component='orderDate']",
	"span.order-date-invoice-item",
	"[data-component='briefOrderInfo'] div.a-column",
	"div:is(.a-span3, .a-span12)",
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
export const FIELD_ORDER_GRAND_TOTAL_LABELS = ["grand total", "total for this order"];

export const FIELD_ORDER_SUBTOTALS_TAG_ITERATOR_SELECTOR = [
	"[data-component='orderSubtotals'] div.a-row",
	"div#od-subtotals div.a-row",
	"[data-component='chargeSummary'] div.od-line-item-row",
];
export const FIELD_ORDER_SUBTOTALS_TAG_POPOVER_PRELOAD_SELECTOR = ".a-popover-preload";
export const FIELD_ORDER_SUBTOTALS_INNER_TAG_SELECTOR = "div.a-span-last";

export const FIELD_ORDER_SUBTOTAL_LABELS = ["subtotal"];
export const FIELD_ORDER_SHIPPING_TOTAL_LABELS = ["shipping"];
export const FIELD_ORDER_ESTIMATED_TAX_LABELS = ["estimated tax", "tax collected"];
export const FIELD_ORDER_FREE_SHIPPING_LABELS = ["free shipping"];
export const FIELD_ORDER_PROMOTION_APPLIED_LABELS = ["promotion"];
export const FIELD_ORDER_COUPON_SAVINGS_LABELS = ["coupon"];
export const FIELD_ORDER_REWARD_POINTS_LABELS = ["reward"];
export const FIELD_ORDER_SUBSCRIPTION_DISCOUNT_LABELS = ["subscribe", "subscription"];
export const FIELD_ORDER_MULTIBUY_DISCOUNT_LABELS = ["multibuy discount"];
export const FIELD_ORDER_AMAZON_DISCOUNT_LABELS = ["amazon discount"];
export const FIELD_ORDER_GIFT_CARD_LABELS = ["gift card amount", "gift card"];
export const FIELD_ORDER_GIFT_WRAP_LABELS = ["gift wrap"];
