import type { ScanReport } from "../live/scan";
import { matchTransactions } from "../matching/match";
import type { Charge } from "../matching/types";
import type { ParsedOrder } from "../retailers/amazon/parse-order";
import type { ParsedTransaction } from "../retailers/amazon/parse-transactions";
import { computeItemSplits, computeItemSplitsFromBreakdown } from "../splitting/compute-item-splits";
import { AmbiguousSplitError, type ItemSplit, ReconciliationError } from "../splitting/types";

/**
 * Port of the Python CLI's sync.run_sync decision logic (amazon_actual_sync/sync.py), minus the
 * writes: which Actual transactions are candidates, which Amazon charge each matches, and the
 * per-item split each would get. Pure -- the UI shows this for review before anything is applied.
 */

/** The fields of an Actual transaction this needs (amount in cents, Actual's sign: negative = spend). */
export interface ActualTxn {
	id: string;
	account: string;
	date: string;
	amount: number;
	payeeName: string | null;
	notes: string | null;
	category: string | null;
	isParent: boolean;
	isChild: boolean;
	transferId: string | null;
	cleared: boolean | null;
}

export const DEFAULT_PAYEE_SUBSTRINGS = ["amazon", "amzn"];
/** Legacy note prefix (older tool), still recognized so re-runs skip those transactions. */
export const ORDER_NOTE_PREFIX = "AMZN-ORDER:";
export const orderNoteUrl = (orderNumber: string) =>
	`https://www.amazon.com/gp/your-account/order-details?orderID=${orderNumber}`;

/**
 * Which not-yet-itemized transactions to consider. Actual has no YNAB-style "approved" flag; the
 * nearest states it has are a missing category and not being cleared.
 */
export type TxnStateFilter = "uncategorized" | "uncleared" | "uncategorized-or-uncleared" | "all";

export interface PlanOptions {
	payeeSubstrings: string[];
	stateFilter: TxnStateFilter;
	/** Only consider Actual transactions on/after this ISO date (normally the scan's sinceDate). */
	sinceDate: string;
	/** Account ids to consider; undefined = every account. */
	accounts?: string[];
	/** Accounts where every transaction is Amazon (e.g. an Amazon store card): no payee check there. */
	amazonOnlyAccounts?: string[];
}

export function matchesStateFilter(t: Pick<ActualTxn, "category" | "cleared">, filter: TxnStateFilter): boolean {
	const uncategorized = !t.category;
	const uncleared = !t.cleared;
	switch (filter) {
		case "uncategorized":
			return uncategorized;
		case "uncleared":
			return uncleared;
		case "uncategorized-or-uncleared":
			return uncategorized || uncleared;
		case "all":
			return true;
	}
}

export type PlanStatus =
	| "ready" // matched, split computed
	| "single-item" // matched, one item: notes only, no split
	| "no-match" // no Amazon charge within tolerance
	| "ambiguous-match" // several charges fit equally
	| "pending" // the matching Amazon charge hasn't settled yet
	| "no-order-details" // matched a charge, but its order wasn't fetched/parsed
	| "split-failed"; // items + adjustments don't reconcile to the transaction

export interface PlanRow {
	txn: ActualTxn;
	status: PlanStatus;
	charge: Charge | null;
	order: ParsedOrder | null;
	splits: ItemSplit[];
	/** Human-readable reason for any status other than ready/single-item. */
	detail: string | null;
	usedRefundBreakdown: boolean;
	/** For ambiguous-match: the equally good charges, for the person to choose between. */
	candidates: Charge[];
}

export interface Plan {
	rows: PlanRow[];
	/** Actual transactions skipped because they're already split or noted. */
	skippedAlreadyDone: number;
	/** Skipped by the state filter (categorized and/or cleared). */
	skippedByState: number;
	/** Context for resolving a row by hand (resolveRow). */
	orders: Map<string, ParsedOrder>;
	refundEvents: Map<string, number>;
}

export function isAmazonPayee(name: string | null, substrings: string[]): boolean {
	if (!name) return false;
	const lower = name.toLowerCase();
	return substrings.some((s) => lower.includes(s.toLowerCase()));
}

export function alreadyProcessed(t: ActualTxn): boolean {
	if (t.isParent || t.isChild) return true;
	const notes = t.notes ?? "";
	return notes.includes(ORDER_NOTE_PREFIX) || notes.includes("amazon.com/gp/your-account/order-details");
}

export function chargeFromTransaction(t: ParsedTransaction): Charge | null {
	if (t.completedDate === null || t.grandTotal === null) return null;
	return {
		completedDate: t.completedDate,
		grandTotal: t.grandTotal,
		orderNumber: t.orderNumber,
		paymentMethodLast4: t.paymentMethodLast4,
		isRefund: t.isRefund,
		isGiftCard: t.isGiftCard,
		isPending: t.isPending,
	};
}

/** Amounts on the order are dollars; a breakdown is cents already. */
function splitsFor(
	order: ParsedOrder,
	amountCents: number,
	refundEventsForOrder: number,
): { splits: ItemSplit[]; usedRefundBreakdown: boolean } {
	try {
		return { splits: computeItemSplits(order, amountCents), usedRefundBreakdown: false };
	} catch (e) {
		// CLI resolve_item_splits: a refund that doesn't split proportionally can use the order's own
		// refund breakdown -- but only when it's that order's only refund event this run.
		const isRefund = amountCents > 0;
		if (!(e instanceof ReconciliationError) || !isRefund || refundEventsForOrder !== 1 || !order.refundBreakdown) throw e;
		return { splits: computeItemSplitsFromBreakdown(order, order.refundBreakdown, amountCents), usedRefundBreakdown: true };
	}
}

