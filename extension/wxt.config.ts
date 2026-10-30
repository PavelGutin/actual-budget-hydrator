import { defineConfig } from "wxt";

export default defineConfig({
	srcDir: "src",
	manifest: ({ manifestVersion }) => ({
		name: "Actual Budget Hydrator",
		description: "Itemizes Amazon charges in Actual Budget, using your own signed-in browser.",
		host_permissions: ["https://www.amazon.com/*"],
		// The Actual server's address is yours to choose; access to it is requested when you connect.
		...(manifestVersion === 2
			? {
					permissions: ["storage"],
					optional_permissions: ["http://*/*", "https://*/*"],
					web_accessible_resources: ["actual-main.js"],
				}
			: {
					permissions: ["storage", "scripting"],
					optional_host_permissions: ["http://*/*", "https://*/*"],
					web_accessible_resources: [{ resources: ["actual-main.js"], matches: ["http://*/*", "https://*/*"] }],
				}),
		action: { default_title: "Actual Budget Hydrator" },
		browser_specific_settings: {
			gecko: {
				id: "actual-budget-hydrator@pavelgutin",
				// Required by Mozilla for new add-ons: nothing is collected or sent to the developer.
				data_collection_permissions: { required: ["none"] },
			} as { id: string },
		},
	}),
});
