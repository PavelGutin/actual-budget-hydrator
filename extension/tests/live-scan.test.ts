import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { storageOrderCache } from "../src/live/cache";
import {
	cacheIsFresh,
	type FetchedPage,
	jwtExpiry,
	orderDetailsUrl,
	ordersNeedingDetails,
	type ScanOptions,
	scanAmazon,
	TRANSACTIONS_DATA_URL,
	TRANSACTIONS_URL,
} from "../src/live/scan";
import type { ParsedTransaction } from "../src/retailers/amazon/parse-transactions";

/** Synthetic pages only (made-up orders); shapes mirror live amazon.com as of 2026-10-23. */

const A = "111-0000000-0000001";
const B = "111-0000000-0000002";
const C = "111-0000000-0000003";
const G = "111-0000000-0000009"; // gift-card-only order

const card = { paymentMethodName: "Visa", paymentMethodNumber: { lastDigits: "0000" } };
const giftCard = { paymentMethodName: "Amazon Gift Card" };

interface Row {
	n: string;
	date: string; // "Oct 19, 2026"
	amount: string;
	payment?: object;
	status?: string;
}

const raw = (r: Row) => ({
	formattedAmount: r.amount,
	formattedDate: r.date,
	orderData: [{ orderDisplayString: `Order #${r.n}`, orderDetailsUrl: "/x" }],
	statementDescriptor: "AMZN Mktp US",
	statusInfo: { status: r.status ?? "Approved" },
	paymentMethodDisplayStringData: r.payment ?? card,
});

const jwt = (expSeconds: number) => `h.${btoa(JSON.stringify({ exp: expSeconds })).replace(/=+$/, "")}.s`;

const txPage = (rows: Row[], next: string | null, token = jwt(4_000_000_000)) =>
	`<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
		props: {
			pageProps: {
				token,
				request: { locale: "en_US", widgetName: "ViewTransactions" },
				state: {
					transactionResponseState: {
						hasMore: next !== null,
						lastEvaluatedPageKey: next,
						visibleTransactionResponse: { transactionList: rows.map(raw) },
					},
				},
			},
		},
	})}</script></body></html>`;

const dataPage = (rows: Row[], next: string | null) =>
	JSON.stringify({ displayResponse: { transactionsList: rows.map(raw), ...(next ? { lastEvaluatedKey: next } : {}) } });

const detailsPage = (n: string, items: [string, string][], grandTotal: string, opts: { renderNumber?: boolean } = {}) =>
	`<html><body><div id="orderDetails">
		${opts.renderNumber === false ? "" : `<div data-component="orderId"><span>${n}</span></div>`}
		${items
			.map(
				([t, p]) => `<div data-component="purchasedItems"><div class="a-fixed-left-grid">
				<div data-component="itemTitle"><a>${t}</a></div>
				<div data-component="unitPrice"><span class="a-text-price"><span class="a-offscreen">${p}</span><span>${p}</span></span></div>
			</div></div>`,
			)
			.join("")}
		<div id="od-subtotals"><div class="a-row"><div class="a-column a-span7">Grand Total:</div><div class="a-column a-span5 a-span-last">${grandTotal}</div></div></div>
	</div></body></html>`;

type Route = FetchedPage | string | ((n: number) => FetchedPage | string);

