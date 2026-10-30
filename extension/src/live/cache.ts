import type { CachedOrder, OrderCache } from "./scan";

/** Minimal surface of browser.storage.local, so this stays testable without the extension runtime. */
export interface KeyValueArea {
	get(keys: string | string[] | null): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

const PREFIX = "order:";

/** Parsed order details kept between scans, so settled orders aren't re-fetched from Amazon. */
export function storageOrderCache(area: KeyValueArea): OrderCache & { clear(): Promise<number>; count(): Promise<number> } {
	return {
		async get(orderNumber) {
			const key = PREFIX + orderNumber;
			return ((await area.get(key))[key] as CachedOrder | undefined) ?? null;
		},
		async set(orderNumber, entry) {
			await area.set({ [PREFIX + orderNumber]: entry });
		},
		async clear() {
			const keys = Object.keys(await area.get(null)).filter((k) => k.startsWith(PREFIX));
			if (keys.length) await area.remove(keys);
			return keys.length;
		},
		async count() {
			return Object.keys(await area.get(null)).filter((k) => k.startsWith(PREFIX)).length;
		},
	};
}
