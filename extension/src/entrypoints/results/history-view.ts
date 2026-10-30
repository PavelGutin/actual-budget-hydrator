import { applyBatch } from "../../actual/client";
import { type AppliedChange, buildRevert } from "../../sync/batch";
import { orderNoteUrl } from "../../sync/plan";
import { verifyBudget } from "./actual-ui";
import { readAppliedLog, state, writeAppliedLog } from "./state";
import { $, errorText, h, money, plural, relativeTime, setStatus, shortDate } from "./ui";

/**
 * Splits applied from this page, newest first. Only the connected budget's entries can be reverted;
 * entries from other budgets (e.g. a test copy) are listed separately and can be forgotten.
 */

const listEl = $("history-list");
const statusEl = $("history-status");

/** Entries recorded before budget ids were stored only have a name to go by. */
function belongsToConnected(c: AppliedChange): boolean {
	if (!state.budgetId) return false;
	if (c.budgetId) return c.budgetId === state.budgetId;
	return !!c.budget && c.budget === state.budget;
}

/** Other budgets are grouped by name, so entries recorded before ids were stored land with their budget. */
const budgetKey = (c: AppliedChange) => c.budget ?? c.budgetId ?? "";
const sameEntry = (a: AppliedChange, b: AppliedChange) => a.parentId === b.parentId && a.appliedAt === b.appliedAt;

function entryTable(entries: AppliedChange[], revertable: boolean): HTMLElement {
	return h(
		"table",
		{},
		h(
			"thead",
			{},
			h("tr", {}, h("th", {}, "Transaction"), h("th", {}, "Amount"), h("th", {}, "Order"), h("th", {}, "Applied"), revertable ? h("th", {}, "") : null),
		),
		h(
			"tbody",
			{},
			...[...entries].reverse().map((change) => {
				let action: HTMLElement | null = null;
				if (revertable) {
					const revert = h("button", { type: "button" }, "Revert");
					revert.addEventListener("click", async () => {
						revert.disabled = true;
						try {
							const client = await verifyBudget();
							await applyBatch(client, buildRevert(change));
							await writeAppliedLog((await readAppliedLog()).filter((c) => !sameEntry(c, change)));
							setStatus(statusEl, `Reverted order ${change.orderNumber}.`, "ok");
							void renderHistory();
						} catch (e) {
							revert.disabled = false;
							setStatus(statusEl, `Couldn't revert: ${errorText(e)}`, "error");
						}
					});
					action = h("td", {}, revert);
				}
				return h(
					"tr",
					{},
					h("td", {}, change.txnDate ? shortDate(change.txnDate) : ""),
					h("td", {}, change.amount !== undefined ? money(change.amount) : ""),
					h("td", {}, h("a", { href: orderNoteUrl(change.orderNumber), target: "_blank", rel: "noopener" }, change.orderNumber)),
					h("td", {}, relativeTime(change.appliedAt)),
					action,
				);
			}),
		),
	);
}

export async function renderHistory() {
	const log = await readAppliedLog();
	const mine = log.filter(belongsToConnected);
	const others = new Map<string, AppliedChange[]>();
	for (const c of log) {
		if (belongsToConnected(c)) continue;
		const list = others.get(budgetKey(c)) ?? [];
		list.push(c);
		others.set(budgetKey(c), list);
	}

	const parts: HTMLElement[] = [];
	if (!state.budgetId) {
		parts.push(h("p", { className: "muted" }, "Connect to a budget in step 1 to revert its splits."));
	} else if (mine.length) {
		parts.push(h("h3", {}, `In “${state.budget ?? "this budget"}”`), entryTable(mine, true));
	} else {
		parts.push(h("p", { className: "empty" }, `Nothing applied in “${state.budget ?? "this budget"}” yet.`));
	}

	for (const entries of others.values()) {
		const name = entries[0].budget ?? "an unknown budget";
		const forget = h("button", { type: "button" }, "Forget these");
		forget.addEventListener("click", async () => {
			if (!confirm(`Remove ${plural(entries.length, "entry", "entries")} for “${name}” from this list? Nothing in Actual changes.`)) return;
			const drop = new Set(entries.map((e) => `${e.parentId}|${e.appliedAt}`));
			await writeAppliedLog((await readAppliedLog()).filter((c) => !drop.has(`${c.parentId}|${c.appliedAt}`)));
			setStatus(statusEl, `Forgot the entries for “${name}”.`, "ok");
			void renderHistory();
		});
		parts.push(
			h(
				"details",
				{ className: "more" },
				h("summary", {}, `${plural(entries.length, "split")} applied in “${name}”`),
				h("p", { className: "muted" }, "Connect to that budget to revert these, or forget them if it was a test copy."),
				entryTable(entries, false),
				h("div", { className: "actions" }, forget),
			),
		);
	}
	listEl.replaceChildren(...parts);
}

/** For the header link: entries in the connected budget, or all of them before connecting. */
export async function historyCount(): Promise<number> {
	const log = await readAppliedLog();
	return state.budgetId ? log.filter(belongsToConnected).length : log.length;
}
