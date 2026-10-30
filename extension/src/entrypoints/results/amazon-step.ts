import { storageOrderCache } from "../../live/cache";
import { type FromContent, SCAN_PORT, type ToContent } from "../../live/messages";
import { AMAZON_ORIGIN, defaultScanOptions, type ScanReport, type ScanStats } from "../../live/scan";
import { oldestCandidateDate } from "./actual-ui";
import { loadLastScan, saveLastScan, state } from "./state";
import { $, addDays, errorText, h, plural, relativeTime, setStatus, shortDate, todayIso } from "./ui";

/** Step 3: read Amazon transactions and order details from the open amazon.com tab. */

const AMAZON_ORIGINS = [`${AMAZON_ORIGIN}/*`];
/** Amazon's charge date can precede the bank's posting date; the matcher allows 5 days. */
const LEAD_DAYS = 7;

const sinceInput = $<HTMLInputElement>("since");
const sinceNote = $("since-note");
const statusEl = $("amazon-status");
const lastScanEl = $("last-scan");
const grantBtn = $<HTMLButtonElement>("grant-amazon");
const scanBtn = $<HTMLButtonElement>("scan");
const useLastBtn = $<HTMLButtonElement>("use-last");
const progressEl = $("progress");
const progressLine = $("progress-line");
const progressFill = $("progress-fill");
const resultEl = $("scan-result");
const summaryEl = $("scan-summary");
const warningsEl = $("scan-warnings");
const detailsEl = $("scan-details");
const downloadBtn = $<HTMLButtonElement>("download");
const maxDetailsInput = $<HTMLInputElement>("max-details");
const refreshInput = $<HTMLInputElement>("refresh");
const clearCacheBtn = $<HTMLButtonElement>("clear-cache");
const cacheCountEl = $("cache-count");
const logEl = $("log");
const nextBtn = $<HTMLButtonElement>("to-step-4");

const cache = storageOrderCache(browser.storage.local);
let lastScan: ScanReport | null = null;
let running = false;

function log(line: string) {
	logEl.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
}

async function showCacheCount() {
	cacheCountEl.textContent = `${plural(await cache.count(), "order")} saved`;
}

/** Called whenever this step is shown: suggest a start date from step 2, and say if the last scan covers it. */
export async function enterScanStep() {
	const oldest = oldestCandidateDate();
	const suggested = oldest ? addDays(oldest, -LEAD_DAYS) : defaultScanOptions().sinceDate;
	if (!running && !state.scan) sinceInput.value = suggested;
	sinceNote.textContent = oldest ? `a week before your oldest transaction to itemize (${shortDate(oldest)})` : "";
	sinceInput.max = todayIso();
	lastScan ??= await loadLastScan();
	describeLastScan();
	void showCacheCount();
	await checkAmazonAccess();
}

function describeLastScan() {
	// Once a scan is in use on this page, the result speaks for itself.
	const inUse = state.scan !== null;
	const covers = !inUse && !!lastScan && lastScan.options.sinceDate <= sinceInput.value && !lastScan.stoppedEarly;
	lastScanEl.hidden = !covers;
	useLastBtn.hidden = !covers;
	if (covers && lastScan) {
		lastScanEl.textContent =
			`Your last scan, ${relativeTime(lastScan.finishedAt)}, already covers back to ${shortDate(lastScan.options.sinceDate)}. ` +
			"Anything charged after it won't be in it.";
	}
	scanBtn.textContent = covers || inUse ? "Scan again" : "Scan Amazon";
	scanBtn.classList.toggle("primary", !covers && !inUse);
	useLastBtn.classList.toggle("primary", covers);
}
sinceInput.addEventListener("change", describeLastScan);

async function findAmazonTab(): Promise<number | null> {
	const tabs = (await browser.tabs.query({ url: AMAZON_ORIGINS })).filter((t) => !t.discarded);
	// Prefer the tab the person looked at last; an old tab may predate the extension being loaded.
	tabs.sort((a, b) => Number(b.active) - Number(a.active) || ((b as { lastAccessed?: number }).lastAccessed ?? 0) - ((a as { lastAccessed?: number }).lastAccessed ?? 0));
	return tabs[0]?.id ?? null;
}

type Port = ReturnType<typeof browser.tabs.connect>;

