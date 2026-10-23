export interface Charge {
	completedDate: string; // ISO date, "YYYY-MM-DD"
	grandTotal: number;
	orderNumber: string | null;
	paymentMethodLast4: string | null;
	isRefund: boolean;
}

/** The subset of an Actual transaction's fields matching actually needs. */
export interface MatchableTransaction {
	id: string;
	date: string; // ISO date, "YYYY-MM-DD"
	amount: number; // dollars, Actual's sign convention: negative = expense
	notes: string | null;
}

export interface MatchResult<T extends MatchableTransaction = MatchableTransaction> {
	transaction: T;
	charge: Charge | null;
	ambiguousCandidates: Charge[];
}
