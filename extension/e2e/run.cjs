// End-to-end test of the built Chrome (MV3) extension in Chromium: `npm run build:chrome && npm run e2e`.
// Amazon and Actual are both faked with request routing (upstream amazon-orders fixtures + fake-actual.html),
// so nothing leaves the machine. Needs `npm i -D playwright && npx playwright install chromium` once.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");
const FIX = path.join(ROOT, "tests/fixtures/amazon-orders");
const SHOTS = path.join(HERE, ".shots");
fs.mkdirSync(SHOTS, { recursive: true });

// A copy of the build whose manifest also grants http://localhost, standing in for the person
// clicking "Allow" on the permission prompt (which a headless browser can't show).
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), "abh-ext-"));
fs.cpSync(path.join(ROOT, ".output/chrome-mv3"), EXT, { recursive: true });
const manifestPath = path.join(EXT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.host_permissions.push("http://localhost/*");
fs.writeFileSync(manifestPath, JSON.stringify(manifest));

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: !!ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};

// ---- Amazon fixtures -------------------------------------------------------
const ORDERS = {
	"111-6778632-7354601": "order-details-111-6778632-7354601.html", // 4 items, 60.88
	"112-9685975-5907428": "order-details-112-9685975-5907428.html", // 2 items, 46.61
	"113-1625648-3437067": "order-details-113-1625648-3437067.html", // 2 items, 28.80
	"112-5234348-8033063": "order-details-112-5234348-8033063.html", // 1 item x3, 54.78
	"112-5939971-8962610": "order-details-112-5939971-8962610.html", // 1 item x2, 28.50
	"114-8722141-6545058": "order-details-114-8722141-6545058.html", // 1 item, 44.46
};
const txn = (date, amount, order, last4 = "1234", status = "Approved") => ({
	formattedAmount: `-$${amount.toFixed(2)}`,
	formattedDate: date,
	orderData: [{ orderDisplayString: `Order #${order}`, orderDetailsUrl: `https://www.amazon.com/gp/css/summary/edit.html?orderID=${order}` }],
	statementDescriptor: "AMZN Mktp US",
	statusInfo: { status, label: "Charged", amountDetailsStatusType: "Charge" },
	paymentMethodDisplayStringData: { paymentMethodName: "Visa Card", paymentMethodNumber: { prefix: "••••", lastDigits: last4 } },
});
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64u({ alg: "none" })}.${b64u({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const page1 = [
	txn("Oct 20, 2026", 60.88, "111-6778632-7354601"),
	txn("Oct 18, 2026", 46.61, "112-9685975-5907428"),
	txn("Oct 15, 2026", 28.8, "113-1625648-3437067"),
	txn("Oct 12, 2026", 54.78, "112-5234348-8033063"),
];
// page 1 and page 2 share a boundary row, which must be dropped once.
const page2 = [txn("Oct 12, 2026", 54.78, "112-5234348-8033063"), txn("Oct 9, 2026", 28.5, "112-5939971-8962610")];
const page3 = [txn("Oct 6, 2026", 44.46, "114-8722141-6545058"), txn("Aug 1, 2026", 19.99, "999-0000000-0000000")];

const transactionsHtml = `<!doctype html><html><head><title>Your Transactions</title></head><body>
<h1>Your transactions</h1>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
	props: {
		pageProps: {
			token: TOKEN,
			request: { locale: "en-US", widgetName: "YourTransactions" },
			state: { transactionResponseState: { hasMore: true, lastEvaluatedPageKey: "cursor-1", visibleTransactionResponse: { transactionList: page1 } } },
		},
	},
})}</script></body></html>`;

const postBodies = [];
const amazonRequests = [];

async function routeAmazon(route) {
	const req = route.request();
	const url = new URL(req.url());
	amazonRequests.push(`${req.method()} ${url.pathname}${url.search}`);
	const html = (body, status = 200) => route.fulfill({ status, contentType: "text/html; charset=utf-8", body });
	if (url.pathname === "/" || url.pathname === "/gp/homepage") return html("<!doctype html><title>Amazon.com</title><h1>Amazon (fake)</h1>");
	if (url.pathname === "/cpe/yourpayments/transactions") return html(transactionsHtml);
	if (url.pathname === "/payments-portal/data/iris/live/v1/data/manage/get-transactions") {
		const body = JSON.parse(req.postData() || "{}");
		postBodies.push({ body, token: req.headers()["x-amzn-upx-token"] });
		const pages = { "cursor-1": [page2, "cursor-2"], "cursor-2": [page3, null] };
		const [list, next] = pages[body.exclusiveStartKey] ?? [[], null];
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ type: "GetTransactions", responseCode: "success", displayResponse: { transactionsList: list, ...(next ? { lastEvaluatedKey: next } : {}) } }),
		});
	}
	if (url.pathname === "/your-orders/order-details") {
		const file = ORDERS[url.searchParams.get("orderID")];
		if (file) return html(fs.readFileSync(path.join(FIX, file), "utf8"));
		return html("<!doctype html><title>Not found</title>", 404);
	}
	return html("<!doctype html><title>404</title>", 404);
}

