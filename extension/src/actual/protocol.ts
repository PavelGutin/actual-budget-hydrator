/**
 * Messages between the results page and the Actual tab. The tab side (actual-bridge, an isolated
 * content script) relays them as DOM CustomEvents to actual-main, a script running in Actual's own
 * page context where its `$q` / `$query` / `$send` live -- the technique actual-budget-tweaks uses
 * (github.com/aelxxs/actual-budget-tweaks, MIT), with our own event names so both can coexist.
 */
export const ACTUAL_PORT = "hydrator-actual";
export const MAIN_REQUEST_EVENT = "abh:request";
export const MAIN_RESPONSE_EVENT = "abh:response";

export type ActualRequest =
	| { id: string; kind: "ping" }
	| { id: string; kind: "query"; table: string; filter?: unknown; select?: unknown; options?: unknown }
	| { id: string; kind: "send"; method: string; args?: unknown };

export interface ActualResponse {
	id: string;
	data?: unknown;
	error?: string;
}