export interface CandidateSelection {
	candidates: ActualTxn[];
	skippedAlreadyDone: number;
	skippedByState: number;
}

/** The Actual transactions that could be itemized under these options (no Amazon data needed). */
export function selectCandidates(actualTxns: ActualTxn[], options: PlanOptions): CandidateSelection {
	let skippedAlreadyDone = 0;
	let skippedByState = 0;
	const accounts = options.accounts ? new Set(options.accounts) : null;
	const amazonOnly = new Set(options.amazonOnlyAccounts ?? []);
	const candidates: ActualTxn[] = [];
	for (const t of actualTxns) {
		if (t.date < options.sinceDate || t.transferId) continue;
		if (accounts && !accounts.has(t.account)) continue;
		if (!amazonOnly.has(t.account) && !isAmazonPayee(t.payeeName, options.payeeSubstrings)) continue;
		if (alreadyProcessed(t)) {
			skippedAlreadyDone++;
			continue;
		}
		if (!matchesStateFilter(t, options.stateFilter)) {
			skippedByState++;
			continue;
		}
		candidates.push(t);
	}
	return { candidates, skippedAlreadyDone, skippedByState };
}

export function buildPlan(actualTxns: ActualTxn[], scan: ScanReport, options: PlanOptions): Plan {
	const { candidates, skippedAlreadyDone, skippedByState } = selectCandidates(actualTxns, options);

	const charges = scan.transactions.map(chargeFromTransaction).filter((c): c is Charge => c !== null);
	const orders = new Map(scan.orderDetails.filter((d) => d.order).map((d) => [d.orderNumber, d.order as ParsedOrder]));

	const matchable = candidates.map((t) => ({ ...t, amount: t.amount / 100 }));
	const results = matchTransactions(matchable, charges);

	const refundEvents = new Map<string, number>();
	for (const r of results) {
		if (r.charge?.isRefund && r.charge.orderNumber) {
			refundEvents.set(r.charge.orderNumber, (refundEvents.get(r.charge.orderNumber) ?? 0) + 1);
		}
	}

	// Pending charges are never matched; say so rather than "no match" when one would have fit.
	const pendingCharges = charges.filter((c) => c.isPending);

	const rows: PlanRow[] = results.map((r, i) => {
		const txn = candidates[i];
		if (r.charge) return resolveRow(txn, r.charge, orders, refundEvents);
		const base = { txn, charge: null, order: null, splits: [], detail: null, usedRefundBreakdown: false, candidates: [] };
		if (r.ambiguousCandidates.length) {
			return {
				...base,
				status: "ambiguous-match",
				candidates: r.ambiguousCandidates,
				detail: "Several Amazon orders have this amount around this date. Pick which one it was.",
			};
		}
		const pending = pendingCharges.find(
			(c) => Math.abs(Math.round(c.grandTotal * 100) - txn.amount) <= 1 && c.isRefund === txn.amount > 0,
		);
		if (pending) return { ...base, status: "pending", detail: `Amazon charge for order ${pending.orderNumber} is still pending` };
		return { ...base, status: "no-match", detail: "no Amazon charge within $0.01 and 5 days" };
	});

	return { rows, skippedAlreadyDone, skippedByState, orders, refundEvents };
}

/** The plan row for a transaction matched to `charge` -- also used when the person picks an ambiguous match. */
export function resolveRow(
	txn: ActualTxn,
	charge: Charge,
	orders: Map<string, ParsedOrder>,
	refundEvents: Map<string, number>,
): PlanRow {
	const base = { txn, charge, order: null, splits: [], detail: null, usedRefundBreakdown: false, candidates: [] };
	const orderNumber = charge.orderNumber;
	const order = orderNumber ? orders.get(orderNumber) ?? null : null;
	if (!order) {
		return {
			...base,
			status: "no-order-details",
			detail: orderNumber ? `order ${orderNumber} wasn't fetched in this scan` : "the Amazon charge has no order number",
		};
	}
	try {
		const { splits, usedRefundBreakdown } = splitsFor(order, txn.amount, refundEvents.get(order.orderNumber ?? "") ?? 0);
		return { ...base, order, splits, usedRefundBreakdown, status: splits.length > 1 ? "ready" : "single-item" };
	} catch (e) {
		return { ...base, order, status: "split-failed", detail: splitFailureText(e, txn.amount) };
	}
}

const clip = (t: string, n = 48) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Plain-language reason a split couldn't be worked out. */
function splitFailureText(e: unknown, amountCents: number): string {
	const what = amountCents > 0 ? "refund" : "charge";
	if (e instanceof AmbiguousSplitError) {
		const options = e.candidateCombos.map((combo) => combo.map((t) => `“${clip(t)}”`).join(" + ")).join(" or ");
		return `This ${what} could be for ${options}; they cost the same, so it can't tell which. Itemize it by hand in Actual.`;
	}
	if (e instanceof ReconciliationError) {
		return `The order's items and adjustments don't add up to this ${what}, so it isn't split. It may be one of several partial charges or refunds.`;
	}
	return e instanceof Error ? e.message : String(e);
}
