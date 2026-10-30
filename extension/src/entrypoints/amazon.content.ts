import { storageOrderCache } from "../live/cache";
import { type FromContent, SCAN_PORT, type ToContent } from "../live/messages";
import { defaultScanOptions, type FetchedPage, scanAmazon } from "../live/scan";

/**
 * Runs inside an amazon.com tab so every request is same-origin and rides the user's existing
 * session. Read-only: GETs pages the user could open, plus the same get-transactions POST the
 * transactions page itself makes when scrolled. Firefox's `content.fetch` issues requests as the
 * page; Chrome's content-script fetch already does.
 */
export default defineContentScript({
	matches: ["https://www.amazon.com/*"],
	main() {
		const pageWindow = (globalThis as { content?: Window }).content;
		const pageFetch: typeof fetch = pageWindow?.fetch ? pageWindow.fetch.bind(pageWindow) : fetch;

		async function toPage(res: Response): Promise<FetchedPage> {
			return { finalUrl: res.url, status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
		}

		const deps = {
			fetchPage: async (url: string) => toPage(await pageFetch(url, { credentials: "include" })),
			postJson: async (url: string, body: unknown, headers: Record<string, string>) =>
				toPage(await pageFetch(url, { method: "POST", credentials: "include", headers, body: JSON.stringify(body) })),
			parseHtml: (html: string) => new DOMParser().parseFromString(html, "text/html"),
			sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
			cache: storageOrderCache(browser.storage.local),
		};

		let running = false;
		browser.runtime.onConnect.addListener((port) => {
			if (port.name !== SCAN_PORT) return;
			const send = (msg: FromContent) => port.postMessage(msg);

			port.onMessage.addListener(async (raw) => {
				const msg = raw as ToContent;
				if (msg?.type === "ping") {
					send({ type: "pong" });
					return;
				}
				if (msg?.type !== "start") return;
				if (running) {
					send({ type: "error", message: "A scan is already running in this tab." });
					return;
				}
				running = true;
				try {
					const report = await scanAmazon(
						{
							...deps,
							onProgress: (message) => send({ type: "progress", message }),
							onStats: (stats) => send({ type: "stats", stats }),
						},
						{ ...defaultScanOptions(), ...msg.options },
					);
					send({ type: "done", report });
				} catch (e) {
					send({ type: "error", message: e instanceof Error ? e.message : String(e) });
				} finally {
					running = false;
				}
			});
		});
	},
});
