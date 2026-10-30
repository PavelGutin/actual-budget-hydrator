import { parseCurrency } from "./parse-currency";
import { parseFuzzyDate } from "./parse-fuzzy-date";
import { parseOrderNumber } from "./parse-order-number";

/**
 * Port of amazon-orders' TransactionsPage._parse_transaction_data_tag / _parse_transaction_list,
 * covering only the modern Next.js-embedded-JSON transactions page (script#__NEXT_DATA__). The
 * legacy server-rendered HTML-form page (older Amazon accounts/regions) isn't ported yet -- see
 * README for known gaps.
 */
export interface ParsedTransaction {
	completedDate: string | null;
	paymentMethod: string | null;
	paymentMethodLast4: string | null;
	grandTotal: number | null;
	isRefund: boolean;
	orderNumber: string | null;
	orderDetailsLink: string | null;
	seller: string | null;
	/** Amazon's statusInfo.status, e.g. "Pending" or "Approved". Pending amounts can still change. */
	status: string | null;
	isPending: boolean;
	/** Portion paid from Amazon gift card balance -- never appears on a bank/card statement. */
	isGiftCard: boolean;
}

interface RawTransaction {
	formattedDate?: string;
	formattedAmount?: string;
	orderData?: { orderDisplayString?: string; orderDetailsUrl?: string }[];
	paymentMethodDisplayStringData?: {
		paymentMethodName?: string;
		paymentMethodNumber?: { lastDigits?: string };
	};
	statementDescriptor?: string;
	statusInfo?: { status?: string; label?: string; amountDetailsStatusType?: string };
}

export interface NextPageCursor {
	exclusiveStartKey: unknown;
	token: unknown;
	locale: unknown;
	widgetName: unknown;
}

export interface ParsedTransactionsPage {
	transactions: ParsedTransaction[];
	nextPageData: NextPageCursor | null;
}

function parseOneTransaction(raw: RawTransaction): ParsedTransaction | null {
	const completedDate = parseFuzzyDate(raw.formattedDate);
	const grandTotal = raw.formattedAmount ? parseCurrency(raw.formattedAmount) : null;
	if (completedDate === null || grandTotal === null) return null;

	const orderData = raw.orderData?.[0] ?? {};
	const paymentData = raw.paymentMethodDisplayStringData ?? {};
	const paymentMethodName = paymentData.paymentMethodName ?? null;
	const lastDigits = paymentData.paymentMethodNumber?.lastDigits ?? null;
	const paymentMethod =
		paymentMethodName && lastDigits ? `${paymentMethodName} ****${lastDigits}` : paymentMethodName;

	const orderNumber = parseOrderNumber(orderData.orderDisplayString);
	const seller = raw.statementDescriptor ?? null;
	const status = raw.statusInfo?.status ?? null;

	return {
		completedDate,
		paymentMethod,
		paymentMethodLast4: lastDigits,
		grandTotal,
		isRefund: grandTotal > 0,
		orderNumber,
		orderDetailsLink: orderData.orderDetailsUrl ?? null,
		seller: seller === orderNumber ? null : seller,
		status,
		isPending: status?.toLowerCase() === "pending",
		isGiftCard: /gift card/i.test(paymentMethodName ?? ""),
	};
}

export interface ParsedTransactionsDataPage {
	transactions: ParsedTransaction[];
	/** Cursor for the following page; null on the last page. */
	lastEvaluatedKey: string | null;
}

/**
 * Parses the JSON body of the paginated POST the transactions page makes on scroll
 * (/payments-portal/data/iris/live/v1/data/manage/get-transactions). Port of amazon-orders'
 * TransactionsPage._get_data_page response handling. Note the plural `transactionsList` here vs
 * `transactionList` in the page's embedded __NEXT_DATA__.
 */
export function parseTransactionsDataResponse(body: unknown): ParsedTransactionsDataPage {
	const display = (body as { displayResponse?: { transactionsList?: RawTransaction[]; lastEvaluatedKey?: string } })
		?.displayResponse;
	const rawList = display?.transactionsList;
	if (!Array.isArray(rawList)) {
		throw new Error("Could not find displayResponse.transactionsList -- check if Amazon changed the response shape.");
	}
	const transactions = rawList.map(parseOneTransaction).filter((t): t is ParsedTransaction => t !== null);
	const lastEvaluatedKey = display?.lastEvaluatedKey;
	return { transactions, lastEvaluatedKey: lastEvaluatedKey && transactions.length > 0 ? lastEvaluatedKey : null };
}

/** Parses a Transactions page already identified as the Next.js/embedded-JSON variant. */
export function parseTransactionsNextData(doc: Document): ParsedTransactionsPage {
	const dataTag = doc.querySelector("script#__NEXT_DATA__");
	if (!dataTag?.textContent) {
		throw new Error("No script#__NEXT_DATA__ tag found -- not the Next.js transactions page variant.");
	}

	const parsed = JSON.parse(dataTag.textContent);
	const pageProps = parsed?.props?.pageProps;
	const state = pageProps?.state?.transactionResponseState;
	const rawList: RawTransaction[] | undefined = state?.visibleTransactionResponse?.transactionList;
	if (!rawList) {
		throw new Error("Could not find transactionList in __NEXT_DATA__ -- check if Amazon changed the page shape.");
	}

	const transactions = rawList
		.map(parseOneTransaction)
		.filter((t): t is ParsedTransaction => t !== null);

	let nextPageData: NextPageCursor | null = null;
	if (state.hasMore && state.lastEvaluatedPageKey) {
		nextPageData = {
			exclusiveStartKey: state.lastEvaluatedPageKey,
			token: pageProps.token,
			locale: pageProps.request?.locale,
			widgetName: pageProps.request?.widgetName,
		};
	}

	return { transactions, nextPageData };
}
