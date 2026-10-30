import { ACTUAL_PORT, actualClient, type ActualClient, loadAccounts, loadTransactions, openBudget } from "../../actual/client";
import { selectCandidates, type TxnStateFilter } from "../../sync/plan";
import { planOptions, savePrefs, state } from "./state";
import { $, addDays, errorText, h, plural, setStatus, shortDate, todayIso } from "./ui";

/** Steps 1 and 2: connect to the Actual tab, then choose accounts and which transactions to consider. */

const urlInput = $<HTMLInputElement>("actual-url");
const connectBtn = $<HTMLButtonElement>("actual-connect");
const statusEl = $("actual-status");
const accountsBody = $("accounts-body");
const stateSelect = $<HTMLSelectElement>("state-filter");
const lookbackInput = $<HTMLInputElement>("lookback");
const payeeInput = $<HTMLInputElement>("payee-subs");
const summaryEl = $("candidate-summary");
const continueBtn = $<HTMLButtonElement>("to-step-2");
const chooseBtn = $<HTMLButtonElement>("to-step-3");
const connectedEl = $("connected-budget");

/** Shows which budget the steps will work on, front and center, and names it on the Continue button. */
function showBudget() {
	const name = state.budget ?? "your budget";
	if (state.budgetId && !state.connectionProblem) {
		connectedEl.replaceChildren(
			h("span", { className: "name" }, name),
			h("span", { className: "muted" }, `open in your Actual tab at ${new URL(state.prefs.actualUrl).host}`),
		);
		connectedEl.hidden = false;
		const short = name.length > 32 ? `${name.slice(0, 31)}…` : name;
		continueBtn.textContent = `Continue with ${short}`;
		continueBtn.title = `Continue with ${name}`;
	} else {
		connectedEl.hidden = true;
		continueBtn.textContent = "Continue";
		continueBtn.title = "";
	}
}

let onChange: () => void = () => {};
let onProblemChange: () => void = () => {};

/** Match patterns can't carry a port, so access is per host; tabs are then narrowed to the exact origin. */
function hostPattern(origin: string): string {
	const u = new URL(origin);
	return `${u.protocol}//${u.hostname}/*`;
}

async function injectBridge(tabId: number) {
	const tabs = browser.tabs as unknown as { executeScript?: (id: number, d: { file: string }) => Promise<unknown> };
	if (tabs.executeScript) await tabs.executeScript(tabId, { file: "/actual-bridge.js" });
	else await browser.scripting.executeScript({ target: { tabId }, files: ["/actual-bridge.js"] });
}

async function connectToTab(tabId: number): Promise<ActualClient> {
	const attempt = async (timeoutMs: number) => {
		const c = actualClient(browser.tabs.connect(tabId, { name: ACTUAL_PORT }));
		try {
			await c.ping(timeoutMs);
			return c;
		} catch (e) {
			c.close();
			throw e;
		}
	};
	try {
		return await attempt(1500);
	} catch {
		await injectBridge(tabId);
		return await attempt(25_000);
	}
}

/** Reconnects to the same tab when the page was reloaded (the bridge doesn't survive a reload). */
export async function ensureConnected(): Promise<ActualClient> {
	if (state.client) {
		try {
			await state.client.ping(1500);
			return state.client;
		} catch {
			state.client = null;
		}
	}
	const origin = new URL(state.prefs.actualUrl).origin;
	const tab = await findActualTab(origin);
	if (tab === null) throw new Error(`Open your budget at ${origin} in a tab first.`);
	state.client = await connectToTab(tab);
	return state.client;
}

async function findActualTab(origin: string): Promise<number | null> {
	const tabs = (await browser.tabs.query({ url: hostPattern(origin) })).filter((t) => t.url && new URL(t.url).origin === origin);
	return (tabs.find((t) => t.active) ?? tabs[0])?.id ?? null;
}

connectBtn.addEventListener("click", () => {
	let origin: string;
	try {
		origin = new URL(urlInput.value.trim()).origin;
	} catch {
		setStatus(statusEl, "Enter the address you open Actual at, like http://localhost:5006 or https://actual.example.com.", "error");
		return;
	}
	// Firefox only shows the prompt when the request is made right in the click handler, before any await.
	const granted = browser.permissions.request({ origins: [hostPattern(origin)] });
	void (async () => {
		try {
			if (!(await granted)) {
				setStatus(statusEl, `Access to ${origin} wasn't allowed, so the extension can't read your budget.`, "error");
				return;
			}
		} catch (e) {
			setStatus(statusEl, `Couldn't ask for access to ${origin}: ${errorText(e)}`, "error");
			return;
		}
		state.prefs.actualUrl = origin;
		void savePrefs();
		const tab = await findActualTab(origin);
		if (tab === null) {
			setStatus(statusEl, `Open your budget at ${origin} in a tab, then connect again.`, "warn");
			return;
		}
		setStatus(statusEl, "Connecting...");
		connectBtn.disabled = true;
		state.budgetId = null;
		showBudget();
		try {
			state.client?.close();
			state.client = await connectToTab(tab);
			const budget = await openBudget(state.client);
			if (!budget) {
				state.budgetId = null;
				showBudget();
				setStatus(statusEl, "Actual is open in that tab, but no budget is loaded. Open your budget there, then connect again.", "warn");
				return;
			}
			state.budget = budget.name;
			state.budgetId = budget.id;
			state.connectionProblem = null;
			onProblemChange();
			state.accounts = (await loadAccounts(state.client)).filter((a) => !a.closed);
			setStatus(statusEl, "");
			renderAccounts();
			await reloadTransactions();
		} catch (e) {
			state.client = null;
			setStatus(statusEl, `Couldn't reach Actual in that tab: ${errorText(e)}`, "error");
		} finally {
			connectBtn.disabled = false;
		}
	})();
});

