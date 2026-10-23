/**
 * Allocates integer `totalCents` across entries proportional to `weights` (all
 * non-negative), using the largest-remainder method. `totalCents` may be negative
 * (e.g. a discount); the sign is applied uniformly to the result.
 */
export function allocateProportional(weights: number[], totalCents: number): number[] {
	const n = weights.length;
	if (n === 0) return [];

	const sign = totalCents < 0 ? -1 : 1;
	const magnitude = Math.abs(totalCents);
	const weightSum = weights.reduce((a, b) => a + b, 0);

	if (weightSum === 0) {
		const base = Math.floor(magnitude / n);
		const remainder = magnitude - base * n;
		return weights.map((_, i) => sign * (base + (i < remainder ? 1 : 0)));
	}

	const raw = weights.map((w) => (magnitude * w) / weightSum);
	const floors = raw.map(Math.floor);
	const remainder = magnitude - floors.reduce((a, b) => a + b, 0);

	const orderByFrac = raw
		.map((r, i) => ({ i, frac: r - floors[i] }))
		.sort((a, b) => b.frac - a.frac)
		.map((x) => x.i);

	const shares = [...floors];
	for (let i = 0; i < remainder; i++) {
		shares[orderByFrac[i]] += 1;
	}

	return shares.map((s) => sign * s);
}
