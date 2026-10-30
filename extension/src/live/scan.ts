import { type ParsedOrder, isWholeFoodsDetailsUrl, parseOrderDetails } from "../retailers/amazon/parse-order-details";
import {
	type NextPageCursor,
	type ParsedTransaction,
	parseTransactionsDataResponse,
	parseTransactionsNextData,
} from "../retailers/amazon/parse-transactions";
import { computeItemSplits } from "../splitting/compute-item-splits";

/**
 * One read-only pull of the user's Amazon data from inside their signed-in browser:
 *   1. every transaction back to `sinceDate`, paging through the get-transactions endpoint,
 *   2. the details page of every order those transactions belong to, skipping ones cached from a
 *      previous scan whose transactions haven't changed since.
 * Requests are sequential with a randomized human-paced delay; any sign-in, CAPTCHA or HTTP error
 * page ends the scan without retrying. Network, parsing, time, sleeping and the cache are injected.
 */

export const AMAZON_ORIGIN = "https://www.amazon.com";
export const TRANSACTIONS_URL = `${AMAZON_ORIGIN}/cpe/yourpayments/transactions`;
export const TRANSACTIONS_DATA_URL = `${AMAZON_ORIGIN}/payments-portal/data/iris/live/v1/data/manage/get-transactions`;
export const orderDetailsUrl = (orderNumber: string) =>
	`${AMAZON_ORIGIN}/your-orders/order-details?orderID=${encodeURIComponent(orderNumber)}`;

export interface FetchedPage {
	/** URL after redirects -- a bounce to /ap/signin shows up here. */
	finalUrl: string;
	status: number;
	contentType?: string;
	text: string;
}

export interface CachedOrder {
	order: ParsedOrder;
	/** transactionKey()s of the order's transactions when it was fetched. */
	transactionKeys: string[];
	fetchedAt: string;
}

export interface OrderCache {
	get(orderNumber: string): Promise<CachedOrder | null>;
	set(orderNumber: string, entry: CachedOrder): Promise<void>;
}

export interface ScanDeps {
	fetchPage: (url: string) => Promise<FetchedPage>;
	postJson: (url: string, body: unknown, headers: Record<string, string>) => Promise<FetchedPage>;
	parseHtml: (html: string) => Document;
	sleep: (ms: number) => Promise<void>;
	now?: () => Date;
	random?: () => number;
	cache?: OrderCache;
	onProgress?: (message: string) => void;
	onStats?: (stats: ScanStats) => void;
}

/** Running totals for a progress display. */
export interface ScanStats {
	phase: "transactions" | "orders" | "done";
	transactionPages: number;
	transactions: number;
	oldestTransactionDate: string | null;
	ordersTotal: number;
	ordersDone: number;
	ordersFromCache: number;
	requests: number;
}

export interface ScanOptions {
	/** ISO date; transactions older than this end the pagination. */
	sinceDate: string;
	/** Safety stop for transaction pages (20 per page). */
	maxTransactionPages: number;
	/** Safety stop for order-detail page fetches (cache hits don't count). */
	maxOrderDetails: number;
	/** Ignore cached order details and refetch everything. */
	refreshCache: boolean;
	minDelayMs: number;
	maxDelayMs: number;
}

export function defaultScanOptions(now = new Date()): ScanOptions {
	const since = new Date(now.getTime() - 90 * 86_400_000);
	return {
		sinceDate: since.toISOString().slice(0, 10),
		maxTransactionPages: 60,
		maxOrderDetails: 300,
		refreshCache: false,
		minDelayMs: 2500,
		maxDelayMs: 5000,
	};
}

export type PageKind = "transactions" | "transactionsData" | "orderDetails";
export type BlockReason = "signIn" | "captcha" | "httpError" | "unexpectedResponse";

export interface PageLog {
	kind: PageKind;
	url: string;
	finalUrl: string;
	status: number;
	blocked: BlockReason | null;
}

export interface OrderDetailsResult {
	orderNumber: string;
	order: ParsedOrder | null;
	fromCache: boolean;
	/** Items x quantity x price + parsed adjustments. Differs from grandTotal => a row we don't parse. */
	reconstructedTotal: number | null;
	reconciles: boolean;
	error: string | null;
}

