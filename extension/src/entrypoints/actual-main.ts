import { type ActualWindow, installActualMain } from "../actual/main-world";

/** Loaded into Actual's page context by actual-bridge (as a <script>), see actual/main-world.ts. */
export default defineUnlistedScript(() => installActualMain(window as ActualWindow));
