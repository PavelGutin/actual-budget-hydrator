import type { ActualAccount, ActualClient } from "../../actual/client";
import type { ScanReport } from "../../live/scan";
import type { AppliedChange } from "../../sync/batch";
import { type ActualTxn, DEFAULT_PAYEE_SUBSTRINGS, type PlanOptions, type TxnStateFilter } from "../../sync/plan";
import { addDays, todayIso } from "./ui";

/** Everything the three steps share, plus what's remembered between sessions. */

export interface SyncPrefs {
	actualUrl: string;
	excludedAccounts: string[];
	amazonOnlyAccounts: string[];
	stateFilter: TxnStateFilter;
	payeeSubstrings: string;
	lookbackDays: number;
}

export const DEFAULT_PREFS: SyncPrefs = {
	actualUrl: "http://localhost:5006",
	excludedAccounts: [],
	amazonOnlyAccounts: [],
	stateFilter: "uncategorized",
	payeeSubstrings: DEFAULT_PAYEE_SUBSTRINGS.join(", "),
	lookbackDays: 90,
};

export const state = {
	prefs: { ...DEFAULT_PREFS },
	client: null as ActualClient | null,
	budget: null as string | null,
	/** Id of the budget connected in step 1; every later check compares against it. */
	budgetId: null as string | null,
	/** Result of the latest budget check; null = fine. */
	connectionProblem: null as string | null,
	accounts: [] as ActualAccount[],
	/** Actual transactions since the look-back date, as last loaded. */
	actualTxns: [] as ActualTxn[],
	lookback: addDays(todayIso(), -DEFAULT_PREFS.lookbackDays),
	scan: null as ScanReport | null,
};

export function planOptions(): PlanOptions {
	return {
		sinceDate: state.lookback,
		stateFilter: state.prefs.stateFilter,
		payeeSubstrings: state.prefs.payeeSubstrings.split(",").map((s) => s.trim()).filter(Boolean),
		accounts: state.accounts.map((a) => a.id).filter((id) => !state.prefs.excludedAccounts.includes(id)),
		amazonOnlyAccounts: state.prefs.amazonOnlyAccounts,
	};
}

const PREFS_KEY = "syncPrefs";
const SCAN_KEY = "lastScan";
const LOG_KEY = "appliedLog";

export async function loadPrefs() {
	const stored = await browser.storage.local.get([PREFS_KEY, "actualUrl"]);
	state.prefs = { ...DEFAULT_PREFS, ...(stored.actualUrl ? { actualUrl: stored.actualUrl as string } : {}), ...(stored[PREFS_KEY] as Partial<SyncPrefs>) };
	state.lookback = addDays(todayIso(), -state.prefs.lookbackDays);
}
export const savePrefs = () => browser.storage.local.set({ [PREFS_KEY]: state.prefs });

export async function loadLastScan(): Promise<ScanReport | null> {
	return ((await browser.storage.local.get(SCAN_KEY))[SCAN_KEY] as ScanReport | undefined) ?? null;
}
export const saveLastScan = (scan: ScanReport) => browser.storage.local.set({ [SCAN_KEY]: scan });

export async function readAppliedLog(): Promise<AppliedChange[]> {
	return ((await browser.storage.local.get(LOG_KEY))[LOG_KEY] as AppliedChange[] | undefined) ?? [];
}
export const writeAppliedLog = (log: AppliedChange[]) => browser.storage.local.set({ [LOG_KEY]: log });
