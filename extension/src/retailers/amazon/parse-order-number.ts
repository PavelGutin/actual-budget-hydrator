/** Port of amazon-orders' Constants.ORDER_NUMBER_REGEX / parse_order_number. */
const ORDER_NUMBER_REGEX = /(?<![A-Z0-9-])(?:[A-Z0-9]{3}-\d{7}-\d{7}|\d{4}-\d{6}-\d{7}|\d{19})(?![A-Z0-9-])/;

export function parseOrderNumber(value: string | null | undefined): string | null {
	if (!value) return null;
	const match = value.match(ORDER_NUMBER_REGEX);
	return match ? match[0] : null;
}
