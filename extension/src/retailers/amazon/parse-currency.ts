/**
 * Port of amazon-orders' Constants.parse_currency + util.strip_currency_text / to_decimal_point:
 * "$1,234.56", "-$2.99", "+$18.01", "($1.99)", "CDN$ 5", "12,99 €", and "FREE" (0).
 */
const CURRENCY_FREE_TEXT = "free";

export function parseCurrency(value: string | null | undefined): number | null {
	if (!value) return null;
	let v = value.trim();
	if (!v) return null;
	if (v.toLowerCase() === CURRENCY_FREE_TEXT) return 0;

	if (v.startsWith("(") && v.endsWith(")")) v = `-${v.slice(1, -1)}`;

	v = v.replace(/−/g, "-").replace(/[\p{L}\p{Sc}\s]/gu, "");

	const decimalMark = v.match(/[.,](\d{1,2})$/);
	const whole = (decimalMark ? v.slice(0, decimalMark.index) : v).replace(/[.,']/g, "");
	const normalized = decimalMark ? `${whole}.${decimalMark[1]}` : whole;

	if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized)) return null;
	return Number.parseFloat(normalized);
}