/** Opens the scan port and waits for the content script to answer, or rejects. */
function openScanPort(tabId: number, timeoutMs: number): Promise<Port> {
	return new Promise((resolve, reject) => {
		const port = browser.tabs.connect(tabId, { name: SCAN_PORT });
		const timer = setTimeout(() => {
			port.disconnect();
			reject(new Error("no answer"));
		}, timeoutMs);
		const onMessage = (raw: unknown) => {
			if ((raw as FromContent)?.type !== "pong") return;
			clearTimeout(timer);
			port.onMessage.removeListener(onMessage);
			resolve(port);
		};
		port.onMessage.addListener(onMessage);
		port.onDisconnect.addListener(() => {
			void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime?.lastError;
			clearTimeout(timer);
			reject(new Error("no content script"));
		});
		port.postMessage({ type: "ping" } satisfies ToContent);
	});
}

/**
 * Chrome doesn't add content scripts to tabs that were already open when the extension was installed
 * or reloaded (Firefox does), so if the tab doesn't answer, inject the script and ask again.
 */
async function connectToAmazon(tabId: number): Promise<Port> {
	try {
		return await openScanPort(tabId, 1500);
	} catch {
		const tabs = browser.tabs as unknown as { executeScript?: (id: number, d: { file: string }) => Promise<unknown> };
		if (tabs.executeScript) await tabs.executeScript(tabId, { file: "/content-scripts/amazon.js" });
		else await browser.scripting.executeScript({ target: { tabId }, files: ["/content-scripts/amazon.js"] });
		return await openScanPort(tabId, 5000);
	}
}

async function checkAmazonAccess(): Promise<boolean> {
	if (!(await browser.permissions.contains({ origins: AMAZON_ORIGINS }))) {
		grantBtn.hidden = false;
		setStatus(statusEl, "The extension needs access to amazon.com to read your orders.", "warn");
		return false;
	}
	grantBtn.hidden = true;
	if ((await findAmazonTab()) === null) {
		setStatus(statusEl, "Open any amazon.com page in a tab, signed in.", "warn");
		return false;
	}
	setStatus(statusEl, "");
	return true;
}

grantBtn.addEventListener("click", () => {
	const granted = browser.permissions.request({ origins: AMAZON_ORIGINS });
	void granted.then(() => checkAmazonAccess());
});

function showStats(s: ScanStats, since: string) {
	progressEl.hidden = false;
	if (s.phase === "transactions") {
		progressLine.textContent =
			`Reading transactions: ${plural(s.transactions, "so far", "so far")}` +
			(s.oldestTransactionDate ? `, back to ${shortDate(s.oldestTransactionDate)}` : "");
		const span = Date.parse(todayIso()) - Date.parse(since);
		const done = s.oldestTransactionDate ? Date.parse(todayIso()) - Date.parse(s.oldestTransactionDate) : 0;
		progressFill.style.width = `${Math.min(100, (done / Math.max(span, 1)) * 100) * 0.3}%`;
	} else {
		progressLine.textContent =
			`Reading orders: ${s.ordersDone} of ${s.ordersTotal}` + (s.ordersFromCache ? ` (${s.ordersFromCache} saved from earlier scans)` : "");
		progressFill.style.width = `${30 + (s.ordersTotal ? (s.ordersDone / s.ordersTotal) * 70 : 70)}%`;
	}
}