const fakeActual = fs.readFileSync(path.join(HERE, "fake-actual.html"), "utf8");

(async () => {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "abh-profile-"));
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: "chromium",
		headless: true,
		viewport: { width: 1200, height: 900 },
		args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
	});
	const errors = [];
	context.on("weberror", (e) => errors.push(`weberror: ${e.error().message}`));
	await context.route("https://www.amazon.com/**", routeAmazon);
	await context.route("http://localhost:5006/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: fakeActual }));

	let [sw] = context.serviceWorkers();
	if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
	const extId = new URL(sw.url()).host;
	check("extension loads, service worker starts", !!extId, extId);

	const actual = await context.newPage();
	await actual.goto("http://localhost:5006/budget");
	const amazon = await context.newPage();
	await amazon.goto("https://www.amazon.com/");

	// Toolbar click -> background opens results.html. Can't click the toolbar headless, so open the page directly.
	const ui = await context.newPage();
	ui.on("dialog", (d) => d.accept());
	ui.on("console", (m) => { if (m.type() === "error") errors.push(`results console: ${m.text()}`); });
	ui.on("pageerror", (e) => errors.push(`results pageerror: ${e.message}`));
	await ui.goto(`chrome-extension://${extId}/results.html`);
	await ui.bringToFront();

	// ---- Step 1: connect
	await ui.fill("#actual-url", "http://localhost:5006");
	await ui.click("#actual-connect");
	await ui.waitForSelector("#connected-budget:not([hidden])", { timeout: 30000 }).catch(() => {});
	const connected = await ui.textContent("#connected-budget").catch(() => "");
	check("step 1: connects via scripting.executeScript bridge and reads budget name", /Household 2026/.test(connected || ""), (connected || (await ui.textContent("#actual-status"))).trim());
	const cont = (await ui.textContent("#to-step-2")).trim();
	check("step 1: button reads 'Continue with Household 2026'", cont === "Continue with Household 2026", cont);
	await ui.screenshot({ path: `${SHOTS}/1-connect.png`, fullPage: true });

	// ---- Step 2: accounts and filter
	await ui.click("#to-step-2");
	const accountNames = await ui.$$eval("#accounts-body tr td:first-child", (tds) => tds.map((t) => t.textContent.trim()));
	check("step 2: lists open accounts only", JSON.stringify(accountNames) === JSON.stringify(["Chase Amazon Visa", "Checking"]), accountNames.join(", "));
	const before = (await ui.textContent("#candidate-summary")).trim();
	await ui.check('[aria-label="Every transaction in Chase Amazon Visa is Amazon"]');
	await ui.waitForTimeout(300);
	const after = (await ui.textContent("#candidate-summary")).trim();
	check("step 2: 'all Amazon' account adds the payee-less transaction", /^5 /.test(before) && /^6 /.test(after), `${before} -> ${after}`);
	await ui.screenshot({ path: `${SHOTS}/2-choose.png`, fullPage: true });

	// ---- Step 3: scan
	await ui.click("#to-step-3");
	const since = await ui.inputValue("#since");
	check("step 3: scan start = oldest candidate minus 7 days", since === "2026-09-30", since);
	const grantVisible = await ui.isVisible("#grant-amazon");
	check("step 3: amazon.com access already granted by manifest", !grantVisible);
	const t0 = Date.now();
	await ui.click("#scan");
	await ui.waitForSelector("#to-step-4:not([disabled])", { timeout: 180000 }).catch(() => {});
	const scanSecs = ((Date.now() - t0) / 1000).toFixed(0);
	const summary = (await ui.textContent("#scan-summary").catch(() => "")).trim();
	const warnings = (await ui.$$eval("#scan-warnings li", (l) => l.map((x) => x.textContent.trim()))).join(" | ");
	check("step 3: scan completes via content script", await ui.isEnabled("#to-step-4"), `${scanSecs}s; ${summary}${warnings ? "; warnings: " + warnings : ""}`);
	check("step 3: paginated POSTs carried cursor + token", postBodies.length === 2 && postBodies[0].body.exclusiveStartKey === "cursor-1" && postBodies[1].body.exclusiveStartKey === "cursor-2" && postBodies.every((p) => p.token === TOKEN) && postBodies[0].body.widgetName === "YourTransactions",
		JSON.stringify(postBodies.map((p) => p.body)));
	const detailGets = amazonRequests.filter((r) => r.includes("order-details"));
	check("step 3: fetched each in-window order once, skipped the out-of-window one", detailGets.length === 6 && !detailGets.some((r) => r.includes("999-")), `${detailGets.length} detail pages`);
	await ui.screenshot({ path: `${SHOTS}/3-scanned.png`, fullPage: true });

	// ---- Step 4: review + apply
	await ui.click("#to-step-4");
	await ui.waitForTimeout(500);
	const tabs = await ui.$$eval("#step-4 [role=tab], #step-4 .tabs button", (b) => b.map((x) => x.textContent.trim().replace(/\s+/g, " ")));
	check("step 4: review tabs", tabs.length > 0, tabs.join(" / "));
	await ui.screenshot({ path: `${SHOTS}/4-review.png`, fullPage: true });
	const applyLabel = (await ui.textContent("#apply")).trim();
	await ui.click("#apply");
	await ui.waitForFunction(() => /applied|Applied|couldn|Couldn/.test(document.querySelector("#review-status")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
	const applyStatus = (await ui.textContent("#review-status")).trim();
	check("step 4: apply finishes", /appl/i.test(applyStatus) && !/couldn/i.test(applyStatus), `${applyLabel} -> ${applyStatus}`);
	await ui.screenshot({ path: `${SHOTS}/5-applied.png`, fullPage: true });

	const db = await actual.evaluate(() => window.__fake);
	const kids = (id) => db.transactions.filter((r) => r.parent_id === id);
	const parents = db.transactions.filter((r) => r.is_parent);
	const sumOk = parents.every((p) => kids(p.id).reduce((a, c) => a + c.amount, 0) === p.amount);
	check("Actual: every parent's children sum to its amount", parents.length > 0 && sumOk, `${parents.length} parents: ${parents.map((p) => `${p.id}(${kids(p.id).length})`).join(" ")}`);
	check("Actual: parent notes are only the order link, category cleared",
		parents.every((p) => /^https:\/\/www\.amazon\.com\/\S+$/.test(p.notes) && p.category === null), parents.map((p) => p.notes).join(" "));
	const single = db.transactions.find((r) => r.id === "t5");
	check("Actual: one-item order still becomes a 1-child split", single?.is_parent === 1 && kids("t5").length === 1, `t5 children: ${kids("t5").length}`);
	check("Actual: cleared status unchanged; children inherit it", !db.transactions.find((r) => r.id === "t2").cleared && kids("t2").every((c) => !c.cleared) && kids("t1").every((c) => !!c.cleared) && db.transactions.every((r) => !r.reconciled), `t2 kids cleared=${kids("t2").map((c) => c.cleared)}; t1 kids cleared=${kids("t1").map((c) => c.cleared)}`);
	check("Actual: untouched rows untouched", ["t4", "t7", "t8"].every((id) => !db.transactions.find((r) => r.id === id).is_parent));
	check("Actual: t6 (date off by one) matched", db.transactions.find((r) => r.id === "t6").is_parent === 1);

	// ---- History + revert
	await ui.click("#history-toggle");
	await ui.waitForTimeout(500);
	const revertBtns = await ui.$$("#history-list button:has-text('Revert')");
	check("history: one revertable entry per applied split", revertBtns.length === parents.length, `${revertBtns.length} entries`);
	await ui.screenshot({ path: `${SHOTS}/6-history.png`, fullPage: true });
	const t1Kids = kids("t1").length;
	// Newest first: find the row for t1's order.
	const row = ui.locator("#history-list tr", { hasText: "111-6778632-7354601" });
	await row.locator("button:has-text('Revert')").click();
	await ui.waitForFunction(() => /Reverted|revert/.test(document.querySelector("#history-status")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
	const db2 = await actual.evaluate(() => window.__fake);
	const t1 = db2.transactions.find((r) => r.id === "t1");
	check("revert: children removed, parent restored", t1.is_parent === 0 && t1.notes === null && t1.category === null && !db2.transactions.some((r) => r.parent_id === "t1"),
		`${t1Kids} children removed; status: ${(await ui.textContent("#history-status")).trim()}`);

	// ---- Budget switched in the Actual tab -> banner and refusal
	await actual.evaluate(() => { window.__fake.prefs = { id: "budget-copy", budgetName: "Household 2026 (test copy)" }; });
	await ui.click("#history-close").catch(() => {});
	await ui.waitForSelector("#connection-banner:not([hidden])", { timeout: 15000 }).catch(() => {});
	const banner = (await ui.textContent("#connection-banner")).trim();
	check("budget switch detected by the 5s watcher", /test copy/.test(banner), banner);
	await ui.screenshot({ path: `${SHOTS}/7-switched.png`, fullPage: true });

	// ---- Actual tab closed
	await actual.evaluate(() => { window.__fake.prefs = { id: "budget-test-1", budgetName: "Household 2026" }; });
	await ui.waitForTimeout(6000);
	const cleared = await ui.isHidden("#connection-banner");
	await actual.close();
	await ui.waitForSelector("#connection-banner:not([hidden])", { timeout: 15000 }).catch(() => {});
	const banner2 = (await ui.textContent("#connection-banner")).trim();
	check("banner clears when the budget comes back, reappears when the tab closes", cleared && /closed|not responding/.test(banner2), banner2);

	check("no page errors", errors.length === 0, errors.join(" | "));
	await context.close();
	const failed = results.filter((r) => !r.ok).length;
	fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify({ results, amazonRequests, postBodies: postBodies.map((p) => p.body) }, null, 2));
	console.log(`\n${results.length - failed}/${results.length} passed`);
	process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
