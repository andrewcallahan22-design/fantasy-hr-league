// Shared league data endpoint.
// GET  -> league state (public read — anyone with the link can view standings)
// POST -> save state (requires sign-in; edits are for logged-in managers)
import { loadLeagueState, saveLeagueState } from './lib/core.mjs';
import { verifyAuth } from './lib/auth.mjs';

export default async (req) => {
  if (req.method === 'GET') {
    const state = await loadLeagueState();
    return Response.json(state);
  }
  if (req.method === 'POST') {
    const session = await verifyAuth(req);
    if (!session) {
      return Response.json({ ok: false, error: 'Sign in required to save changes' }, { status: 401 });
    }
    const body = await req.json().catch(() => null);
    if (!body || !body.managers || !body.months) {
      return Response.json({ ok: false, error: 'Invalid state payload' }, { status: 400 });
    }
    await saveLeagueState(body);
    return Response.json({ ok: true });
  }
  return new Response('Method not allowed', { status: 405 });
};
