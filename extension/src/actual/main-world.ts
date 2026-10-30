import { type ActualRequest, MAIN_REQUEST_EVENT, MAIN_RESPONSE_EVENT } from "./protocol";

/**
 * Answers bridge requests from inside Actual's page context, where Actual exposes its query
 * builder ($q), query runner ($query) and server API ($send) on window. Does nothing on its own.
 */
type AqlQuery = {
	filter(f: unknown): AqlQuery;
	select(s: unknown): AqlQuery;
	options(o: unknown): AqlQuery;
};
export type ActualWindow = Window & {
	$q?: (table: string) => AqlQuery;
	$query?: (q: AqlQuery) => Promise<{ data: unknown }>;
	$send?: (method: string, args?: unknown) => Promise<unknown>;
	__abhMain?: boolean;
	/** The page's own CustomEvent (a test's fake window brings its own). */
	CustomEvent: typeof CustomEvent;
};

export function installActualMain(w: ActualWindow, apiWaitMs = 20_000): void {
	if (w.__abhMain) return;
	w.__abhMain = true;
	const doc = w.document;

	const apiReady = () => !!(w.$q && w.$query && w.$send);
	async function waitForApi(): Promise<void> {
		for (let waited = 0; !apiReady() && waited < apiWaitMs; waited += 200) await new Promise((r) => setTimeout(r, 200));
		if (!apiReady()) throw new Error("Actual's API isn't available on this page -- is a budget open?");
	}

	const respond = (id: string, data: unknown, error?: string) =>
		doc.dispatchEvent(new w.CustomEvent(MAIN_RESPONSE_EVENT, { detail: JSON.stringify({ id, data, error }) }));

	doc.addEventListener(MAIN_REQUEST_EVENT, async (e) => {
		let req: ActualRequest;
		try {
			req = JSON.parse(String((e as CustomEvent).detail));
		} catch {
			return; // any script on the page can dispatch this event; ignore what isn't ours
		}
		if (!req?.id || !req.kind) return;
		try {
			await waitForApi();
			if (req.kind === "ping") return respond(req.id, { ok: true });
			if (req.kind === "query") {
				let q = w.$q!(req.table);
				if (req.filter) q = q.filter(req.filter);
				if (req.options) q = q.options(req.options);
				q = q.select(req.select ?? "*");
				return respond(req.id, (await w.$query!(q)).data);
			}
			if (req.kind === "send") return respond(req.id, await w.$send!(req.method, req.args));
		} catch (err) {
			respond(req.id, null, err instanceof Error ? err.message : String(err));
		}
	});
}
