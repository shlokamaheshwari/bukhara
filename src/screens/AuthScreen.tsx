import { useState } from 'react';
import { isOk, login, signup } from '../net/api';

// Login + signup screen. Signup requires the invite code the host has shared.
// On success, the parent is handed the token, username, and displayName.

export default function AuthScreen({
  onAuthed,
}: {
  onAuthed: (auth: { token: string; username: string; displayName: string }) => void;
}) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === 'login'
          ? await login({ username, password })
          : await signup({ username, password, displayName: displayName || username, inviteCode });
      if (isOk(res)) {
        localStorage.setItem('bhukara-auth', JSON.stringify(res));
        onAuthed(res);
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError('Could not reach the server. Is it running?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <h1 className="auth-logo"><img src="/logo.jpg" alt="Bukhara" /></h1>
        <div className="auth-tabs">
          <button
            className={mode === 'login' ? 'active' : ''}
            onClick={() => { setMode('login'); setError(null); }}
            type="button"
          >
            Sign in
          </button>
          <button
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => { setMode('signup'); setError(null); }}
            type="button"
          >
            Create account
          </button>
        </div>
        <form onSubmit={submit} className="auth-form">
          <label>
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              minLength={3}
              disabled={busy}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={6}
              disabled={busy}
            />
          </label>
          {mode === 'signup' && (
            <>
              <label>
                <span>Display name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="What friends will see"
                  maxLength={30}
                  disabled={busy}
                />
              </label>
              <label>
                <span>Invite code</span>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="Ask the host for the invite code"
                  required
                  disabled={busy}
                />
              </label>
            </>
          )}
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p className="auth-hint">
          Friends-only room. If you don't have an invite code, ask the host.
        </p>
      </div>
    </div>
  );
}
