import React, { useEffect, useRef, useState } from 'react';
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

// Two dimensions:
//   pack — which visual pack (Editorial mountains vs House of the Dragon)
//   mode — light or dark within that pack
// The composite value drives the html data-theme attribute. Legacy values
// "light" and "dark" are treated as editorial-light / editorial-dark for
// backward compatibility with saved preferences.
type ThemePack = 'editorial' | 'hotd' | 'terminal';
type ThemeMode = 'light' | 'dark';
const THEME_PACK_KEY = 'bhukara-theme-pack';
const THEME_MODE_KEY = 'bhukara-theme-mode';
const LEGACY_THEME_KEY = 'bhukara-theme';

const PACK_ORDER: ThemePack[] = ['editorial', 'hotd', 'terminal'];

function themeAttr(pack: ThemePack, mode: ThemeMode): string {
  return pack === 'editorial' ? mode : `${pack}-${mode}`;
}

function useTheme(): {
  pack: ThemePack;
  mode: ThemeMode;
  toggleMode: () => void;
  togglePack: () => void;
} {
  const [pack, setPack] = useState<ThemePack>(() => {
    if (typeof window === 'undefined') return 'editorial';
    const saved = localStorage.getItem(THEME_PACK_KEY);
    if (saved === 'hotd' || saved === 'terminal' || saved === 'editorial') return saved;
    return 'editorial';
  });
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = localStorage.getItem(THEME_MODE_KEY) ?? localStorage.getItem(LEGACY_THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeAttr(pack, mode));
    localStorage.setItem(THEME_PACK_KEY, pack);
    localStorage.setItem(THEME_MODE_KEY, mode);
  }, [pack, mode]);
  return {
    pack,
    mode,
    toggleMode: () => setMode((m) => (m === 'light' ? 'dark' : 'light')),
    togglePack: () => setPack((p) => {
      const i = PACK_ORDER.indexOf(p);
      return PACK_ORDER[(i + 1) % PACK_ORDER.length];
    }),
  };
}

