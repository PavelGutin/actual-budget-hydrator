import type { ScanOptions, ScanReport, ScanStats } from "./scan";

/** Port name the results page opens to the amazon.com content script. */
export const SCAN_PORT = "hydrator-scan";

/** "ping" checks the content script is alive in the tab before a scan starts. */
export type ToContent = { type: "ping" } | { type: "start"; options: Partial<ScanOptions> };

export type FromContent =
	| { type: "pong" }
	| { type: "progress"; message: string }
	| { type: "stats"; stats: ScanStats }
	| { type: "done"; report: ScanReport }
	| { type: "error"; message: string };