export interface ScanReport {
	startedAt: string;
	finishedAt: string;
	options: ScanOptions;
	stoppedEarly: BlockReason | null;
	pages: PageLog[];
	transactions: ParsedTransaction[];
	transactionPages: number;
	/** True if pagination stopped before reaching sinceDate (page cap or end of history). */
	transactionsTruncated: boolean;
	duplicateTransactionsDropped: number;
	orderDetails: OrderDetailsResult[];
	warnings: string[];
}

export class ScanBlockedError extends Error {
	readonly reason: BlockReason;
	readonly page: PageLog;

	constructor(reason: BlockReason, page: PageLog) {
		super(`Amazon returned a ${reason} response for ${page.url}`);
		this.reason = reason;
		this.page = page;
	}
}

/** Sign-in bounce, CAPTCHA/robot check, or HTTP error. */
export function detectBlock(doc: Document | null, page: FetchedPage): BlockReason | null {
	if (page.status >= 400) return "httpError";
	if (/\/ap\/(signin|mfa|cvf)/.test(page.finalUrl)) return "signIn";
	if (!doc) return null;
	if (doc.querySelector("form[name='signIn'], form#ap_login_form, input#ap_email")) return "signIn";
	if (doc.querySelector("form[action*='validateCaptcha'], [id^='captchacharacters'], #aa-challenge-page-captcha-container")) {
		return "captcha";
	}
	if (/robot check/i.test(doc.title)) return "captcha";
	return null;
}

/** Identity of a transaction row, for page-boundary dedupe and cache invalidation. */
export function transactionKey(t: ParsedTransaction): string {
	return [t.completedDate, t.grandTotal?.toFixed(2), t.orderNumber, t.isRefund, t.paymentMethodLast4, t.status].join("|");
}

/** Like the Python CLI's _dedupe_charges, minus status: the same row repeated across a page boundary. */
function boundaryKey(t: ParsedTransaction): string {
	return [t.completedDate, t.grandTotal?.toFixed(2), t.orderNumber, t.isRefund, t.paymentMethodLast4].join("|");
}

/** Seconds-since-epoch `exp` of a JWT, or null if it isn't one. */
export function jwtExpiry(token: unknown): number | null {
	if (typeof token !== "string") return null;
	const payload = token.split(".")[1];
	if (!payload) return null;
	try {
		const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		return typeof json.exp === "number" ? json.exp : null;
	} catch {
		return null;
	}
}

const ADJUSTMENT_FIELDS = [
	"shippingTotal",
	"estimatedTax",
	"giftWrap",
	"freeShipping",
	"promotionApplied",
	"couponSavings",
	"subscriptionDiscount",
	"multibuyDiscount",
	"amazonDiscount",
	"rewardPoints",
	"giftCard",
] as const satisfies readonly (keyof ParsedOrder)[];

export function reconstructTotal(order: ParsedOrder): number | null {
	if (order.items.length === 0 || order.items.some((i) => i.price === null)) return null;
	let cents = 0;
	for (const item of order.items) cents += Math.round((item.price as number) * 100) * (item.quantity ?? 1);
	for (const field of ADJUSTMENT_FIELDS) cents += Math.round((order[field] ?? 0) * 100);
	return cents / 100;
}