function fakeSite(get: Record<string, Route>, posts: Route[] = []) {
	const requests: string[] = [];
	const postBodies: { body: any; headers: Record<string, string> }[] = [];
	const sleeps: number[] = [];
	const cacheStore: Record<string, unknown> = {};
	const counts: Record<string, number> = {};
	const resolve = (r: Route | undefined, url: string, key: string): FetchedPage => {
		counts[key] = (counts[key] ?? 0) + 1;
		const v = typeof r === "function" ? r(counts[key]) : r;
		if (v === undefined) return { finalUrl: url, status: 404, text: "<html></html>" };
		return typeof v === "string" ? { finalUrl: url, status: 200, text: v } : v;
	};
	let postIdx = 0;
	const deps = {
		fetchPage: async (url: string) => {
			requests.push(`GET ${url}`);
			return resolve(get[url], url, url);
		},
		postJson: async (url: string, body: unknown, headers: Record<string, string>) => {
			requests.push(`POST ${url}`);
			postBodies.push({ body, headers });
			return resolve(posts[postIdx++], url, `post${postIdx}`);
		},
		parseHtml: (html: string) => new JSDOM(html, { virtualConsole: new VirtualConsole() }).window.document,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		random: () => 0.5,
		now: () => new Date("2026-10-23T12:00:00Z"),
		cache: storageOrderCache({
			get: async (k) => (k === null ? { ...cacheStore } : { [k as string]: cacheStore[k as string] }),
			set: async (items) => {
				Object.assign(cacheStore, items);
			},
			remove: async (keys) => {
				for (const k of [keys].flat()) delete cacheStore[k];
			},
		}),
	};
	return { deps, requests, postBodies, sleeps, cacheStore };
}

const OPTIONS: ScanOptions = {
	sinceDate: "2026-10-01",
	maxTransactionPages: 10,
	maxOrderDetails: 50,
	refreshCache: false,
	minDelayMs: 2000,
	maxDelayMs: 4000,
};

const healthy = () =>
	fakeSite(
		{
			[TRANSACTIONS_URL]: txPage(
				[
					{ n: A, date: "Oct 20, 2026", amount: "-$20.00" },
					{ n: G, date: "Oct 19, 2026", amount: "-$5.00", payment: giftCard },
				],
				"k1",
			),
			[orderDetailsUrl(A)]: detailsPage(A, [["Thing", "$20.00"]], "$20.00"),
			[orderDetailsUrl(B)]: detailsPage(B, [["Other", "$7.50"]], "$7.50"),
		},
		[
			// Page 2 repeats page 1's last card row at the boundary, then an in-window refund for B.
			dataPage(
				[
					{ n: G, date: "Oct 19, 2026", amount: "-$5.00", payment: giftCard },
					{ n: B, date: "Oct 05, 2026", amount: "+$7.50" },
				],
				"k2",
			),
			// Page 3 crosses sinceDate: C is in the window, the next row isn't, so paging stops.
			dataPage(
				[
					{ n: B, date: "Oct 02, 2026", amount: "-$7.50" },
					{ n: C, date: "Sep 30, 2026", amount: "-$9.00" },
				],
				"k3",
			),
		],
	);

