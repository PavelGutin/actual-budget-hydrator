/**
 * Selection helpers mirroring amazon-orders' util.select / util.select_one / Parsable.simple_parse
 * (MIT, github.com/alexdlaird/amazon-orders), so ported selector lists behave the same way:
 * a list is tried in order and the first selector that yields something wins.
 */

/** Port of amazonorders.selectors.Selector: a CSS selector narrowed by the matched element's text. */
export interface TextSelector {
	css: string;
	/** Element text (trimmed) must equal this. */
	text?: string;
	/** Element text must contain this, case-insensitively. Ignored when `text` is set. */
	textContains?: string;
}

export type SelectorLike = string | TextSelector;
export type SelectorList = SelectorLike | readonly SelectorLike[];

const NON_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/**
 * Text content without <script>/<style>/<template> bodies, like BeautifulSoup's `.text` (which skips
 * those string types). DOM `textContent` would otherwise pull in inline JS/JSON.
 */
export function textOf(el: Node | null | undefined): string {
	if (!el) return "";
	if (el.nodeType === 3) return el.nodeValue ?? "";
	let out = "";
	const walk = (node: Node) => {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 3) out += child.nodeValue ?? "";
			else if (child.nodeType === 1 && !NON_TEXT_TAGS.has((child as Element).tagName)) walk(child);
		}
	};
	walk(el);
	return out;
}

/** Collapses runs of whitespace and trims -- for titles and labels that end up shown to a person. */
export function squish(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function queryAll(root: ParentNode, css: string): Element[] {
	try {
		return Array.from(root.querySelectorAll(css));
	} catch {
		// An engine without support for a selector (e.g. relative :has) treats it as "no match".
		return [];
	}
}

function textMatches(el: Element, sel: TextSelector): boolean {
	if (sel.text !== undefined) return textOf(el).trim() === sel.text;
	if (sel.textContains !== undefined) return textOf(el).toLowerCase().includes(sel.textContains.toLowerCase());
	return true;
}

function asList(selectors: SelectorList): readonly SelectorLike[] {
	return typeof selectors === "string" || !Array.isArray(selectors) ? [selectors as SelectorLike] : selectors;
}

function selectOneSelector(root: ParentNode, s: SelectorLike): Element[] {
	if (typeof s === "string") return queryAll(root, s);
	return queryAll(root, s.css).filter((el) => textMatches(el, s));
}

/** util.select: the matches of the first selector in the list that matches anything. */
export function select(root: ParentNode, selectors: SelectorList): Element[] {
	for (const s of asList(selectors)) {
		const found = selectOneSelector(root, s);
		if (found.length > 0) return found;
	}
	return [];
}

/** util.select_one: the first match of the first selector in the list that matches anything. */
export function selectOne(root: ParentNode, selectors: SelectorList): Element | null {
	return select(root, selectors)[0] ?? null;
}

/** Python truthiness of util.to_type(value): "", "0", "0.0" are falsy, so simple_parse keeps looking. */
export function isTruthyValue(value: string | null): boolean {
	if (value === null) return false;
	if (value === "") return false;
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value) !== 0;
	return true;
}

export interface SimpleParseOptions {
	attr?: string;
	textContains?: string;
	prefixSplit?: string;
	prefixSplitFuzzy?: boolean;
	suffixSplit?: string;
	suffixSplitFuzzy?: boolean;
	/** Like simple_parse's parse_date: converts the value; a null result counts as "not found yet". */
	convert?: (value: string) => string | null;
}

/**
 * Port of Parsable.simple_parse (text mode, plus attribute mode). Walks each selector's matches in
 * order and returns the first truthy, trimmed value; an attribute returns from the first element.
 */
export function simpleParse(root: ParentNode, selectors: readonly string[] | string, opts: SimpleParseOptions = {}): string | null {
	let value: string | null = null;
	for (const s of typeof selectors === "string" ? [selectors] : selectors) {
		for (const el of queryAll(root, s)) {
			if (opts.attr) return el.getAttribute(opts.attr);
			const elText = textOf(el);
			if (opts.textContains && !elText.includes(opts.textContains)) continue;

			let v: string;
			if (opts.prefixSplit) {
				if (!elText.includes(opts.prefixSplit)) {
					if (!opts.prefixSplitFuzzy) continue;
					v = elText.trim();
				} else {
					v = elText.trim().split(opts.prefixSplit)[1];
				}
			} else {
				v = elText;
			}

			if (opts.suffixSplit) {
				if (!v.includes(opts.suffixSplit)) {
					if (!opts.suffixSplitFuzzy) continue;
					v = v.trim();
				} else {
					v = v.trim().split(opts.suffixSplit)[0];
				}
			}

			value = opts.convert ? opts.convert(v.trim()) : v.trim();
			break;
		}
		if (isTruthyValue(value)) break;
	}
	return value;
}

/** Port of util.to_count: a whole number located by `pattern`, where `{count}` marks it. */
export function toCount(value: string, pattern = "^\\s*{count}"): number | null {
	const re = new RegExp(pattern.replace("{count}", "(?<count>\\d+(?:[.,'\\s]\\d{3})*)"));
	const m = value.match(re);
	return m?.groups ? Number.parseInt(m.groups.count.replace(/\D/g, ""), 10) : null;
}
