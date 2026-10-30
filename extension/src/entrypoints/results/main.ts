import { initStep1, verifyBudget, watchBudget } from "./actual-ui";
import { enterScanStep, isScanning } from "./amazon-step";
import { historyCount, renderHistory } from "./history-view";
import { enterReviewStep, refreshApplyButton } from "./review-step";
import { loadPrefs, state } from "./state";
import { $ } from "./ui";

/** The wizard: 1 connect Actual, 2 choose transactions, 3 scan Amazon, 4 review and apply; History beside it. */

type Step = 1 | 2 | 3 | 4;
const STEPS: Step[] = [1, 2, 3, 4];
let current: Step = 1;
let furthest: Step = 1;

const stepButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".steps [data-step]"));
const sections: Record<Step, HTMLElement> = { 1: $("step-1"), 2: $("step-2"), 3: $("step-3"), 4: $("step-4") };
const historySection = $("history");
const historyToggle = $<HTMLButtonElement>("history-toggle");
const stepsNav = document.querySelector<HTMLElement>(".steps")!;

const banner = $("connection-banner");

function canEnter(step: Step): boolean {
	if (step === 1) return true;
	if (state.connectionProblem) return false;
	if (step === 2) return !$<HTMLButtonElement>("to-step-2").disabled;
	if (step === 3) return !$<HTMLButtonElement>("to-step-3").disabled;
	return !!state.scan && !isScanning();
}

async function go(step: Step) {
	// Leaving step 1 needs the budget connected there to still be open in the Actual tab.
	if (step > 1) {
		try {
			await verifyBudget();
		} catch {
			step = 1;
		}
	}
	if (!canEnter(step)) return;
	current = step;
	furthest = Math.max(furthest, step) as Step;
	historySection.hidden = true;
	stepsNav.hidden = false;
	for (const s of STEPS) sections[s].hidden = s !== step;
	renderSteps();
	sections[step].querySelector("h2")?.focus?.();
	if (step === 3) await enterScanStep();
	if (step === 4) await enterReviewStep();
}

function renderSteps() {
	for (const b of stepButtons) {
		const s = Number(b.dataset.step) as Step;
		b.dataset.state = s === current ? "current" : s < current || s <= furthest ? "done" : "upcoming";
		if (s === current) b.setAttribute("aria-current", "step");
		else b.removeAttribute("aria-current");
		b.disabled = s !== current && !(s <= furthest && canEnter(s));
	}
}

for (const b of stepButtons) b.addEventListener("click", () => void go(Number(b.dataset.step) as Step));
$("to-step-2").addEventListener("click", () => void go(2));
$("to-step-3").addEventListener("click", () => void go(3));
$("to-step-4").addEventListener("click", () => void go(4));
$("back-to-1").addEventListener("click", () => void go(1));
$("back-to-2").addEventListener("click", () => void go(2));
$("back-to-3").addEventListener("click", () => void go(3));

async function updateHistoryLink() {
	const n = await historyCount();
	historyToggle.textContent = n ? `History (${n})` : "History";
}

historyToggle.addEventListener("click", async () => {
	for (const s of STEPS) sections[s].hidden = true;
	stepsNav.hidden = true;
	historySection.hidden = false;
	await renderHistory();
});
$("history-close").addEventListener("click", () => void go(current));

browser.storage.onChanged.addListener((changes) => {
	if ("appliedLog" in changes) void updateHistoryLink();
});

void (async () => {
	await loadPrefs();
	initStep1(renderSteps, () => {
		void updateHistoryLink();
		banner.textContent = state.connectionProblem ?? "";
		banner.hidden = !state.connectionProblem;
		renderSteps();
		refreshApplyButton();
	});
	watchBudget();
	renderSteps();
	void updateHistoryLink();
})();
