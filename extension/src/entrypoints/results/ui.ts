/** Small DOM helpers for the results page. */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const { dataset, ...rest } = props;
	const el = Object.assign(document.createElement(tag), rest);
	if (dataset) Object.assign(el.dataset, dataset);
	for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
	return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export type Tone = "ok" | "warn" | "error" | "";

export function setStatus(el: HTMLElement, text: string, tone: Tone = "") {
	el.textContent = text;
	if (tone) el.dataset.tone = tone;
	else delete el.dataset.tone;
}

/** Cents to "-32.40". */
export const money = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "2026-10-23" to "Oct 23" (or "Oct 23, 2025" outside the current year). */
export function shortDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	const sameYear = d.getFullYear() === new Date().getFullYear();
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "today at 7:50 PM", "yesterday at 7:50 PM", "Oct 21 at 7:50 PM". */
export function relativeTime(iso: string): string {
	const d = new Date(iso);
	const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
	const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
	if (days === 0) return `today at ${time}`;
	if (days === 1) return `yesterday at ${time}`;
	return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${time}`;
}
