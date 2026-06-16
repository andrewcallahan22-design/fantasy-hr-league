// Legacy data endpoint — left as a compatibility shim for any old clients that
// might still hit it. The new system uses /league?id=... for state and
// /league save-state actions for edits.
export default async (req) => {
  return Response.json({
    ok: false,
    error: 'This endpoint is deprecated. The site has been upgraded to multi-league. Reload the page.',
    upgrade: true,
  }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
};
