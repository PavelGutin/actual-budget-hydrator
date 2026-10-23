import { allocateProportional } from "./allocate-proportional";
import { AmbiguousSplitError, type ItemSplit, ReconciliationError, type SplittableOrder } from "./types";

const RECONCILIATION_TOLERANCE_CENTS = 2;
const MAX_ITEMS_FOR_SUBSET_SEARCH = 25;

const ADDITION_FIELDS = ["estimatedTax", "shippingTotal", "giftWrap"] as const;
const REDUCTION_FIELDS = [
	"freeShipping",
	"promotionApplied",
	"couponSavings",
	"subscriptionDiscount",
	"multibuyDiscount",
	"amazonDiscount",
	"rewardPoints",
	"giftCard",
] as const;

function toCents(amount: number | null | undefined): number {
	if (amount === null || amount === undefined) return 0;
	return Math.round(amount * 100);
}

/**
 * Distributes an Amazon order's items + order-level adjustments (tax, shipping, coupons,
 * discounts, gift cards, gift wrap) across the order's line items, using the order's own
 * total (not any particular matched transaction). `sign` is -1 for a charge, 1 for a
 * refund; returned amounts carry that sign.
 */
function computeFullOrderSplits(order: SplittableOrder, sign: 1 | -1): ItemSplit[] {
	const items = order.items.filter((item) => item.price !== null);
	if (items.length === 0) {
		throw new ReconciliationError(`Order ${order.orderNumber}: has no priced items`);
	}

	const baseCents = items.map((item) => toCents(item.price) * (item.quantity ?? 1));

	let adjustmentCents = 0;
	for (const field of [...ADDITION_FIELDS, ...REDUCTION_FIELDS]) {
		adjustmentCents += toCents(order[field]);
	}

	const signedBaseCents = baseCents.map((c) => sign * c);
	const adjustmentShares = allocateProportional(baseCents, adjustmentCents * sign);

	const finalCents = signedBaseCents.map((b, i) => b + adjustmentShares[i]);

	return items.map((item, i) => ({ title: item.title, amountCents: finalCents[i] }));
}

/**
 * Finds the subset of `fullSplits` whose amounts sum to `targetCents` within `tolerance`
 * -- for a transaction that only covers some of an order's items (e.g. a per-item partial
 * refund). Returns null if no subset matches, or the order has too many items to search.
 * Assumes every amount shares `targetCents`'s sign.
 *
 * Throws AmbiguousSplitError if more than one distinct combination of items matches
 * equally well (e.g. two items share the same price) -- which was actually involved
 * can't be determined, so this isn't guessed at.
 */
function findItemSubset(
	fullSplits: ItemSplit[],
	targetCents: number,
	tolerance: number,
): ItemSplit[] | null {
	const n = fullSplits.length;
	if (n === 0 || n > MAX_ITEMS_FOR_SUBSET_SEARCH) return null;

	const amounts = fullSplits.map((s) => Math.abs(s.amountCents));
	const targetAbs = Math.abs(targetCents);

	// Each achievable sum keeps up to 2 distinct combos reaching it -- enough to
	// detect a tie without the cost of tracking every combination.
	const achievable = new Map<number, number[][]>([[0, [[]]]]);
	amounts.forEach((amt, idx) => {
		for (const [s, combos] of [...achievable.entries()]) {
			const newSum = s + amt;
			if (newSum > targetAbs + tolerance) continue;
			const newCombo = [...combos[0], idx];
			const bucket = achievable.get(newSum) ?? [];
			const newSet = new Set(newCombo);
			const isDuplicate = bucket.some((c) => c.length === newSet.size && c.every((x) => newSet.has(x)));
			if (bucket.length < 2 && !isDuplicate) {
				bucket.push(newCombo);
				achievable.set(newSum, bucket);
			}
		}
	});

	let best: [number, number[][]] | null = null;
	for (const [s, combos] of achievable.entries()) {
		const first = combos[0];
		if (first.length === 0 || first.length === n) continue;
		if (Math.abs(s - targetAbs) <= tolerance) {
			if (best === null || Math.abs(s - targetAbs) < Math.abs(best[0] - targetAbs)) {
				best = [s, combos];
			}
		}
	}

	if (best === null) return null;

	const [, combos] = best;
	if (combos.length > 1) {
		throw new AmbiguousSplitError(
			`multiple distinct item combinations match amount ${(targetCents / 100).toFixed(2)}: ` +
				combos.map((combo) => combo.map((i) => fullSplits[i].title).join("+")).join(" vs "),
			combos.map((combo) => combo.map((i) => fullSplits[i].title)),
		);
	}

	return combos[0].map((i) => fullSplits[i]);
}