describe("scanAmazon: transactions", () => {
	it("pages through get-transactions until a row is older than sinceDate", async () => {
		const { deps, requests } = healthy();
		const r = await scanAmazon(deps, OPTIONS);
		expect(r.stoppedEarly).toBeNull();
		expect(r.transactionPages).toBe(3);
		expect(requests.filter((x) => x.startsWith("POST"))).toHaveLength(2);
		expect(r.transactions.map((t) => `${t.orderNumber} ${t.grandTotal}`)).toEqual([
			`${A} -20`,
			`${G} -5`,
			`${B} 7.5`,
			`${B} -7.5`,
		]);
		expect(r.transactionsTruncated).toBe(false);
	});

	it("drops a row repeated across a page boundary", async () => {
		const { deps } = healthy();
		const r = await scanAmazon(deps, OPTIONS);
		expect(r.duplicateTransactionsDropped).toBe(1);
	});

	it("sends upstream's request shape: cursor in the body, token in x-amzn-upx-token", async () => {
		const { deps, postBodies } = healthy();
		await scanAmazon(deps, OPTIONS);
		expect(postBodies[0].body).toEqual({ type: "GetTransactions", locale: "en_US", exclusiveStartKey: "k1", widgetName: "ViewTransactions" });
		expect(postBodies[1].body.exclusiveStartKey).toBe("k2");
		expect(postBodies[0].headers["x-amzn-upx-token"]).toBe(jwt(4_000_000_000));
		expect(postBodies[0].headers.Accept).toBe("application/json");
	});

	it("stops at the page limit and says so", async () => {
		const { deps } = healthy();
		const r = await scanAmazon(deps, { ...OPTIONS, maxTransactionPages: 2 });
		expect(r.transactionPages).toBe(2);
		expect(r.transactionsTruncated).toBe(true);
		expect(r.warnings[0]).toContain("2-page limit");
	});

	it("refreshes an about-to-expire token from the transactions page before paging on", async () => {
		const nowSec = Date.parse("2026-10-23T12:00:00Z") / 1000;
		const { deps, requests, postBodies } = fakeSite(
			{
				[TRANSACTIONS_URL]: (n) =>
					n === 1
						? txPage([{ n: A, date: "Oct 20, 2026", amount: "-$20.00" }], "k1", jwt(nowSec + 30))
						: txPage([{ n: A, date: "Oct 20, 2026", amount: "-$20.00" }], "k1", jwt(nowSec + 1800)),
				[orderDetailsUrl(A)]: detailsPage(A, [["Thing", "$20.00"]], "$20.00"),
			},
			[dataPage([{ n: A, date: "Sep 01, 2026", amount: "-$1.00" }], null)],
		);
		await scanAmazon(deps, OPTIONS);
		expect(requests.filter((x) => x === `GET ${TRANSACTIONS_URL}`)).toHaveLength(2);
		expect(postBodies[0].headers["x-amzn-upx-token"]).toBe(jwt(nowSec + 1800));
	});

	it("stops when the data endpoint answers with a sign-in page instead of JSON", async () => {
		const { deps } = fakeSite(
			{ [TRANSACTIONS_URL]: txPage([{ n: A, date: "Oct 20, 2026", amount: "-$20.00" }], "k1") },
			[{ finalUrl: "https://www.amazon.com/ap/signin?x", status: 200, text: "<html><form name='signIn'></form></html>" }],
		);
		const r = await scanAmazon(deps, OPTIONS);
		expect(r.stoppedEarly).toBe("signIn");
		expect(r.orderDetails).toEqual([]);
	});
});

