/** Toolbar button opens the results page; all Amazon work happens in the content script. */
export default defineBackground(() => {
	const action = browser.action ?? browser.browserAction;
	action.onClicked.addListener(() => {
		void browser.tabs.create({ url: browser.runtime.getURL("/results.html") });
	});
});
