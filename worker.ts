// Cloudflare Worker entry point. Routes HTTP requests to the AuthDO (all
// paths under /parties/auth/main/) and WebSocket upgrades for a specific room
// code to the RoomDO named for that room. URL patterns match what the
// PartyKit client library expects, so no client-side changes are needed.

export { AuthDO } from './party/auth';
export { RoomDO } from './party/room';

type Env = {
  ROOM: DurableObjectNamespace;
  AUTH: DurableObjectNamespace;
  TOKEN_SECRET: string;
  INVITE_CODE: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Route auth endpoints (signup, login, verify) to the shared AuthDO.
    if (path.startsWith('/parties/auth/main/')) {
      const id = env.AUTH.idFromName('main');
      return env.AUTH.get(id).fetch(request);
    }

    // Route WebSocket upgrades for /parties/main/{roomCode} to the RoomDO
    // named for that specific room. Each room code becomes its own DO instance.
    const roomMatch = path.match(/^\/parties\/main\/([^/]+)/);
    if (roomMatch) {
      const roomCode = decodeURIComponent(roomMatch[1]).toLowerCase();
      const id = env.ROOM.idFromName(roomCode);
      return env.ROOM.get(id).fetch(request);
    }

    // A tiny health/greeting for the root — helps sanity-check the deploy.
    if (path === '/' || path === '') {
      return new Response('Bukhara server — ok', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