function checkOrder(orderNumber: string, order: ParsedOrder | null, fromCache: boolean): OrderDetailsResult {
	if (!order) {
		return { orderNumber, order, fromCache, reconstructedTotal: null, reconciles: false, error: "no order-details container on the page" };
	}
	const reconstructedTotal = reconstructTotal(order);
	const reconciles =
		reconstructedTotal !== null && order.grandTotal !== null && Math.abs(reconstructedTotal - order.grandTotal) < 0.015;
	let error: string | null = null;
	if (order.cancelled) error = "cancelled";
	else if (order.grandTotal === null) error = "no grand total parsed";
	else if (order.orderNumber !== orderNumber) error = `page parsed as order ${order.orderNumber ?? "null"}`;
	else {
		try {
			computeItemSplits(order, -Math.round(order.grandTotal * 100));
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
	return { orderNumber, order, fromCache, reconstructedTotal, reconciles, error };
}

/** Orders whose transactions touch a bank/card (gift-card-only orders never show up in Actual). */
export function ordersNeedingDetails(transactions: ParsedTransaction[]): Map<string, ParsedTransaction[]> {
	const byOrder = new Map<string, ParsedTransaction[]>();
	for (const t of transactions) {
		if (!t.orderNumber) continue;
		const list = byOrder.get(t.orderNumber) ?? [];
		list.push(t);
		byOrder.set(t.orderNumber, list);
	}
	for (const [n, list] of byOrder) if (list.every((t) => t.isGiftCard)) byOrder.delete(n);
	return byOrder;
}

/** A cached order is reusable when nothing about its transactions is new or still pending. */
export function cacheIsFresh(entry: CachedOrder, current: ParsedTransaction[]): boolean {
	if (current.some((t) => t.isPending)) return false;
	const known = new Set(entry.transactionKeys);
	return current.every((t) => known.has(transactionKey(t)));
}

export async function scanAmazon(deps: ScanDeps, options: ScanOptions): Promise<ScanReport> {
	const now = deps.now ?? (() => new Date());
	const random = deps.random ?? Math.random;
	const progress = deps.onProgress ?? (() => {});
	const report: ScanReport = {
		startedAt: now().toISOString(),
		finishedAt: "",
		options,
		stoppedEarly: null,
		pages: [],
		transactions: [],
		transactionPages: 0,
		transactionsTruncated: false,
		duplicateTransactionsDropped: 0,
		orderDetails: [],
		warnings: [],
	};

	const stats: ScanStats = {
		phase: "transactions",
		transactionPages: 0,
		transactions: 0,
		oldestTransactionDate: null,
		ordersTotal: 0,
		ordersDone: 0,
		ordersFromCache: 0,
		requests: 0,
	};
	const emit = () => deps.onStats?.({ ...stats, requests: report.pages.length });
	const notePage = (rows: ParsedTransaction[]) => {
		stats.transactionPages++;
		stats.transactions += rows.length;
		const last = rows.at(-1)?.completedDate;
		if (last) stats.oldestTransactionDate = last;
		emit();
	};

	let first = true;
	async function pace() {
		if (!first) {
			const span = Math.max(0, options.maxDelayMs - options.minDelayMs);
			await deps.sleep(options.minDelayMs + Math.round(random() * span));
		}
		first = false;
	}

	async function loadHtml(kind: PageKind, url: string): Promise<{ doc: Document; page: FetchedPage }> {
		await pace();
		progress(`GET ${url}`);
		const page = await deps.fetchPage(url);
		const doc = deps.parseHtml(page.text);
		const blocked = detectBlock(doc, page);
		const log: PageLog = { kind, url, finalUrl: page.finalUrl, status: page.status, blocked };
		report.pages.push(log);
		if (blocked) throw new ScanBlockedError(blocked, log);
		return { doc, page };
	}

	async function loadTransactionsData(cursor: NextPageCursor): Promise<unknown> {
		await pace();
		progress(`POST transactions page ${report.transactionPages + 1}`);
		const page = await deps.postJson(
			TRANSACTIONS_DATA_URL,
			{ type: "GetTransactions", locale: cursor.locale, exclusiveStartKey: cursor.exclusiveStartKey, widgetName: cursor.widgetName },
			{ Accept: "application/json", "Content-Type": "application/json", "x-amzn-upx-token": String(cursor.token) },
		);
		const log: PageLog = { kind: "transactionsData", url: TRANSACTIONS_DATA_URL, finalUrl: page.finalUrl, status: page.status, blocked: null };
		report.pages.push(log);
		let body: unknown = null;
		try {
			body = JSON.parse(page.text);
		} catch {
			// An HTML body here means a sign-in/CAPTCHA interstitial.
			log.blocked = detectBlock(deps.parseHtml(page.text), page) ?? "unexpectedResponse";
		}
		log.blocked = log.blocked ?? detectBlock(null, page);
		if (log.blocked) throw new ScanBlockedError(log.blocked, log);
		return body;
	}

	const inWindow = (t: ParsedTransaction) => t.completedDate !== null && t.completedDate >= options.sinceDate;

	try {
		// 1. Transactions back to sinceDate.
		const { doc: txDoc } = await loadHtml("transactions", TRANSACTIONS_URL);
		if (!txDoc.querySelector("script#__NEXT_DATA__")) {
			report.warnings.push("Transactions: legacy (non-Next.js) page variant -- not supported.");
		} else {
			const pages: ParsedTransaction[][] = [];
			const firstPage = parseTransactionsNextData(txDoc);
			pages.push(firstPage.transactions);
			report.transactionPages = 1;
			notePage(firstPage.transactions);
			let cursor = firstPage.nextPageData;
			let reachedSince = firstPage.transactions.some((t) => !inWindow(t));

			while (cursor && !reachedSince) {
				if (report.transactionPages >= options.maxTransactionPages) {
					report.transactionsTruncated = true;
					report.warnings.push(`Transactions: stopped at the ${options.maxTransactionPages}-page limit before reaching ${options.sinceDate}.`);
					break;
				}
				const exp = jwtExpiry(cursor.token);
				if (exp !== null && exp * 1000 - now().getTime() < 120_000) {
					progress("Refreshing the transactions token");
					const fresh = parseTransactionsNextData((await loadHtml("transactions", TRANSACTIONS_URL)).doc).nextPageData;
					if (fresh?.token) cursor = { ...cursor, token: fresh.token };
				}
				const page = parseTransactionsDataResponse(await loadTransactionsData(cursor));
				pages.push(page.transactions);
				report.transactionPages++;
				notePage(page.transactions);
				reachedSince = page.transactions.some((t) => !inWindow(t));
				cursor = page.lastEvaluatedKey ? { ...cursor, exclusiveStartKey: page.lastEvaluatedKey } : null;
			}

			// Collapse a row repeated across a page boundary; repeats within one page are real.
			const seenOnEarlierPages = new Set<string>();
			for (const page of pages) {
				const keysThisPage = new Set<string>();
				for (const t of page) {
					const key = boundaryKey(t);
					if (seenOnEarlierPages.has(key)) {
						report.duplicateTransactionsDropped++;
						continue;
					}
					keysThisPage.add(key);
					report.transactions.push(t);
				}
				for (const k of keysThisPage) seenOnEarlierPages.add(k);
			}
			// Upstream stops at the first row older than the window; rows are newest-first.
			const firstOld = report.transactions.findIndex((t) => !inWindow(t));
			if (firstOld >= 0) report.transactions = report.transactions.slice(0, firstOld);
		}

		// 2. Order details for every order with a card/bank transaction in the window.
		const byOrder = ordersNeedingDetails(report.transactions);
		let fetched = 0;
		stats.phase = "orders";
		stats.transactions = report.transactions.length;
		stats.ordersTotal = byOrder.size;
		emit();
		for (const [orderNumber, txns] of byOrder) {
			const cached = options.refreshCache ? null : await deps.cache?.get(orderNumber);
			if (cached && cacheIsFresh(cached, txns)) {
				report.orderDetails.push(checkOrder(orderNumber, cached.order, true));
				stats.ordersDone++;
				stats.ordersFromCache++;
				emit();
				continue;
			}
			if (fetched >= options.maxOrderDetails) {
				report.warnings.push(`Order details: stopped at the ${options.maxOrderDetails}-page limit; ${byOrder.size - report.orderDetails.length} orders not fetched.`);
				break;
			}
			fetched++;
			const { doc, page } = await loadHtml("orderDetails", orderDetailsUrl(orderNumber));
			// Whole Foods orders redirect to their own page, which doesn't always render the order number.
			const order = parseOrderDetails(doc, isWholeFoodsDetailsUrl(page.finalUrl) ? orderNumber : null);
			const result = checkOrder(orderNumber, order, false);
			report.orderDetails.push(result);
			stats.ordersDone++;
			emit();
			if (order && deps.cache && !txns.some((t) => t.isPending)) {
				await deps.cache.set(orderNumber, {
					order,
					transactionKeys: txns.map(transactionKey),
					fetchedAt: now().toISOString(),
				});
			}
		}
	} catch (e) {
		if (!(e instanceof ScanBlockedError)) throw e;
		report.stoppedEarly = e.reason;
		report.warnings.push(`Stopped: ${e.message}. Nothing was retried.`);
	}

	report.finishedAt = now().toISOString();
	stats.phase = "done";
	emit();
	progress("Done.");
	return report;
}
