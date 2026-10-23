export interface ItemSplit {
	title: string;
	amountCents: number;
}

export interface OrderItem {
	title: string;
	price: number | null;
	quantity?: number | null;
}

/** The subset of a parsed Order's fields the proportional strategy needs. */
export interface SplittableOrder {
	orderNumber: string | null;
	grandTotal: number | null;
	items: OrderItem[];
	estimatedTax?: number | null;
	shippingTotal?: number | null;
	giftWrap?: number | null;
	freeShipping?: number | null;
	promotionApplied?: number | null;
	couponSavings?: number | null;
	subscriptionDiscount?: number | null;
	multibuyDiscount?: number | null;
	amazonDiscount?: number | null;
	rewardPoints?: number | null;
	giftCard?: number | null;
}

export class ReconciliationError extends Error {}

/** More than one distinct combination of items matches equally well (e.g. two items
 * share the same price) -- which was actually involved can't be determined, so it
 * isn't guessed at; the transaction should be queued for manual review instead. */
export class AmbiguousSplitError extends ReconciliationError {
	candidateCombos: string[][];

	constructor(message: string, candidateCombos: string[][]) {
		super(message);
		this.candidateCombos = candidateCombos;
	}
}
