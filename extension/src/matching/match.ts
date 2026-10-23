import type { Charge, MatchableTransaction, MatchResult } from "./types";

const DATE_TOLERANCE_DAYS = 5;
const AMOUNT_TOLERANCE_CENTS = 1;

/**
 * Matches an Amazon order number embedded in an existing note, e.g. from an older tool's
 * "Item Title | (123-4567890-1234567)" format. Treated as ground truth: if a transaction
 * already names its order, that's trusted over guessing by amount/date.
 */
const ORDER_NUMBER_IN_NOTES = /\((\d{3}-\d{7}-\d{7}|[A-Z]\d{2}-\d{7}-\d{7})\)/;

export function extractOrderNumberFromNotes(notes: string | null | undefined): string | null {
	if (!notes) return null;
	const match = notes.match(ORDER_NUMBER_IN_NOTES);
	return match ? match[1] : null;
}

function toCents(amount: number): number {
	return Math.round(amount * 100);
}

/** Whole days between two ISO "YYYY-MM-DD" dates, via UTC epoch days -- avoids any local-timezone drift. */
function daysBetween(isoA: string, isoB: string): number {
	const [ya, ma, da] = isoA.split("-").map(Number);
	const [yb, mb, db] = isoB.split("-").map(Number);
	const epochA = Date.UTC(ya, ma - 1, da);
	const epochB = Date.UTC(yb, mb - 1, db);
	return Math.round((epochA - epochB) / 86_400_000);
}

function amountMatches(txnAmountCents: number, charge: Charge): boolean {
	const chargeCents = Math.round(charge.grandTotal * 100);
	return Math.abs(txnAmountCents - chargeCents) <= AMOUNT_TOLERANCE_CENTS;
}

function dateMatches(txnDate: string, charge: Charge): boolean {
	return Math.abs(daysBetween(txnDate, charge.completedDate)) <= DATE_TOLERANCE_DAYS;
}

/**
 * Among `poolIdx` (indices already filtered to a sign/eligibility pool), picks the one
 * closest in date, or flags ambiguous if there isn't a single best. Returns the chosen
 * index (to mark as used) alongside the MatchResult, or null/no-match.
 */
function pickBest<T extends MatchableTransaction>(
	txn: T,
	poolIdx: number[],
	charges: Charge[],
): [number | null, MatchResult<T>] {
	if (poolIdx.length === 0) {
		return [null, { transaction: txn, charge: null, ambiguousCandidates: [] }];
	}

	if (poolIdx.length === 1) {
		return [poolIdx[0], { transaction: txn, charge: charges[poolIdx[0]], ambiguousCandidates: [] }];
	}

	const sorted = [...poolIdx].sort(
		(a, b) => Math.abs(daysBetween(txn.date, charges[a].completedDate)) -
			Math.abs(daysBetween(txn.date, charges[b].completedDate)),
	);
	const [best, second] = sorted;
	const bestDiff = Math.abs(daysBetween(txn.date, charges[best].completedDate));
	const secondDiff = Math.abs(daysBetween(txn.date, charges[second].completedDate));

	if (bestDiff < secondDiff) {
		return [best, { transaction: txn, charge: charges[best], ambiguousCandidates: [] }];
	}

	return [
		null,
		{ transaction: txn, charge: null, ambiguousCandidates: sorted.map((i) => charges[i]) },
	];
}

export function matchTransactions<T extends MatchableTransaction>(
	transactions: T[],
	charges: Charge[],
): MatchResult<T>[] {
	const used = new Set<number>();
	const chargesByOrder = new Map<string | null, number[]>();
	charges.forEach((c, i) => {
		const bucket = chargesByOrder.get(c.orderNumber) ?? [];
		bucket.push(i);
		chargesByOrder.set(c.orderNumber, bucket);
	});

	const results = new Map<T, MatchResult<T>>();
	const deferred: T[] = [];

	// Phase 1: trust an order number already embedded in the transaction's notes.
	for (const txn of transactions) {
		const txnAmountCents = toCents(txn.amount);
		const noteOrder = extractOrderNumberFromNotes(txn.notes);
		if (!noteOrder) {
			deferred.push(txn);
			continue;
		}

		const orderPoolIdx = (chargesByOrder.get(noteOrder) ?? []).filter(
			(i) => !used.has(i) && charges[i].isRefund === txnAmountCents > 0,
		);
		// The note tells us which order, but an order can have several charges of the same
		// sign (e.g. two separate per-item refunds) -- amount still picks out which one.
		const poolIdx = orderPoolIdx.filter((i) => amountMatches(txnAmountCents, charges[i]));
		if (poolIdx.length === 0) {
			// The note names an order, but nothing in it (at this sign) matches the
			// transaction's amount -- stale/wrong note. Fall back to amount/date heuristic.
			deferred.push(txn);
			continue;
		}

		const [chosenIdx, result] = pickBest(txn, poolIdx, charges);
		if (chosenIdx !== null) used.add(chosenIdx);
		results.set(txn, result);
	}

	// Phase 2: ordinary amount/date matching for everything left.
	for (const txn of deferred) {
		const txnAmountCents = toCents(txn.amount);
		const poolIdx = charges
			.map((_, i) => i)
			.filter(
				(i) =>
					!used.has(i) &&
					charges[i].isRefund === txnAmountCents > 0 &&
					amountMatches(txnAmountCents, charges[i]) &&
					dateMatches(txn.date, charges[i]),
			);
		const [chosenIdx, result] = pickBest(txn, poolIdx, charges);
		if (chosenIdx !== null) used.add(chosenIdx);
		results.set(txn, result);
	}

	return transactions.map((txn) => results.get(txn)!);
}
