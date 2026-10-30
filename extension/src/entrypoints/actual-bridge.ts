import { ACTUAL_PORT, type ActualRequest, type ActualResponse, MAIN_REQUEST_EVENT, MAIN_RESPONSE_EVENT } from "../actual/protocol";

/**
 * Injected on demand into the Actual tab (after you grant access to its address). Loads actual-main
 * into the page and relays the results page's requests to it. Isolated world: it can reach the
 * extension runtime but not Actual's window globals, hence the hop through DOM events.
 */
export default defineUnlistedScript(async () => {
	const g = globalThis as { __abhBridge?: boolean };
	if (g.__abhBridge) return;
	g.__abhBridge = true;

	if (!document.getElementById("abh-actual-main")) {
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement("script");
			script.id = "abh-actual-main";
			script.src = browser.runtime.getURL("/actual-main.js");
			script.addEventListener("load", () => resolve(), { once: true });
			script.addEventListener("error", () => reject(new Error("couldn't load actual-main.js")), { once: true });
			(document.head || document.documentElement).appendChild(script);
		});
	}

	browser.runtime.onConnect.addListener((port) => {
		if (port.name !== ACTUAL_PORT) return;
		const mine = new Set<string>();
		const onResponse = (e: Event) => {
			let res: ActualResponse;
			try {
				res = JSON.parse(String((e as CustomEvent).detail));
			} catch {
				return;
			}
			if (!mine.has(res.id)) return;
			mine.delete(res.id);
			port.postMessage(res);
		};
		document.addEventListener(MAIN_RESPONSE_EVENT, onResponse);
		port.onDisconnect.addListener(() => document.removeEventListener(MAIN_RESPONSE_EVENT, onResponse));
		port.onMessage.addListener((raw) => {
			const req = raw as ActualRequest;
			mine.add(req.id);
			document.dispatchEvent(new CustomEvent(MAIN_REQUEST_EVENT, { detail: JSON.stringify(req) }));
		});
	});
});
