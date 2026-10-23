import { describe, expect, it } from "vitest";
import { allocateProportional } from "../src/splitting/allocate-proportional";

describe("allocateProportional", () => {
	it("splits evenly when weights are equal", () => {
		expect(allocateProportional([10, 10], 10)).toEqual([5, 5]);
	});

	it("uses the largest-remainder method to land exactly on the total", () => {
		const shares = allocateProportional([1, 1, 1], 10);
		expect(shares.reduce((a, b) => a + b, 0)).toBe(10);
		// 10/3 each = 3.33; two of the three get the rounded-up remainder.
		expect(shares.sort()).toEqual([3, 3, 4]);
	});

	it("applies the sign of a negative total uniformly", () => {
		const shares = allocateProportional([1, 1, 1], -10);
		expect(shares.reduce((a, b) => a + b, 0)).toBe(-10);
		expect(shares.every((s) => s <= 0)).toBe(true);
	});

	it("splits evenly across the count when all weights are zero", () => {
		expect(allocateProportional([0, 0, 0], 10)).toEqual([4, 3, 3]);
	});

	it("returns an empty array for no entries", () => {
		expect(allocateProportional([], 10)).toEqual([]);
	});

	it("gives a zero-weight entry nothing when other weights are non-zero", () => {
		expect(allocateProportional([10, 0], 10)).toEqual([10, 0]);
	});
});