scanBtn.addEventListener("click", async () => {
	if (running || !(await checkAmazonAccess())) return;
	const tabId = await findAmazonTab();
	if (tabId === null) return;
	running = true;
	scanBtn.disabled = useLastBtn.disabled = nextBtn.disabled = true;
	resultEl.hidden = true;
	const since = sinceInput.value || defaultScanOptions().sinceDate;
	showStats({ phase: "transactions", transactionPages: 0, transactions: 0, oldestTransactionDate: null, ordersTotal: 0, ordersDone: 0, ordersFromCache: 0, requests: 0 }, since);
	setStatus(statusEl, "Keep the amazon.com tab open until this finishes.");

	let port: Port;
	try {
		port = await connectToAmazon(tabId);
	} catch (e) {
		running = false;
		scanBtn.disabled = useLastBtn.disabled = false;
		progressEl.hidden = true;
		const url = (await browser.tabs.get(tabId).catch(() => null))?.url ?? "the amazon.com tab";
		setStatus(statusEl, `Couldn't start the scan in ${url}: ${errorText(e)}. Reload that tab and try again.`, "error");
		return;
	}
	let finished = false;
	const finish = () => {
		finished = true;
		running = false;
		scanBtn.disabled = useLastBtn.disabled = false;
		port.disconnect();
	};
	port.onMessage.addListener((raw) => {
		const msg = raw as FromContent;
		if (msg.type === "progress") log(msg.message);
		else if (msg.type === "stats") showStats(msg.stats, since);
		else if (msg.type === "error") {
			setStatus(statusEl, `The scan stopped: ${msg.message}`, "error");
			progressEl.hidden = true;
			finish();
		} else if (msg.type === "done") {
			finish();
			progressEl.hidden = true;
			lastScan = msg.report;
			void saveLastScan(msg.report);
			useScan(msg.report);
			describeLastScan();
			void showCacheCount();
		}
	});
	port.onDisconnect.addListener(() => {
		void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime?.lastError;
		if (finished) return;
		running = false;
		scanBtn.disabled = useLastBtn.disabled = false;
		progressEl.hidden = true;
		setStatus(statusEl, "Lost contact with the amazon.com tab partway through (was it closed or navigated away?). Scan again to pick up where it left off; finished orders are saved.", "error");
	});
	const start: ToContent = {
		type: "start",
		options: { sinceDate: since, maxOrderDetails: Number(maxDetailsInput.value) || 300, refreshCache: refreshInput.checked },
	};
	port.postMessage(start);
});

useLastBtn.addEventListener("click", () => {
	if (lastScan) useScan(lastScan);
	describeLastScan();
});

function useScan(r: ScanReport) {
	state.scan = r;
	const reconciling = r.orderDetails.filter((d) => d.reconciles).length;
	const fetched = r.orderDetails.filter((d) => !d.fromCache).length;
	summaryEl.textContent =
		`${plural(r.transactions.length, "Amazon transaction")} since ${shortDate(r.options.sinceDate)} and ${plural(r.orderDetails.length, "order")}` +
		(fetched === r.orderDetails.length ? ". " : ` (${fetched} read now, ${r.orderDetails.length - fetched} from earlier scans). `) +
		(reconciling === r.orderDetails.length ? "Every order adds up." : `${r.orderDetails.length - reconciling} orders don't add up and will need a look.`);
	warningsEl.replaceChildren(...r.warnings.map((w) => h("li", {}, w)));
	renderDetails(r);
	resultEl.hidden = false;
	setStatus(statusEl, r.stoppedEarly ? "The scan stopped early; what it read so far is below." : "", r.stoppedEarly ? "warn" : "");
	nextBtn.disabled = r.transactions.length === 0;
}

function renderDetails(r: ScanReport) {
	const off = r.orderDetails.filter((d) => !d.reconciles);
	detailsEl.replaceChildren();
	detailsEl.append(
		h(
			"p",
			{ className: "muted" },
			`${plural(r.pages.length, "request")} to Amazon, ${plural(r.transactionPages, "page")} of transactions` +
				(r.duplicateTransactionsDropped ? `, ${r.duplicateTransactionsDropped} repeated at page breaks dropped` : "") +
				`. Finished ${relativeTime(r.finishedAt)}.`,
		),
		off.length
			? h(
					"table",
					{},
					h("thead", {}, h("tr", {}, h("th", {}, "Order"), h("th", {}, "Order total"), h("th", {}, "Items and adjustments"), h("th", {}, "Why"))),
					h(
						"tbody",
						{},
						...off.map((d) =>
							h(
								"tr",
								{},
								h("td", {}, d.orderNumber),
								h("td", {}, d.order?.grandTotal?.toFixed(2) ?? "?"),
								h("td", {}, d.reconstructedTotal?.toFixed(2) ?? "?"),
								h("td", {}, d.error ?? "an adjustment on the order page isn't read yet"),
							),
						),
					),
				)
			: "",
	);
}

downloadBtn.addEventListener("click", () => {
	const r = state.scan;
	if (!r) return;
	const a = h("a", {
		href: URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" })),
		download: `amazon-scan-${r.startedAt.replace(/[:.]/g, "-")}.json`,
	});
	a.click();
	URL.revokeObjectURL(a.href);
});

clearCacheBtn.addEventListener("click", async () => {
	try {
		await cache.clear();
	} catch (e) {
		setStatus(statusEl, errorText(e), "error");
	}
	void showCacheCount();
});

export const isScanning = () => running;
