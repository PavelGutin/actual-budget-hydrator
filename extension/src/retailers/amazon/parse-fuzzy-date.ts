/**
 * Simplified stand-in for amazon-orders' dateutil-based fuzzy date parsing: extracts a
 * "Month Day, Year" (or "Day Month Year") pattern out of noisy surrounding text (e.g.
 * "Order placed\n\nDecember 21, 2018") and ignores everything else. US-formatted text only.
 */
const MONTH_DAY_YEAR = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/;

const MONTHS = [
	"january", "february", "march", "april", "may", "june",
	"july", "august", "september", "october", "november", "december",
];

/** Avoids `new Date("December 21, 2018")`, which parses in local time and can shift the
 * date by a day in `.toISOString()` depending on the runtime's timezone offset. */
export function parseFuzzyDate(text: string | null | undefined): string | null {
	if (!text) return null;
	const match = text.match(MONTH_DAY_YEAR);
	if (!match) return null;

	const lowerMonth = match[1].toLowerCase();
	const monthIndex = MONTHS.findIndex((m) => m === lowerMonth || m.startsWith(lowerMonth));
	if (monthIndex === -1) return null;

	const day = Number.parseInt(match[2], 10);
	const year = Number.parseInt(match[3], 10);
	return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
