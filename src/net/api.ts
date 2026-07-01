// HTTP calls to the PartyKit auth party (signup, login, verify).
// Host is set via VITE_PARTY_HOST env var; falls back to localhost for dev.

const PARTY_HOST = (import.meta.env.VITE_PARTY_HOST as string | undefined) ?? 'localhost:1999';

// If the host already includes a protocol, respect it. Otherwise pick http
// for localhost (dev) and https for anything else (prod deploys are always
// on HTTPS — mixed content would be blocked by the browser).
function resolveOrigin(host: string): string {
  if (host.startsWith('http://') || host.startsWith('https://')) return host;
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  return `${isLocal ? 'http' : 'https'}://${host}`;
}

const AUTH_URL = `${resolveOrigin(PARTY_HOST)}/parties/auth/main`;

export type AuthOk = { token: string; username: string; displayName: string };
export type AuthErr = { error: string };

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${AUTH_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function signup(input: {
  username: string;
  password: string;
  displayName: string;
  inviteCode: string;
}): Promise<AuthOk | AuthErr> {
  const res = await post('signup', input);
  return (await res.json()) as AuthOk | AuthErr;
}

export async function login(input: {
  username: string;
  password: string;
}): Promise<AuthOk | AuthErr> {
  const res = await post('login', input);
  return (await res.json()) as AuthOk | AuthErr;
}

export async function verify(token: string): Promise<{ valid: boolean; username?: string; displayName?: string }> {
  const res = await post('verify', { token });
  return (await res.json()) as { valid: boolean; username?: string; displayName?: string };
}

export function isOk(r: AuthOk | AuthErr): r is AuthOk {
  return (r as AuthOk).token !== undefined;
}

// The PartyKit host used for WebSocket connections.
export function getPartyHost(): string {
  return PARTY_HOST;
}
