import { useState } from 'react';
import type { ClientMessage, RoomPlayer, RoomStateMessage } from '../net/messages';

// Presentation-only lobby: reads room state from the shared WebSocket (via
// props) and dispatches user actions back through `send`. Connection lives
// one level up in App.tsx so the same socket is reused for the game.

type Props = {
  roomState: RoomStateMessage;
  send: (msg: ClientMessage) => void;
  onLeaveRoom: () => void;
};

const TEAM_FOR_SEAT: Record<number, 'A' | 'B'> = { 0: 'A', 1: 'B', 2: 'A', 3: 'B' };

export default function RoomLobby({ roomState, send, onLeaveRoom }: Props) {
  const you = roomState.players.find((p) => p.username === roomState.you) ?? null;
  const seated = roomState.players.filter((p) => p.seatIdx !== null);
  const allReady = seated.length === 4 && seated.every((p) => p.isReady);

  return (
    <div className="lobby-screen">
      <div className="lobby-panel wide">
        <div className="lobby-head">
          <h1 className="auth-logo small">Bukhara</h1>
          <div className="lobby-code">
            <span className="lobby-code-label">Room code</span>
            <button
              className="lobby-code-value"
              type="button"
              onClick={() => navigator.clipboard.writeText(roomState.roomCode).catch(() => {})}
              title="Click to copy"
            >
              {roomState.roomCode.toUpperCase()}
            </button>
          </div>
          <button className="landing-signout" onClick={onLeaveRoom} type="button">
            Leave
          </button>
        </div>

        <p className="lobby-hint">
          Share the room code above with three friends. When all four seats are filled and everyone hits Ready, any player can start the game.
        </p>

        <div className="lobby-seats">
          {[0, 1, 2, 3].map((idx) => {
            const player = roomState.players.find((p) => p.seatIdx === idx) ?? null;
            return (
              <SeatCard
                key={idx}
                seatIdx={idx}
                player={player}
                isYou={player?.username === you?.username}
                canTake={you?.seatIdx === null}
                onTake={() => send({ type: 'take-seat', seatIdx: idx as 0 | 1 | 2 | 3 })}
                onAddBot={() => send({ type: 'add-bot', seatIdx: idx as 0 | 1 | 2 | 3 })}
                onRemoveBot={() => send({ type: 'remove-bot', seatIdx: idx as 0 | 1 | 2 | 3 })}
              />
            );
          })}
        </div>

        {you?.seatIdx !== null && you && (
          <YourControls
            you={you}
            allReady={allReady}
            waitingOn={seated.filter((p) => !p.isReady).map((p) => p.displayName)}
            onSetProfile={(dn, av) => send({ type: 'set-profile', displayName: dn, avatarUrl: av })}
            onLeaveSeat={() => send({ type: 'leave-seat' })}
            onToggleReady={() => send({ type: 'ready', ready: !you.isReady })}
            onStart={() => send({ type: 'start-game' })}
          />
        )}

        <div className="lobby-online">
          <span className="lobby-online-label">Also in this room</span>
          {roomState.players
            .filter((p) => p.seatIdx === null)
            .map((p) => (
              <span key={p.username} className={`lobby-online-name ${p.online ? '' : 'offline'}`}>
                {p.displayName}
              </span>
            ))}
          {roomState.players.filter((p) => p.seatIdx === null).length === 0 && (
            <em className="lobby-online-empty">Everyone's seated</em>
          )}
        </div>
      </div>
    </div>
  );
}

