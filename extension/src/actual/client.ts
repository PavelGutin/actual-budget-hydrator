import type { ActualTxn } from "../sync/plan";
import type { BatchUpdate, ParentSource } from "../sync/batch";
import { ACTUAL_PORT, type ActualRequest, type ActualResponse } from "./protocol";

/** Results-page side of the bridge: request/response over a port to the Actual tab. */
export interface ActualClient {
	query<T = unknown>(table: string, opts?: { filter?: unknown; select?: unknown; options?: unknown }): Promise<T>;
	send<T = unknown>(method: string, args?: unknown): Promise<T>;
	ping(timeoutMs?: number): Promise<void>;
	close(): void;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface PortLike {
	postMessage(msg: unknown): void;
	disconnect(): void;
	onMessage: { addListener(cb: (msg: unknown) => void): void };
	onDisconnect: { addListener(cb: () => void): void };
}

export function actualClient(port: PortLike, defaultTimeoutMs = 60_000): ActualClient {
	let seq = 0;
	const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	port.onMessage.addListener((raw) => {
		const res = raw as ActualResponse;
		const p = pending.get(res.id);
		if (!p) return;
		pending.delete(res.id);
		clearTimeout(p.timer);
		if (res.error) p.reject(new Error(res.error));
		else p.resolve(res.data);
	});
	port.onDisconnect.addListener(() => {
		// Reading lastError marks it handled; otherwise Chrome logs "Receiving end does not exist" whenever
		// the first ping reaches a tab the bridge hasn't been injected into yet (which is expected).
		void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime?.lastError;
		for (const p of pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("lost contact with the Actual tab"));
		}
		pending.clear();
	});
	function request<T>(req: DistributiveOmit<ActualRequest, "id">, timeoutMs = defaultTimeoutMs): Promise<T> {
		const id = `abh-${Date.now()}-${++seq}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("the Actual tab didn't answer"));
			}, timeoutMs);
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			port.postMessage({ ...req, id });
		});
	}
	return {
		query: (table, opts = {}) => request({ kind: "query", table, ...opts }),
		send: (method, args) => request({ kind: "send", method, args }),
		ping: async (timeoutMs = 3000) => {
			await request({ kind: "ping" }, timeoutMs);
		},
		close: () => port.disconnect(),
	};
}

export { ACTUAL_PORT };

/** Raw row shape from the AQL query in loadTransactions. */
interface RawActualTxn {
	id: string;
	account: string;
	date: string;
	amount: number;
	notes: string | null;
	category: string | null;
	payee: string | null;
	payee_name: string | null;
	is_parent: boolean | number;
	is_child: boolean | number;
	transfer_id: string | null;
	cleared: boolean | number | null;
	reconciled: boolean | number | null;
}

const TXN_SELECT = [
	"id", "account", "date", "amount", "notes", "category", "payee",
	{ payee_name: "payee.name" },
	"is_parent", "is_child", "transfer_id", "cleared", "reconciled",
];

/** Top-level (non-child) transactions on/after `sinceDate`, as plan inputs plus their write sources. */
export async function loadTransactions(
	client: ActualClient,
	sinceDate: string,
): Promise<{ txns: ActualTxn[]; sources: Map<string, ParentSource> }> {
	const rows = await client.query<RawActualTxn[]>("transactions", {
		filter: { date: { $gte: sinceDate } },
		select: TXN_SELECT,
		options: { splits: "none" },
	});
	const txns: ActualTxn[] = [];
	const sources = new Map<string, ParentSource>();
	for (const r of rows ?? []) {
		txns.push(toPlanTxn(r));
		sources.set(r.id, toSource(r));
	}
	return { txns, sources };
}

/** Fresh copy of one transaction right before writing, so a stale plan can't overwrite newer edits. */
export async function loadTransaction(client: ActualClient, id: string): Promise<{ txn: ActualTxn; source: ParentSource } | null> {
	const rows = await client.query<RawActualTxn[]>("transactions", { filter: { id }, select: TXN_SELECT, options: { splits: "none" } });
	const r = rows?.[0];
	return r ? { txn: toPlanTxn(r), source: toSource(r) } : null;
}

export interface ActualAccount {
	id: string;
	name: string;
	offbudget: boolean;
	closed: boolean;
}

export async function loadAccounts(client: ActualClient): Promise<ActualAccount[]> {
	const rows = await client.query<{ id: string; name: string; offbudget: unknown; closed: unknown }[]>("accounts", {
		select: ["id", "name", "offbudget", "closed"],
	});
	return (rows ?? []).map((r) => ({ id: r.id, name: r.name, offbudget: !!r.offbudget, closed: !!r.closed }));
}

export async function applyBatch(client: ActualClient, batch: BatchUpdate): Promise<void> {
	await client.send("transactions-batch-update", batch);
}

export async function budgetName(client: ActualClient): Promise<string | null> {
	return (await openBudget(client))?.name ?? null;
}

/** The budget loaded in the Actual tab, or null when Actual is showing its file picker / nothing is open. */
export async function openBudget(client: ActualClient): Promise<{ id: string; name: string | null } | null> {
	const prefs = await client.send<{ id?: string; budgetName?: string } | null>("load-prefs");
	return prefs?.id ? { id: prefs.id, name: prefs.budgetName ?? null } : null;
}

function toPlanTxn(r: RawActualTxn): ActualTxn {
	return {
		id: r.id,
		account: r.account,
		date: r.date,
		amount: r.amount,
		payeeName: r.payee_name ?? null,
		notes: r.notes ?? null,
		category: r.category ?? null,
		isParent: !!r.is_parent,
		isChild: !!r.is_child,
		transferId: r.transfer_id ?? null,
		cleared: r.cleared === null || r.cleared === undefined ? null : !!r.cleared,
	};
}

function toSource(r: RawActualTxn): ParentSource {
	return {
		id: r.id,
		account: r.account,
		date: r.date,
		amount: r.amount,
		payee: r.payee ?? null,
		category: r.category ?? null,
		notes: r.notes ?? null,
		cleared: r.cleared === null || r.cleared === undefined ? null : !!r.cleared,
		reconciled: !!r.reconciled,
	};
}
