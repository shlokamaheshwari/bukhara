import { useEffect, useRef, useState } from 'react';
import AuthScreen from './screens/AuthScreen';
import LandingScreen from './screens/LandingScreen';
import RoomLobby from './screens/RoomLobby';
import GameScreen from './screens/GameScreen';
import { verify } from './net/api';
import { connectToRoom } from './net/socket';
import type {
  ClientMessage,
  GameStateMessage,
  RoomStateMessage,
} from './net/messages';
import './App.css';

// Applies "light" or "dark" to <html data-theme=...>. Persisted in localStorage.
type Theme = 'light' | 'dark';
const THEME_KEY = 'bhukara-theme';

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    // Default to system preference on first load.
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))];
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      aria-label="Toggle theme"
      type="button"
    >
      {theme === 'light' ? '☾' : '☀'}
    </button>
  );
}

// Top-level router + persistent WebSocket connection.
// Screens:
//   1. no auth               → AuthScreen
//   2. auth, no room         → LandingScreen
//   3. auth + room, waiting  → RoomLobby
//   4. auth + room, started  → GameScreen (server-authoritative)

type Auth = { token: string; username: string; displayName: string };

const AUTH_STORAGE_KEY = 'bhukara-auth';

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [auth, setAuth] = useState<Auth | null>(null);
  const [checking, setChecking] = useState(true);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomState, setRoomState] = useState<RoomStateMessage | null>(null);
  const [gameState, setGameState] = useState<GameStateMessage | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [reactions, setReactions] = useState<
    Array<{ id: number; emoji: string; from: string; seat: number | null }>
  >([]);
  const sendRef = useRef<((msg: ClientMessage) => void) | null>(null);

  // Verify a saved token on first load.
  useEffect(() => {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) { setChecking(false); return; }
    try {
      const parsed = JSON.parse(raw) as Auth;
      verify(parsed.token).then((res) => {
        if (res.valid) setAuth(parsed);
        else localStorage.removeItem(AUTH_STORAGE_KEY);
        setChecking(false);
      }).catch(() => {
        // Server unreachable — optimistically keep the token; the connection
        // attempt will fail if it's actually invalid.
        setAuth(parsed);
        setChecking(false);
      });
    } catch {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      setChecking(false);
    }
  }, []);

  // Open one WebSocket per (auth × room). All server messages route here.
  useEffect(() => {
    if (!auth || !roomCode) return;
    setRoomState(null);
    setGameState(null);
    setMoveError(null);
    const { send, close } = connectToRoom(roomCode, auth.token, (msg) => {
      if (msg.type === 'room-state') setRoomState(msg);
      else if (msg.type === 'game-state') setGameState(msg);
      else if (msg.type === 'move-rejected') setMoveError(msg.reason);
      else if (msg.type === 'reaction') {
        const id = Date.now() + Math.floor(Math.random() * 10000);
        setReactions((r) => [...r, { id, emoji: msg.emoji, from: msg.fromDisplayName, seat: msg.fromSeat }]);
        // Auto-expire after 3s so the layer stays clean.
        setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 3000);
      }
    });
    sendRef.current = send;
    return () => {
      close();
      sendRef.current = null;
    };
  }, [auth, roomCode]);

  function send(msg: ClientMessage) {
    sendRef.current?.(msg);
  }

  function onAuthed(a: Auth) { setAuth(a); }
  function onSignOut() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    setAuth(null);
    setRoomCode(null);
    setRoomState(null);
    setGameState(null);
  }
  function onEnterRoom(code: string) { setRoomCode(code); }
  function onLeaveRoom() {
    setRoomCode(null);
    setRoomState(null);
    setGameState(null);
    setMoveError(null);
  }

  // Every screen carries the theme toggle in the top-right corner.
  const toggle = <ThemeToggle theme={theme} onToggle={toggleTheme} />;

  // Reactions overlay floats over every screen once we're connected.
  const reactionsLayer = (
    <>
      <div className="reactions-layer">
        {reactions.map((r) => (
          <div key={r.id} className="reaction-float">
            <span className="reaction-emoji">{r.emoji}</span>
            <span className="reaction-from">{r.from}</span>
          </div>
        ))}
      </div>
      {roomState && (
        <ReactionBar send={send} />
      )}
    </>
  );

  if (checking) {
    return <>{toggle}<div className="loading-screen"><div className="loading-inner">Loading…</div></div></>;
  }
  if (!auth) return <>{toggle}<AuthScreen onAuthed={onAuthed} /></>;
  if (!roomCode) {
    return (
      <>
        {toggle}
        <LandingScreen
          displayName={auth.displayName}
          onEnterRoom={onEnterRoom}
          onSignOut={onSignOut}
        />
      </>
    );
  }
  if (!roomState) {
    return <>{toggle}<div className="loading-screen"><div className="loading-inner">Joining room…</div></div></>;
  }
  if (!roomState.started) {
    return (
      <>
        {toggle}
        {reactionsLayer}
        <RoomLobby
          roomState={roomState}
          send={send}
          onLeaveRoom={onLeaveRoom}
        />
      </>
    );
  }
  if (!gameState) {
    return <>{toggle}<div className="loading-screen"><div className="loading-inner">Dealing…</div></div></>;
  }
  return (
    <>
      {toggle}
      {reactionsLayer}
      <GameScreen
        netGame={gameState.game}
        netHandSizes={gameState.handSizes}
        netYourSeat={gameState.yourSeat ?? 0}
        netSend={(msg) => { setMoveError(null); send(msg); }}
        netMoveError={moveError}
        onExit={onLeaveRoom}
      />
    </>
  );
}

function ReactionBar({ send }: { send: (msg: ClientMessage) => void }) {
  const [open, setOpen] = useState(false);
  const emojis = ['👏', '😂', '🎉', '👍', '❤️', '🔥', '🤯', '😢'];
  return (
    <div className={`reaction-bar ${open ? 'open' : ''}`}>
      {open && emojis.map((e) => (
        <button
          key={e}
          className="reaction-btn"
          onClick={() => {
            send({ type: 'react', emoji: e });
            setOpen(false);
          }}
          type="button"
          aria-label={`React with ${e}`}
        >
          {e}
        </button>
      ))}
      <button
        className="reaction-toggle"
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-label={open ? 'Close reactions' : 'Open reactions'}
        title={open ? 'Close reactions' : 'Send a reaction'}
      >
        {open ? '×' : '😀'}
      </button>
    </div>
  );
}
