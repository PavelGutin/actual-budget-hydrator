import { applyBatch, loadTransaction, loadTransactions } from "../../actual/client";
import type { Charge } from "../../matching/types";
import { buildApply } from "../../sync/batch";
import { alreadyProcessed, buildPlan, orderNoteUrl, type Plan, type PlanRow, type PlanStatus, resolveRow } from "../../sync/plan";
import { verifyBudget } from "./actual-ui";
import { planOptions, readAppliedLog, state, writeAppliedLog } from "./state";
import { $, errorText, h, money, plural, setStatus, shortDate } from "./ui";

/** Step 4: what each transaction would become, choose, apply. */

type Group = "ready" | "attention" | "skipped";
const GROUP: Record<PlanStatus, Group> = {
	ready: "ready",
	"single-item": "ready",
	"ambiguous-match": "attention",
	"split-failed": "attention",
	"no-match": "skipped",
	pending: "skipped",
	"no-order-details": "skipped",
};
const REASON: Partial<Record<PlanStatus, string>> = {
	"no-match": "No Amazon charge with this amount within 5 days.",
	pending: "Amazon hasn't finished charging this order yet. Try again once it settles.",
	"no-order-details": "The order's details weren't read in the scan.",
};

const statusEl = $("review-status");
const listEl = $("review-list");
const applyBtn = $<HTMLButtonElement>("apply");
const selectAll = $<HTMLInputElement>("select-all");
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".filters [data-filter]"));

let plan: Plan | null = null;
let filter: Group = "ready";
const selected = new Set<string>();
const applied = new Set<string>();

export async function enterReviewStep() {
	if (!state.scan) return;
	listEl.replaceChildren(h("p", { className: "empty" }, "Matching your transactions to Amazon orders..."));
	try {
		// Re-read Actual so edits made since step 1 count.
		const client = await verifyBudget();
		state.actualTxns = (await loadTransactions(client, state.lookback)).txns;
	} catch (e) {
		setStatus(statusEl, `Couldn't read transactions from Actual: ${errorText(e)}`, "error");
	}
	plan = buildPlan(state.actualTxns, state.scan, planOptions());
	selected.clear();
	applied.clear();
	for (const r of plan.rows) if (GROUP[r.status] === "ready") selected.add(r.txn.id);
	filter = plan.rows.some((r) => GROUP[r.status] === "ready") ? "ready" : "attention";
	setStatus(statusEl, "");
	render();
}

for (const tab of tabs) {
	tab.addEventListener("click", () => {
		filter = tab.dataset.filter as Group;
		render();
	});
}

selectAll.addEventListener("change", () => {
	if (!plan) return;
	for (const r of plan.rows) {
		if (GROUP[r.status] !== "ready" || applied.has(r.txn.id)) continue;
		if (selectAll.checked) selected.add(r.txn.id);
		else selected.delete(r.txn.id);
	}
	render();
});

function render() {
	if (!plan) return;
	const counts: Record<Group, number> = { ready: 0, attention: 0, skipped: 0 };
	for (const r of plan.rows) counts[GROUP[r.status]]++;
	for (const tab of tabs) {
		const g = tab.dataset.filter as Group;
		tab.setAttribute("aria-selected", String(g === filter));
		(tab.querySelector("span") as HTMLElement).textContent = String(counts[g]);
	}
	const rows = plan.rows
		.filter((r) => GROUP[r.status] === filter || (filter === "attention" && r.candidates.length > 0 && GROUP[r.status] === "ready"))
		.filter((r, i, all) => all.indexOf(r) === i)
		.sort((a, b) => b.txn.date.localeCompare(a.txn.date));
	listEl.replaceChildren(...(rows.length ? rows.map(rowView) : [h("p", { className: "empty" }, emptyText())]));
	const n = selected.size;
	applyBtn.disabled = n === 0 || !!state.connectionProblem;
	applyBtn.textContent = n ? `Apply ${plural(n, "split")}` : "Apply";
	selectAll.closest("label")!.hidden = filter !== "ready";
}

function emptyText(): string {
	if (filter === "ready") return "Nothing is ready to apply. Check Needs you.";
	if (filter === "attention") return "Nothing needs you.";
	return "Every candidate transaction was matched.";
}

function rowView(r: PlanRow): HTMLElement {
	const isApplied = applied.has(r.txn.id);
	const canApply = GROUP[r.status] === "ready" && !isApplied;
	const box = h("input", { type: "checkbox", checked: selected.has(r.txn.id), hidden: !canApply });
	box.setAttribute("aria-label", `Apply the split for ${r.txn.payeeName ?? "transaction"} on ${r.txn.date}`);
	box.addEventListener("change", () => {
		if (box.checked) selected.add(r.txn.id);
		else selected.delete(r.txn.id);
		render();
	});

	const body = h("div", { className: "body" });
	if (isApplied) body.append(h("span", { className: "tag ok" }, "Applied"));
	if (r.candidates.length) body.append(picker(r));
	if (r.splits.length) body.append(receipt(r));
	if (GROUP[r.status] !== "ready") {
		body.append(h("p", { className: "reason" }, REASON[r.status] ?? r.detail ?? ""));
	}
	const failed = failures.get(r.txn.id);
	if (failed) body.append(h("p", { className: "tag err" }, `Not applied: ${failed}`));

	return h(
		"div",
		{ className: "txn", dataset: isApplied ? { applied: "" } : {} },
		h("div", { className: "box" }, box),
		h("div", { className: "when" }, shortDate(r.txn.date)),
		h(
			"div",
			{ className: "who" },
			r.txn.payeeName ?? "No payee",
			r.order?.orderNumber
				? h("small", {}, h("a", { href: orderNoteUrl(r.order.orderNumber), target: "_blank", rel: "noopener" }, `Order ${r.order.orderNumber}`))
				: null,
		),
		h("div", { className: "amt" }, money(r.txn.amount)),
		body,
	);
}