function renderAccounts() {
	accountsBody.replaceChildren(
		...state.accounts.map((a) => {
			const include = h("input", { type: "checkbox", checked: !state.prefs.excludedAccounts.includes(a.id) });
			const amazon = h("input", { type: "checkbox", checked: state.prefs.amazonOnlyAccounts.includes(a.id) });
			include.setAttribute("aria-label", `Include ${a.name}`);
			amazon.setAttribute("aria-label", `Every transaction in ${a.name} is Amazon`);
			include.addEventListener("change", () => {
				state.prefs.excludedAccounts = include.checked
					? state.prefs.excludedAccounts.filter((id) => id !== a.id)
					: [...state.prefs.excludedAccounts, a.id];
				amazon.disabled = !include.checked;
				changed();
			});
			amazon.disabled = !include.checked;
			amazon.addEventListener("change", () => {
				state.prefs.amazonOnlyAccounts = amazon.checked
					? [...state.prefs.amazonOnlyAccounts, a.id]
					: state.prefs.amazonOnlyAccounts.filter((id) => id !== a.id);
				changed();
			});
			return h(
				"tr",
				{},
				h("td", {}, a.name, a.offbudget ? h("span", { className: "muted" }, " (off budget)") : null),
				h("td", {}, include),
				h("td", {}, amazon),
			);
		}),
	);
}

async function reloadTransactions() {
	if (!state.client) return;
	summaryEl.textContent = "Reading transactions...";
	try {
		state.actualTxns = (await loadTransactions(state.client, state.lookback)).txns;
		changed(false);
	} catch (e) {
		setStatus(statusEl, `Couldn't read transactions from Actual: ${errorText(e)}`, "error");
		summaryEl.textContent = "";
	}
}

function changed(persist = true) {
	if (persist) void savePrefs();
	const { candidates, skippedAlreadyDone } = selectCandidates(state.actualTxns, planOptions());
	const oldest = candidates.reduce<string | null>((m, t) => (m === null || t.date < m ? t.date : m), null);
	if (!state.client) {
		summaryEl.textContent = "";
	} else if (candidates.length === 0) {
		summaryEl.textContent = `Nothing to itemize since ${shortDate(state.lookback)}${skippedAlreadyDone ? ` (${plural(skippedAlreadyDone, "transaction")} already itemized)` : ""}.`;
	} else {
		summaryEl.textContent = `${plural(candidates.length, "transaction")} to itemize, oldest ${shortDate(oldest as string)}.`;
	}
	continueBtn.disabled = !state.budgetId || !!state.connectionProblem;
	chooseBtn.disabled = !state.budgetId || !!state.connectionProblem || candidates.length === 0;
	showBudget();
	onChange();
}

/** The oldest transaction that could be itemized, so the Amazon scan reads no further back than needed. */
export function oldestCandidateDate(): string | null {
	const { candidates } = selectCandidates(state.actualTxns, planOptions());
	return candidates.reduce<string | null>((m, t) => (m === null || t.date < m ? t.date : m), null);
}

stateSelect.addEventListener("change", () => {
	state.prefs.stateFilter = stateSelect.value as TxnStateFilter;
	changed();
});
payeeInput.addEventListener("change", () => {
	state.prefs.payeeSubstrings = payeeInput.value;
	changed();
});
lookbackInput.addEventListener("change", () => {
	if (!lookbackInput.value) return;
	state.lookback = lookbackInput.value;
	state.prefs.lookbackDays = Math.max(1, Math.round((Date.parse(todayIso()) - Date.parse(state.lookback)) / 86_400_000));
	void savePrefs();
	void reloadTransactions();
});

/**
 * Confirms the Actual tab is still there, has a budget loaded, and it's the one connected in step 1.
 * Throws a message meant for the person; records it in state.connectionProblem either way.
 */
export async function verifyBudget(): Promise<ActualClient> {
	const before = state.connectionProblem;
	try {
		if (!state.budgetId) throw new Error("Connect to your budget first.");
		let client: ActualClient;
		try {
			client = await ensureConnected();
		} catch {
			throw new Error(`The Actual tab is closed or not responding. Open your budget at ${new URL(state.prefs.actualUrl).origin} and connect again.`);
		}
		const open = await openBudget(client);
		if (!open) throw new Error("No budget is loaded in the Actual tab. Open your budget there and connect again.");
		if (open.id !== state.budgetId) {
			throw new Error(`The Actual tab now has “${open.name ?? "another budget"}” open instead of “${state.budget}”. Connect again to use it.`);
		}
		state.connectionProblem = null;
		return client;
	} catch (e) {
		state.connectionProblem = errorText(e);
		throw e;
	} finally {
		if (before !== state.connectionProblem) {
			onProblemChange();
			changed(false);
		}
	}
}

/** Re-checks every few seconds while the page is visible, so a closed tab or switched budget shows up. */
export function watchBudget(intervalMs = 5000) {
	setInterval(() => {
		if (state.budgetId && document.visibilityState === "visible") verifyBudget().catch(() => {});
	}, intervalMs);
}

export function initStep1(onCandidatesChanged: () => void, onProblem: () => void) {
	onChange = onCandidatesChanged;
	onProblemChange = onProblem;
	urlInput.value = state.prefs.actualUrl;
	stateSelect.value = state.prefs.stateFilter;
	payeeInput.value = state.prefs.payeeSubstrings;
	lookbackInput.value = state.lookback;
	lookbackInput.max = todayIso();
	lookbackInput.min = addDays(todayIso(), -730);
}

export { reloadTransactions };
