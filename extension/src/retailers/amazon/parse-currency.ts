/**
 * Simplified port of amazon-orders' Constants.parse_currency, scoped to US-formatted amounts
 * ("$1,234.56", "(1.99)"). Full locale handling (amazon.de/.co.jp etc.) is out of scope for the spike.
 */
export function parseCurrency(value: string | null | undefined): number | null {
	if (!value) return null;

	let trimmed = value.trim();
	if (!trimmed) return null;

	let negative = false;
	if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
		negative = true;
		trimmed = trimmed.slice(1, -1);
	}

	const cleaned = trimmed.replace(/−/g, "-").replace(/[^0-9.,-]/g, "");
	if (!cleaned) return null;

	const numeric = cleaned.replace(/,/g, "");
	const parsed = Number.parseFloat(numeric);
	if (Number.isNaN(parsed)) return null;

	return negative ? -Math.abs(parsed) : parsed;
}
