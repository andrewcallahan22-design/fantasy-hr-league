// Shared league data endpoint.
// GET  -> returns the league state everyone shares (seeds it on first ever call)
// POST -> saves the league state (manual HR edits, roster changes, settings)
import { loadLeagueState, saveLeagueState } from './lib/core.mjs';

export default async (req) => {
  if (req.method === 'GET') {
    const state = await loadLeagueState();
    return Response.json(state);
  }
  if (req.method === 'POST') {
    const body = await req.json();
    if (!body || !body.managers || !body.months) {
      return Response.json({ ok: false, error: 'Invalid state payload' }, { status: 400 });
    }
    await saveLeagueState(body);
    return Response.json({ ok: true });
  }
  return new Response('Method not allowed', { status: 405 });
};
