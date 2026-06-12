// Manual sync trigger — the ⟳ Sync button calls this.
// Runs the same server-side sync as the schedule, so one click updates everyone.
import { runSync } from './lib/core.mjs';

export default async () => {
  const result = await runSync();
  return Response.json(result);
};
