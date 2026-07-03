import { useState } from 'react';

// Post-login screen. User either creates a new room (we generate a 6-char code
// they share with friends) or joins an existing one by entering the code.

function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (const n of arr) code += alphabet[n % alphabet.length];
  return code;
}

export default function LandingScreen({
  displayName,
  onEnterRoom,
  onSignOut,
  errorMessage,
  onDismissError,
}: {
  displayName: string;
  onEnterRoom: (roomCode: string) => void;
  onSignOut: () => void;
  errorMessage?: string | null;
  onDismissError?: () => void;
}) {
  const [joinCode, setJoinCode] = useState('');
  return (
    <div className="landing-screen">
      <div className="landing-panel">
        <h1 className="auth-logo">Bukhara</h1>
        <p className="landing-greet">Welcome, <strong>{displayName}</strong></p>
        {errorMessage && (
          <div className="landing-error" role="alert">
            <span>{errorMessage}</span>
            <button
              type="button"
              className="landing-error-dismiss"
              onClick={onDismissError}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        <button
          className="landing-primary"
          onClick={() => onEnterRoom(makeRoomCode())}
          type="button"
        >
          Create a new table
        </button>

        <div className="landing-or">or join</div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const code = joinCode.trim().toUpperCase();
            if (code.length === 6) onEnterRoom(code);
          }}
          className="landing-join"
        >
          <input
            type="text"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="ROOM CODE"
            maxLength={6}
            autoCapitalize="characters"
          />
          <button type="submit" disabled={joinCode.trim().length !== 6}>
            Join
          </button>
        </form>

        <button className="landing-signout" onClick={onSignOut} type="button">
          Sign out
        </button>
      </div>
    </div>
  );
}
