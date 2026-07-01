// Auth Durable Object — one shared instance (named "main"). Handles signup,
// login, and token verification over HTTP. User records live in the DO's
// storage. Signup is gated by INVITE_CODE.

import { DurableObject } from 'cloudflare:workers';
import { hashPassword, makeToken, randomSalt, verifyToken } from './util';

type StoredUser = {
  username: string;
  displayName: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
};

type Env = {
  TOKEN_SECRET: string;
  INVITE_CODE: string;
};

const USERS_KEY = 'users';

export class AuthDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return corsResponse();
    const url = new URL(request.url);
    const path = url.pathname.split('/').pop() ?? '';
    try {
      if (request.method === 'POST' && path === 'signup') return await this.handleSignup(request);
      if (request.method === 'POST' && path === 'login') return await this.handleLogin(request);
      if (request.method === 'POST' && path === 'verify') return await this.handleVerify(request);
    } catch (err) {
      return jsonResponse({ error: 'Server error', detail: String(err) }, 500);
    }
    return jsonResponse({ error: 'Not found' }, 404);
  }

  private async getUsers(): Promise<Record<string, StoredUser>> {
    return (await this.ctx.storage.get<Record<string, StoredUser>>(USERS_KEY)) ?? {};
  }

  private async putUsers(users: Record<string, StoredUser>): Promise<void> {
    await this.ctx.storage.put(USERS_KEY, users);
  }

  private async handleSignup(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      username?: string;
      password?: string;
      displayName?: string;
      inviteCode?: string;
    };

    if (body.inviteCode !== this.env.INVITE_CODE) {
      return jsonResponse({ error: 'Invalid invite code' }, 403);
    }
    const username = (body.username ?? '').toLowerCase().trim();
    const password = body.password ?? '';
    const displayName = (body.displayName ?? '').trim();

    if (username.length < 3) return jsonResponse({ error: 'Username must be at least 3 characters' }, 400);
    if (!/^[a-z0-9_-]+$/.test(username)) return jsonResponse({ error: 'Username may only contain letters, numbers, - and _' }, 400);
    if (password.length < 6) return jsonResponse({ error: 'Password must be at least 6 characters' }, 400);
    if (displayName.length < 1 || displayName.length > 30) return jsonResponse({ error: 'Display name must be 1–30 characters' }, 400);

    const users = await this.getUsers();
    if (users[username]) return jsonResponse({ error: 'Username already taken' }, 409);

    const salt = randomSalt();
    const passwordHash = await hashPassword(password, salt);
    users[username] = { username, displayName, passwordHash, salt, createdAt: Date.now() };
    await this.putUsers(users);

    const token = await makeToken({ username, displayName }, this.env.TOKEN_SECRET);
    return jsonResponse({ token, username, displayName });
  }

  private async handleLogin(req: Request): Promise<Response> {
    const body = (await req.json()) as { username?: string; password?: string };
    const username = (body.username ?? '').toLowerCase().trim();
    const password = body.password ?? '';
    if (!username || !password) return jsonResponse({ error: 'Username and password required' }, 400);

    const users = await this.getUsers();
    const user = users[username];
    if (!user) return jsonResponse({ error: 'Invalid credentials' }, 401);

    const hash = await hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return jsonResponse({ error: 'Invalid credentials' }, 401);

    const token = await makeToken({ username: user.username, displayName: user.displayName }, this.env.TOKEN_SECRET);
    return jsonResponse({ token, username: user.username, displayName: user.displayName });
  }

  private async handleVerify(req: Request): Promise<Response> {
    const body = (await req.json()) as { token?: string };
    if (!body.token) return jsonResponse({ valid: false });
    const payload = await verifyToken(body.token, this.env.TOKEN_SECRET);
    if (!payload) return jsonResponse({ valid: false });
    return jsonResponse({ valid: true, username: payload.username, displayName: payload.displayName });
  }
}

// ---- CORS ---------------------------------------------------------------

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