/** The split as a receipt: each item, a dotted leader, its share; the total is the bank amount. */
function receipt(r: PlanRow): HTMLElement {
	const qty = new Map((r.order?.items ?? []).map((i) => [i.title, i.quantity]));
	return h(
		"ul",
		{ className: "receipt" },
		...r.splits.map((s) => {
			const q = qty.get(s.title);
			return h(
				"li",
				{},
				h("span", { className: "item", title: s.title }, s.title),
				q && q > 1 ? h("span", { className: "qty" }, `× ${q}`) : null,
				h("span", { className: "lead" }),
				h("span", { className: "cents" }, money(s.amountCents)),
			);
		}),
		r.splits.length > 1 || r.usedRefundBreakdown
			? h(
					"li",
					{ className: "total" },
					h("span", {}, r.usedRefundBreakdown ? "Total, from the order's refund breakdown" : "Total, tax and shipping spread across items"),
					h("span", { className: "lead" }),
					h("span", { className: "cents" }, money(r.txn.amount)),
				)
			: null,
	);
}

const chargeKey = (c: Charge) => `${c.orderNumber}|${c.completedDate}|${c.grandTotal}`;

/** Several Amazon charges fit equally: the person says which order this was. */
function picker(r: PlanRow): HTMLElement {
	const select = h("select", {});
	select.setAttribute("aria-label", "Which order was this?");
	select.append(h("option", { value: "" }, "Which order was this?"));
	const taken = new Set((plan?.rows ?? []).filter((o) => o !== r && o.charge && o.candidates.length).map((o) => chargeKey(o.charge as Charge)));
	r.candidates.forEach((c, i) => {
		const first = c.orderNumber ? plan?.orders.get(c.orderNumber)?.items[0]?.title : null;
		const isTaken = taken.has(chargeKey(c));
		select.append(
			h(
				"option",
				{ value: String(i), disabled: isTaken, selected: !!r.charge && chargeKey(r.charge) === chargeKey(c) },
				`${shortDate(c.completedDate)}: ${first ? first.slice(0, 70) : c.orderNumber ?? "order"}${isTaken ? " (chosen for another)" : ""}`,
			),
		);
	});
	select.addEventListener("change", () => {
		if (!plan || select.value === "") return;
		const charge = r.candidates[Number(select.value)];
		const events = new Map(plan.refundEvents);
		if (charge.isRefund && charge.orderNumber) events.set(charge.orderNumber, (events.get(charge.orderNumber) ?? 0) + 1);
		const next = { ...resolveRow(r.txn, charge, plan.orders, events), candidates: r.candidates };
		plan.rows[plan.rows.indexOf(r)] = next;
		if (GROUP[next.status] === "ready") selected.add(r.txn.id);
		render();
	});
	return h("div", {}, select);
}

const failures = new Map<string, string>();

applyBtn.addEventListener("click", async () => {
	if (!plan) return;
	const rows = plan.rows.filter((r) => selected.has(r.txn.id));
	if (!rows.length) return;
	try {
		await verifyBudget();
	} catch (e) {
		setStatus(statusEl, errorText(e), "error");
		return;
	}
	if (!confirm(`Apply ${plural(rows.length, "split")} in “${state.budget ?? "your budget"}”? Each can be undone from History.`)) return;
	applyBtn.disabled = true;
	failures.clear();
	let ok = 0;
	try {
		const client = await verifyBudget();
		for (const r of rows) {
			setStatus(statusEl, `Applying ${ok + failures.size + 1} of ${rows.length}...`);
			try {
				// Re-read right before writing: if it changed since matching, don't touch it.
				const fresh = await loadTransaction(client, r.txn.id);
				if (!fresh) throw new Error("the transaction no longer exists");
				if (alreadyProcessed(fresh.txn)) throw new Error("it was itemized since this list was made");
				const { batch, change } = buildApply(r, fresh.source, () => crypto.randomUUID());
				await applyBatch(client, batch);
				await writeAppliedLog([...(await readAppliedLog()), { ...change, budget: state.budget, budgetId: state.budgetId }]);
				applied.add(r.txn.id);
				selected.delete(r.txn.id);
				ok++;
			} catch (e) {
				failures.set(r.txn.id, errorText(e));
			}
		}
		setStatus(
			statusEl,
			failures.size ? `Applied ${ok} of ${rows.length}. The rest are marked below.` : `Applied ${plural(ok, "split")}.`,
			failures.size ? "warn" : "ok",
		);
	} catch (e) {
		setStatus(statusEl, `Couldn't reach Actual: ${errorText(e)}`, "error");
	}
	render();
});

/** Re-evaluates Apply when the budget check changes. */
export function refreshApplyButton() {
	if (plan) render();
}
