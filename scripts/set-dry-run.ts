import "dotenv/config";
import { setSetting, getSettings } from "../src/lib/settings";
import { logActivity } from "../src/lib/activity";
(async () => {
  await setSetting("dryRun", true);
  await logActivity({ type: "settings.dry_run", message: "Dry-run mode ON (set during development of X credential management)" });
  console.log("dryRun =", (await getSettings()).dryRun);
  process.exit(0);
})();
