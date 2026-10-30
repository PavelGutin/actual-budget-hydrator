import { orderNoteUrl, type PlanRow } from "./plan";

/**
 * Builds the `transactions-batch-update` payloads that apply (and undo) a plan row, the same
 * operation Actual's own split editor sends. A multi-item row becomes a split: the bank
 * transaction turns into the parent (notes = order link; a parent carries no category of its own) and
 * each item becomes a child with its title in the notes. Children take the transaction's category
 * if it had one, otherwise stay uncategorized for you to triage (the Python CLI always clears it).
 * Always a split, as the Python CLI's apply_split does: a one-item order gets one child.
 */

/** Fields Actual's batch update accepts for a transaction (subset). */
export interface ActualTxnWrite {
	id: string;
	account?: string;
	date?: string;
	amount?: number;
	payee?: string | null;
	category?: string | null;
	notes?: string | null;
	cleared?: boolean | null;
	reconciled?: boolean;
	is_parent?: boolean;
	is_child?: boolean;
	parent_id?: string | null;
	starting_balance_flag?: boolean | null;
	error?: null;
}

export interface BatchUpdate {
	added?: ActualTxnWrite[];
	updated?: ActualTxnWrite[];
	deleted?: { id: string }[];
}

/** The full Actual transaction a split is made from (the parent's own fields carry to children). */
export interface ParentSource {
	id: string;
	account: string;
	date: string;
	amount: number;
	payee: string | null;
	category: string | null;
	notes: string | null;
	cleared: boolean | null;
	reconciled: boolean;
}

/** What one apply changed, so it can be undone exactly. */
export interface AppliedChange {
	parentId: string;
	childIds: string[];
	previous: { notes: string | null; category: string | null };
	orderNumber: string;
	appliedAt: string;
	/** For the history list. */
	txnDate?: string;
	amount?: number;
	budget?: string | null;
	budgetId?: string | null;
}

const MAX_NOTE = 1000;

/** Mirrors loot-core's makeChild: children inherit account/date/payee/cleared from the parent. */
function makeChild(parent: ParentSource, id: string, amount: number, notes: string): ActualTxnWrite {
	return {
		id,
		amount,
		account: parent.account,
		date: parent.date,
		payee: parent.payee,
		cleared: parent.cleared,
		reconciled: parent.reconciled,
		starting_balance_flag: null,
		category: parent.category,
		notes: notes.slice(0, MAX_NOTE),
		is_child: true,
		parent_id: parent.id,
		error: null,
	};
}

export function buildApply(
	row: PlanRow,
	parent: ParentSource,
	newId: () => string,
	now = () => new Date().toISOString(),
): { batch: BatchUpdate; change: AppliedChange } {
	if ((row.status !== "ready" && row.status !== "single-item") || !row.order?.orderNumber) {
		throw new Error(`plan row for ${row.txn.id} isn't ready to apply (${row.status})`);
	}
	const sum = row.splits.reduce((a, s) => a + s.amountCents, 0);
	if (sum !== parent.amount) {
		throw new Error(`splits sum to ${sum} but the transaction is ${parent.amount}; refusing to write`);
	}
	const orderNumber = row.order.orderNumber;
	const link = orderNoteUrl(orderNumber);
	const previous = { notes: parent.notes, category: parent.category };

	const children = row.splits.map((s) => makeChild(parent, newId(), s.amountCents, s.title));
	return {
		batch: {
			added: children,
			updated: [{ id: parent.id, is_parent: true, category: null, notes: link }],
		},
		change: {
			parentId: parent.id,
			childIds: children.map((c) => c.id),
			previous,
			orderNumber,
			appliedAt: now(),
			txnDate: parent.date,
			amount: parent.amount,
		},
	};
}

/** Undo an apply: drop the children, and restore the parent's notes/category and un-split it. */
export function buildRevert(change: AppliedChange): BatchUpdate {
	return {
		deleted: change.childIds.map((id) => ({ id })),
		updated: [
			{
				id: change.parentId,
				...(change.childIds.length ? { is_parent: false } : {}),
				notes: change.previous.notes,
				category: change.previous.category,
			},
		],
	};
}