function SeatCard({
  seatIdx,
  player,
  isYou,
  canTake,
  onTake,
  onAddBot,
  onRemoveBot,
}: {
  seatIdx: number;
  player: RoomPlayer | null;
  isYou: boolean;
  canTake: boolean;
  onTake: () => void;
  onAddBot: () => void;
  onRemoveBot: () => void;
}) {
  const team = TEAM_FOR_SEAT[seatIdx];
  const initials = player?.displayName.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  return (
    <div className={`lobby-seat team-${team.toLowerCase()} ${isYou ? 'is-you' : ''} ${player?.isBot ? 'is-bot' : ''}`}>
      <div className="lobby-seat-label">
        <span>Seat {seatIdx + 1}</span>
        <span className="team-tag">Team {team}</span>
      </div>
      {player ? (
        <div className="lobby-seat-body">
          {player.isBot ? (
            <div className={`lobby-seat-avatar placeholder bot`}>◐</div>
          ) : player.avatarUrl ? (
            <img className="lobby-seat-avatar" src={player.avatarUrl} alt="" />
          ) : (
            <div className={`lobby-seat-avatar placeholder team-${team.toLowerCase()}`}>
              {initials}
            </div>
          )}
          <div className="lobby-seat-name">
            {player.displayName}
            {player.isBot && <span className="bot-tag">BOT</span>}
          </div>
          <div className="lobby-seat-status">
            {player.isReady ? '● Ready' : '○ Not ready'}
            {!player.online && ' · (offline)'}
          </div>
          {isYou && <div className="lobby-seat-you">You</div>}
          {player.isBot && (
            <button className="lobby-remove-bot" onClick={onRemoveBot} type="button">
              Remove bot
            </button>
          )}
        </div>
      ) : (
        <div className="lobby-empty-actions">
          <button
            className="lobby-seat-empty"
            disabled={!canTake}
            onClick={onTake}
            type="button"
          >
            {canTake ? 'Sit here' : 'Empty'}
          </button>
          <button
            className="lobby-seat-add-bot"
            onClick={onAddBot}
            type="button"
          >
            + Add bot
          </button>
        </div>
      )}
    </div>
  );
}

function YourControls({
  you,
  allReady,
  waitingOn,
  onSetProfile,
  onLeaveSeat,
  onToggleReady,
  onStart,
}: {
  you: RoomPlayer;
  allReady: boolean;
  waitingOn: string[];
  onSetProfile: (displayName?: string, avatarUrl?: string) => void;
  onLeaveSeat: () => void;
  onToggleReady: () => void;
  onStart: () => void;
}) {
  const [name, setName] = useState(you.displayName);
  const [uploading, setUploading] = useState(false);

  async function handleAvatarPick(file: File) {
    setUploading(true);
    try {
      const dataUrl = await resizeImage(file, 128);
      onSetProfile(undefined, dataUrl);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="your-controls">
      <div className="your-controls-row">
        <div className="control-block">
          <label className="control-label">Your display name</label>
          <div className="control-input-group">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
            />
            <button
              type="button"
              onClick={() => onSetProfile(name.trim(), undefined)}
              disabled={name.trim() === you.displayName}
            >
              Save
            </button>
          </div>
        </div>
        <div className="control-block">
          <label className="control-label">Profile picture</label>
          <label className="avatar-upload">
            {uploading ? 'Uploading…' : 'Choose image'}
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAvatarPick(f);
              }}
            />
          </label>
        </div>
      </div>
      <div className="your-controls-buttons">
        <button className="ghost" onClick={onLeaveSeat} type="button">Leave seat</button>
        <button
          className={you.isReady ? 'ready-on' : 'ready-off'}
          onClick={onToggleReady}
          type="button"
        >
          {you.isReady ? '● Ready' : '○ Ready up'}
        </button>
        <button
          className="start-btn"
          onClick={onStart}
          disabled={!allReady}
          type="button"
        >
          Start game
        </button>
      </div>
      {!allReady && (
        <div className="waiting-on">
          {waitingOn.length === 0
            ? 'Waiting for all four seats to fill…'
            : `Waiting on: ${waitingOn.join(', ')}`}
        </div>
      )}
    </div>
  );
}

// Resizes an image to fit inside `size` × `size` and returns a JPEG data URL.
function resizeImage(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image failed'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('no ctx'));
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s) / 2;
        const sy = (img.height - s) / 2;
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