describe("scanAmazon: order details", () => {
	it("fetches each card-charged order once, skipping gift-card-only orders", async () => {
		const { deps, requests } = healthy();
		const r = await scanAmazon(deps, OPTIONS);
		expect(requests.filter((x) => x.includes("order-details"))).toEqual([`GET ${orderDetailsUrl(A)}`, `GET ${orderDetailsUrl(B)}`]);
		expect(r.orderDetails.map((d) => [d.orderNumber, d.reconciles, d.error])).toEqual([
			[A, true, null],
			[B, true, null],
		]);
	});

	it("paces every request after the first", async () => {
		const { deps, requests, sleeps } = healthy();
		await scanAmazon(deps, OPTIONS);
		expect(sleeps).toHaveLength(requests.length - 1);
		expect(new Set(sleeps)).toEqual(new Set([3000]));
	});

	it("reuses cached orders on the next scan, and refetches one whose transactions changed", async () => {
		const site = healthy();
		await scanAmazon(site.deps, OPTIONS);
		expect(Object.keys(site.cacheStore).sort()).toEqual([`order:${A}`, `order:${B}`]);

		site.requests.length = 0;
		const again = await scanAmazon(site.deps, OPTIONS);
		expect(site.requests.filter((x) => x.includes("order-details"))).toEqual([]);
		expect(again.orderDetails.every((d) => d.fromCache)).toBe(true);

		// A new refund for A appears: A is refetched, B stays cached.
		const changed = fakeSite(
			{
				[TRANSACTIONS_URL]: txPage(
					[
						{ n: A, date: "Oct 22, 2026", amount: "+$20.00" },
						{ n: A, date: "Oct 20, 2026", amount: "-$20.00" },
						{ n: B, date: "Oct 05, 2026", amount: "+$7.50" },
						{ n: B, date: "Oct 02, 2026", amount: "-$7.50" },
					],
					null,
				),
				[orderDetailsUrl(A)]: detailsPage(A, [["Thing", "$20.00"]], "$20.00"),
			},
		);
		changed.deps.cache = site.deps.cache;
		const third = await scanAmazon(changed.deps, OPTIONS);
		expect(changed.requests.filter((x) => x.includes("order-details"))).toEqual([`GET ${orderDetailsUrl(A)}`]);
		expect(third.orderDetails.find((d) => d.orderNumber === B)?.fromCache).toBe(true);
	});

	it("doesn't cache an order with a pending charge", async () => {
		const { deps, cacheStore } = fakeSite({
			[TRANSACTIONS_URL]: txPage([{ n: A, date: "Oct 20, 2026", amount: "-$20.00", status: "Pending" }], null),
			[orderDetailsUrl(A)]: detailsPage(A, [["Thing", "$20.00"]], "$20.00"),
		});
		await scanAmazon(deps, OPTIONS);
		expect(cacheStore).toEqual({});
	});

	it("uses the requested order number on a Whole Foods page that doesn't render one", async () => {
		const { deps } = fakeSite({
			[TRANSACTIONS_URL]: txPage([{ n: A, date: "Oct 20, 2026", amount: "-$20.00" }], null),
			[orderDetailsUrl(A)]: {
				finalUrl: `https://www.amazon.com/fopo/order-details?orderID=${A}`,
				status: 200,
				text: detailsPage(A, [["Bananas", "$20.00"]], "$20.00", { renderNumber: false }),
			},
		});
		const r = await scanAmazon(deps, OPTIONS);
		expect(r.orderDetails[0].order?.orderNumber).toBe(A);
		expect(r.orderDetails[0].error).toBeNull();
	});

	it("respects maxOrderDetails and reports what it skipped", async () => {
		const { deps, requests } = healthy();
		const r = await scanAmazon(deps, { ...OPTIONS, maxOrderDetails: 1 });
		expect(requests.filter((x) => x.includes("order-details"))).toHaveLength(1);
		expect(r.warnings.some((w) => w.includes("1 orders not fetched"))).toBe(true);
	});
});

describe("scanAmazon: progress", () => {
	it("reports running totals through both phases", async () => {
		const { deps } = healthy();
		const seen: string[] = [];
		await scanAmazon({ ...deps, onStats: (s) => seen.push(`${s.phase} p${s.transactionPages} t${s.transactions} o${s.ordersDone}/${s.ordersTotal}`) }, OPTIONS);
		expect(seen[0]).toBe("transactions p1 t2 o0/0");
		expect(seen).toContain("orders p3 t4 o0/2");
		expect(seen.at(-1)).toBe("done p3 t4 o2/2");
	});
});

describe("helpers", () => {
	const t = (p: Partial<ParsedTransaction>): ParsedTransaction => ({
		completedDate: "2026-10-20",
		paymentMethod: "Visa ****0000",
		paymentMethodLast4: "0000",
		grandTotal: -20,
		isRefund: false,
		orderNumber: A,
		orderDetailsLink: null,
		seller: null,
		status: "Approved",
		isPending: false,
		isGiftCard: false,
		...p,
	});

	it("ordersNeedingDetails drops gift-card-only orders but keeps split-payment ones", () => {
		const m = ordersNeedingDetails([t({ orderNumber: G, isGiftCard: true }), t({ isGiftCard: true }), t({})]);
		expect([...m.keys()]).toEqual([A]);
	});

	it("cacheIsFresh rejects pending rows and unseen rows", () => {
		const entry = { order: {} as never, transactionKeys: [], fetchedAt: "" };
		expect(cacheIsFresh(entry, [t({ isPending: true })])).toBe(false);
		expect(cacheIsFresh(entry, [t({})])).toBe(false);
	});

	it("jwtExpiry reads exp, and tolerates non-JWT tokens", () => {
		expect(jwtExpiry(jwt(123))).toBe(123);
		expect(jwtExpiry("opaque")).toBeNull();
	});
});