function ThemeToggles({
  pack, mode, onToggleMode, onTogglePack,
}: {
  pack: ThemePack;
  mode: ThemeMode;
  onToggleMode: () => void;
  onTogglePack: () => void;
}) {
  const packMeta: Record<ThemePack, { label: string; icon: string; short: string }> = {
    editorial: { label: 'Editorial', icon: '⛰', short: 'Editorial' },
    hotd: { label: 'House of the Dragon', icon: '🐉', short: 'HotD' },
    terminal: { label: 'Terminal', icon: '▊', short: 'Terminal' },
  };
  const nextIdx = (PACK_ORDER.indexOf(pack) + 1) % PACK_ORDER.length;
  const nextLabel = packMeta[PACK_ORDER[nextIdx]].label;
  const current = packMeta[pack];
  return (
    <div className="theme-controls">
      <button
        className="theme-pack-toggle"
        onClick={onTogglePack}
        title={`Switch to ${nextLabel}`}
        aria-label={`Current theme ${current.label}. Click to switch.`}
        type="button"
      >
        {current.icon}
        <span className="theme-pack-label">{current.short}</span>
      </button>
      <button
        className="theme-toggle"
        onClick={onToggleMode}
        title={mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        aria-label="Toggle light/dark mode"
        type="button"
      >
        {mode === 'light' ? '☾' : '☀'}
      </button>
    </div>
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

// Terminal ambient chrome — a fake file tree pinned to the left and a
// looping log strip at the very bottom. Purely decorative, zero
// interaction. Rendered only when the Terminal pack is active.
function TerminalChrome() {
  return (
    <div className="terminal-chrome" aria-hidden="true">
      <aside className="terminal-tree">
        <div className="terminal-tree-title">bukhara ▶ src</div>
        <ul>
          <li className="tt-folder">game</li>
          <li className="tt-file">moves.ts</li>
          <li className="tt-file">bot.ts</li>
          <li className="tt-file">newGame.ts</li>
          <li className="tt-file">scoring.ts</li>
          <li className="tt-file">types.ts</li>
          <li className="tt-folder">screens</li>
          <li className="tt-file active">GameScreen.tsx</li>
          <li className="tt-file">LobbyScreen.tsx</li>
          <li className="tt-folder">ui</li>
          <li className="tt-file">Card.tsx</li>
          <li className="tt-file">App.tsx</li>
          <li className="tt-file">App.css</li>
          <li className="tt-folder closed">party</li>
        </ul>
      </aside>
      <div className="terminal-log">
        <div className="terminal-log-inner">
          <div className="terminal-log-line"><span className="tag info">INFO</span>server: room BUKHARA26 online</div>
          <div className="terminal-log-line"><span className="tag ok">OK</span>auth: shloka connected</div>
          <div className="terminal-log-line"><span className="tag dbg">DBG</span>engine: match 3 started</div>
          <div className="terminal-log-line"><span className="tag info">INFO</span>bot: Bot 2 drew from deck</div>
          <div className="terminal-log-line"><span className="tag ok">OK</span>meld: pure sequence dropped (♠, 45pt)</div>
          <div className="terminal-log-line"><span className="tag info">INFO</span>bot: Bot 3 discarded 9♥</div>
          <div className="terminal-log-line"><span className="tag warn">WARN</span>scoring: first_drop &lt; 100 pts</div>
          <div className="terminal-log-line"><span className="tag ok">OK</span>meld: extended sequence → 7 cards</div>
          <div className="terminal-log-line"><span className="tag dbg">DBG</span>engine: turn advance → seat 1</div>
          <div className="terminal-log-line"><span className="tag info">INFO</span>chat: &lt;Bot 4&gt; nice play</div>
          <div className="terminal-log-line"><span className="tag ok">OK</span>bukhara: pile claimed by seat 2</div>
          <div className="terminal-log-line"><span className="tag info">INFO</span>bot: Bot 2 selected trip Q</div>
          <div className="terminal-log-line"><span className="tag dbg">DBG</span>engine: sequenceBox.push(seq_45)</div>
          <div className="terminal-log-line"><span className="tag ok">OK</span>meld: ganastha reached (7 cards)</div>
          <div className="terminal-log-line"><span className="tag info">INFO</span>net: broadcast state (rev 214)</div>
          <div className="terminal-log-line"><span className="tag warn">WARN</span>discard: card not in hand</div>
          <div className="terminal-log-line"><span className="tag info">INFO</span>server: room BUKHARA26 online</div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { pack, mode, toggleMode, togglePack } = useTheme();
  const terminalChrome = pack === 'terminal' ? <TerminalChrome /> : null;
  const [auth, setAuth] = useState<Auth | null>(null);
  const [checking, setChecking] = useState(true);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomState, setRoomState] = useState<RoomStateMessage | null>(null);
  const [gameState, setGameState] = useState<GameStateMessage | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [reactions, setReactions] = useState<
    Array<{ id: number; emoji: string; from: string; seat: number | null }>
  >([]);
  const [chatLog, setChatLog] = useState<
    Array<{ id: string; text: string; from: string; seat: number | null; at: number; mine: boolean }>
  >([]);
  const [chatUnread, setChatUnread] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
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
      else if (msg.type === 'chat-message') {
        const mine = auth ? msg.fromUsername === auth.username : false;
        setChatLog((log) => [...log.slice(-99), {
          id: msg.id,
          text: msg.text,
          from: msg.fromDisplayName,
          seat: msg.fromSeat,
          at: msg.at,
          mine,
        }]);
        if (!mine) setChatUnread((n) => n + 1);
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
  const toggle = (
    <ThemeToggles
      pack={pack}
      mode={mode}
      onToggleMode={toggleMode}
      onTogglePack={togglePack}
    />
  );

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
        <>
          <ReactionBar send={send} />
          <ChatPanel
            send={send}
            log={chatLog}
            open={chatOpen}
            unread={chatUnread}
            onToggle={() => {
              setChatOpen((v) => {
                const next = !v;
                if (next) setChatUnread(0);
                return next;
              });
            }}
          />
        </>
      )}
    </>
  );

  if (checking) {
    return <>{terminalChrome}{toggle}<div className="loading-screen"><div className="loading-inner">Loading…</div></div></>;
  }
  if (!auth) return <>{terminalChrome}{toggle}<AuthScreen onAuthed={onAuthed} /></>;
  if (!roomCode) {
    return (
      <>
        {terminalChrome}
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
    return <>{terminalChrome}{toggle}<div className="loading-screen"><div className="loading-inner">Joining room…</div></div></>;
  }
  if (!roomState.started) {
    return (
      <>
        {terminalChrome}
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
    return <>{terminalChrome}{toggle}<div className="loading-screen"><div className="loading-inner">Dealing…</div></div></>;
  }
  // In-game we drop the floating theme buttons — GameScreen renders its own
  // theme controls inline in the topbar (guaranteed visible over the table).
  return (
    <>
      {terminalChrome}
      {reactionsLayer}
      <GameScreen
        themePack={pack}
        themeMode={mode}
        onToggleThemePack={togglePack}
        onToggleThemeMode={toggleMode}
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

function ChatPanel({
  send, log, open, unread, onToggle,
}: {
  send: (msg: ClientMessage) => void;
  log: Array<{ id: string; text: string; from: string; seat: number | null; at: number; mine: boolean }>;
  open: boolean;
  unread: number;
  onToggle: () => void;
}) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  // Autoscroll to the bottom whenever a new message arrives or the panel opens.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, log.length]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    send({ type: 'chat', text });
    setDraft('');
  }

  return (
    <div className={`chat-panel ${open ? 'open' : ''}`}>
      {open && (
        <div className="chat-panel-inner">
          <div className="chat-panel-header">
            <span>Table chat</span>
            <button type="button" className="chat-close" onClick={onToggle} aria-label="Close chat">×</button>
          </div>
          <div className="chat-log" ref={listRef}>
            {log.length === 0 && <div className="chat-empty">No messages yet — say hi.</div>}
            {log.map((m) => (
              <div key={m.id} className={`chat-msg ${m.mine ? 'mine' : ''}`}>
                {!m.mine && <div className="chat-from">{m.from}</div>}
                <div className="chat-bubble">{m.text}</div>
              </div>
            ))}
          </div>
          <form className="chat-form" onSubmit={onSubmit}>
            <input
              type="text"
              className="chat-input"
              placeholder="Type a message…"
              value={draft}
              maxLength={500}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              autoCapitalize="sentences"
            />
            <button type="submit" className="chat-send" disabled={!draft.trim()}>Send</button>
          </form>
        </div>
      )}
      <button
        className="chat-toggle"
        type="button"
        onClick={onToggle}
        aria-label={open ? 'Close chat' : 'Open chat'}
        title={open ? 'Close chat' : 'Open chat'}
      >
        {open ? '×' : '💬'}
        {!open && unread > 0 && <span className="chat-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
    </div>
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
