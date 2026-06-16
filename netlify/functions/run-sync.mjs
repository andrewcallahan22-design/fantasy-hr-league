// Manual sync trigger — the ⟳ Sync button calls this.
// Passes force=true so a user-initiated ⟳ press always runs, even if the
// scheduled cron also fired recently. (The cron job itself does NOT pass
// force, so duplicate cron fires within 30s of each other are deduped.)
import { runSync } from './lib/core.mjs';

export default async () => {
  const result = await runSync({ force: true });
  return Response.json(result);
};
