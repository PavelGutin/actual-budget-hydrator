import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { actualClient, loadTransactions, type PortLike } from "../src/actual/client";
import { type ActualWindow, installActualMain } from "../src/actual/main-world";
import { MAIN_REQUEST_EVENT, MAIN_RESPONSE_EVENT } from "../src/actual/protocol";

/** A fake Actual page: $q records the AQL chain, $query/$send answer canned data. */
function fakeActualPage() {
	const dom = new JSDOM("<html><body></body></html>");
	const w = dom.window as unknown as Record<string, unknown> & typeof dom.window;
	const calls: unknown[] = [];
	w.$q = (table: string) => {
		const q: Record<string, unknown> = { table };
		const chain = {
			filter: (f: unknown) => ((q.filter = f), chain),
			options: (o: unknown) => ((q.options = o), chain),
			select: (s: unknown) => ((q.select = s), chain),
			q,
		};
		return chain;
	};
	w.$query = async (chain: { q: unknown }) => {
		calls.push(["query", chain.q]);
		return { data: [{ id: "t1", account: "a", date: "2026-10-20", amount: -3240, notes: null, category: null, payee: "p", payee_name: "Amazon", is_parent: 0, is_child: 0, transfer_id: null, cleared: 1, reconciled: 0 }] };
	};
	w.$send = async (method: string, args: unknown) => {
		calls.push(["send", method, args]);
		if (method === "boom") throw new Error("server said no");
		return { ok: method };
	};
	return { dom, w, calls };
}

/** A port wired straight to the page's DOM events, standing in for actual-bridge's relay. */
function relayPort(doc: Document, CE: typeof CustomEvent): PortLike {
	const listeners: ((m: unknown) => void)[] = [];
	doc.addEventListener(MAIN_RESPONSE_EVENT, (e) => {
		const res = JSON.parse(String((e as CustomEvent).detail));
		for (const l of listeners) l(res);
	});
	return {
		postMessage: (msg) => doc.dispatchEvent(new CE(MAIN_REQUEST_EVENT, { detail: JSON.stringify(msg) })),
		disconnect: () => {},
		onMessage: { addListener: (cb) => listeners.push(cb) },
		onDisconnect: { addListener: () => {} },
	};
}

describe("Actual bridge (page side + client)", () => {
	it("runs an AQL query in the page and returns rows mapped for the planner", async () => {
		const { w, calls } = fakeActualPage();
		installActualMain(w as unknown as ActualWindow);
		const client = actualClient(relayPort(w.document, w.CustomEvent as unknown as typeof CustomEvent));
		const { txns, sources } = await loadTransactions(client, "2026-07-25");
		const [kind, q] = calls[0] as [string, Record<string, unknown>];
		expect([kind, q.table, q.filter, q.options]).toEqual(["query", "transactions", { date: { $gte: "2026-07-25" } }, { splits: "none" }]);
		expect(txns[0]).toEqual({ id: "t1", account: "a", date: "2026-10-20", amount: -3240, payeeName: "Amazon", notes: null, category: null, isParent: false, isChild: false, transferId: null, cleared: true });
		expect(sources.get("t1")?.cleared).toBe(true);
	});

	it("relays $send and surfaces its errors", async () => {
		const { w, calls } = fakeActualPage();
		installActualMain(w as unknown as ActualWindow);
		const client = actualClient(relayPort(w.document, w.CustomEvent as unknown as typeof CustomEvent));
		expect(await client.send("transactions-batch-update", { updated: [{ id: "x" }] })).toEqual({ ok: "transactions-batch-update" });
		expect(calls).toEqual([["send", "transactions-batch-update", { updated: [{ id: "x" }] }]]);
		let err = "";
		await client.send("boom").catch((e: Error) => (err = e.message));
		expect(err).toBe("server said no");
	});
});

describe("actualClient", () => {
	it("reports a page without Actual's API instead of hanging", async () => {
		const dom = new JSDOM("<html><body></body></html>");
		installActualMain(dom.window as unknown as ActualWindow, 300);
		const client = actualClient(relayPort(dom.window.document, dom.window.CustomEvent as unknown as typeof CustomEvent));
		let err = "";
		await client.ping(5000).catch((e: Error) => (err = e.message));
		expect(err).toContain("is a budget open");
	});

	it("times out when nothing answers, and rejects pending calls on disconnect", async () => {
		let onDisc = () => {};
		const port: PortLike = {
			postMessage: () => {},
			disconnect: () => {},
			onMessage: { addListener: () => {} },
			onDisconnect: { addListener: (cb) => (onDisc = cb) },
		};
		const c = actualClient(port);
		let e1 = "";
		await c.ping(20).catch((e: Error) => (e1 = e.message));
		expect(e1).toContain("didn't answer");
		const p = c.send("x").catch((e: Error) => e.message);
		onDisc();
		expect(await p).toContain("lost contact");
	});
});
