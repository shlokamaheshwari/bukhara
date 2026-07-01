// Auth party — singleton. Handles /signup, /login, /verify over HTTP.
// User records live in the party's Durable Object storage (persistent).
// Signup is gated by INVITE_CODE env var; only people you share it with can
// register.

import type * as Party from 'partykit/server';
import { hashPassword, makeToken, randomSalt, verifyToken } from './util';

type StoredUser = {
  username: string; // lowercase, canonical
  displayName: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
};

const USERS_KEY = 'users';

export default class AuthServer implements Party.Server {
  constructor(readonly party: Party.Party) {}

  private env(): { TOKEN_SECRET: string; INVITE_CODE: string } {
    const e = this.party.env as Record<string, string | undefined>;
    return {
      TOKEN_SECRET: e.TOKEN_SECRET ?? 'dev-secret-change-me',
      INVITE_CODE: e.INVITE_CODE ?? 'bhukara-invite-2026',
    };
  }

  private async getUsers(): Promise<Record<string, StoredUser>> {
    return (await this.party.storage.get<Record<string, StoredUser>>(USERS_KEY)) ?? {};
  }

  private async putUsers(users: Record<string, StoredUser>): Promise<void> {
    await this.party.storage.put(USERS_KEY, users);
  }

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === 'OPTIONS') return corsResponse();

    const url = new URL(req.url);
    const path = url.pathname.split('/').pop() ?? '';

    try {
      if (req.method === 'POST' && path === 'signup') return await this.handleSignup(req);
      if (req.method === 'POST' && path === 'login') return await this.handleLogin(req);
      if (req.method === 'POST' && path === 'verify') return await this.handleVerify(req);
    } catch (err) {
      return jsonResponse({ error: 'Server error', detail: String(err) }, 500);
    }
    return jsonResponse({ error: 'Not found' }, 404);
  }

  private async handleSignup(req: Party.Request): Promise<Response> {
    const body = (await req.json()) as {
      username?: string;
      password?: string;
      displayName?: string;
      inviteCode?: string;
    };
    const env = this.env();

    if (body.inviteCode !== env.INVITE_CODE) {
      return jsonResponse({ error: 'Invalid invite code' }, 403);
    }
    const username = (body.username ?? '').toLowerCase().trim();
    const password = body.password ?? '';
    const displayName = (body.displayName ?? '').trim();

    if (username.length < 3) {
      return jsonResponse({ error: 'Username must be at least 3 characters' }, 400);
    }
    if (!/^[a-z0-9_-]+$/.test(username)) {
      return jsonResponse({ error: 'Username may only contain letters, numbers, - and _' }, 400);
    }
    if (password.length < 6) {
      return jsonResponse({ error: 'Password must be at least 6 characters' }, 400);
    }
    if (displayName.length < 1 || displayName.length > 30) {
      return jsonResponse({ error: 'Display name must be 1–30 characters' }, 400);
    }

    const users = await this.getUsers();
    if (users[username]) return jsonResponse({ error: 'Username already taken' }, 409);

    const salt = randomSalt();
    const passwordHash = await hashPassword(password, salt);
    users[username] = { username, displayName, passwordHash, salt, createdAt: Date.now() };
    await this.putUsers(users);

    const token = await makeToken({ username, displayName }, env.TOKEN_SECRET);
    return jsonResponse({ token, username, displayName });
  }

  private async handleLogin(req: Party.Request): Promise<Response> {
    const body = (await req.json()) as { username?: string; password?: string };
    const env = this.env();

    const username = (body.username ?? '').toLowerCase().trim();
    const password = body.password ?? '';
    if (!username || !password) return jsonResponse({ error: 'Username and password required' }, 400);

    const users = await this.getUsers();
    const user = users[username];
    if (!user) return jsonResponse({ error: 'Invalid credentials' }, 401);

    const hash = await hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return jsonResponse({ error: 'Invalid credentials' }, 401);

    const token = await makeToken({ username: user.username, displayName: user.displayName }, env.TOKEN_SECRET);
    return jsonResponse({ token, username: user.username, displayName: user.displayName });
  }

  private async handleVerify(req: Party.Request): Promise<Response> {
    const body = (await req.json()) as { token?: string };
    const env = this.env();
    if (!body.token) return jsonResponse({ valid: false });
    const payload = await verifyToken(body.token, env.TOKEN_SECRET);
    if (!payload) return jsonResponse({ valid: false });
    return jsonResponse({ valid: true, username: payload.username, displayName: payload.displayName });
  }
}

// ---- CORS-friendly response helpers ------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}