/**
 * Distributes an Amazon order's items + order-level adjustments across the items covered
 * by the matched Actual transaction, so the resulting per-item amounts sum exactly to
 * `transactionAmountCents`.
 *
 * If the transaction covers the whole order, every item is returned. If it only covers
 * some of the order (e.g. a per-item partial refund), the subset of items whose
 * proportional share matches the transaction amount is returned instead.
 *
 * `transactionAmountCents` carries the sign convention of the matched Actual transaction
 * (negative for an expense). Returned amounts carry the same sign.
 */
export function computeItemSplits(order: SplittableOrder, transactionAmountCents: number): ItemSplit[] {
	const sign: 1 | -1 = transactionAmountCents < 0 ? -1 : 1;
	const fullSplits = computeFullOrderSplits(order, sign);

	const target = transactionAmountCents;

	// With exactly one item, there's nothing to allocate between items -- whatever the
	// amount is (a full charge, a prorated partial refund, anything), it's all that one
	// item's. No subset search or whole-order check is meaningful here.
	if (fullSplits.length === 1) {
		return [{ title: fullSplits[0].title, amountCents: target }];
	}

	const fullTotal = fullSplits.reduce((a, s) => a + s.amountCents, 0);

	// Whether this transaction covers the *whole* order is decided against the order's
	// own authoritative total (order.grandTotal), not our reconstruction of it from named
	// adjustment fields -- Amazon sometimes applies a discount or adjustment not exposed
	// as a named field, so our reconstructed total can be off even for a genuine
	// whole-order event. When that happens, any gap is real but unlabeled, and gets
	// absorbed into the largest item rather than misread as a partial/per-item transaction.
	let isWholeOrder = Math.abs(target - fullTotal) <= RECONCILIATION_TOLERANCE_CENTS;
	if (!isWholeOrder && order.grandTotal !== null && order.grandTotal !== undefined) {
		isWholeOrder = Math.abs(target - sign * toCents(order.grandTotal)) <= RECONCILIATION_TOLERANCE_CENTS;
	}

	if (isWholeOrder) {
		const diff = target - fullTotal;
		const finalSplits = [...fullSplits];
		if (diff !== 0) {
			const largestIdx = finalSplits.reduce(
				(best, s, i) => (Math.abs(s.amountCents) > Math.abs(finalSplits[best].amountCents) ? i : best),
				0,
			);
			finalSplits[largestIdx] = {
				title: finalSplits[largestIdx].title,
				amountCents: finalSplits[largestIdx].amountCents + diff,
			};
		}
		return finalSplits;
	}

	const subset = findItemSubset(fullSplits, target, RECONCILIATION_TOLERANCE_CENTS);
	if (subset !== null) {
		const subsetDiff = target - subset.reduce((a, s) => a + s.amountCents, 0);
		const finalSubset = [...subset];
		if (subsetDiff !== 0) {
			const largestIdx = finalSubset.reduce(
				(best, s, i) => (Math.abs(s.amountCents) > Math.abs(finalSubset[best].amountCents) ? i : best),
				0,
			);
			finalSubset[largestIdx] = {
				title: finalSubset[largestIdx].title,
				amountCents: finalSubset[largestIdx].amountCents + subsetDiff,
			};
		}
		return finalSubset;
	}

	const diff = target - fullTotal;
	throw new ReconciliationError(
		`Order ${order.orderNumber}: items+adjustments total ${(fullTotal / 100).toFixed(2)} but matched ` +
			`transaction is ${(target / 100).toFixed(2)} (diff ${(diff / 100).toFixed(2)}); no subset of items ` +
			"matches either; needs manual review",
	);
}
