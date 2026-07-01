// Wire protocol between client and server. Shared by src/ and party/.

import type { Game, PlayerId, SeqPos } from '../game/types';
import type {
  AddToSequenceInput,
  AddToTripletInput,
  DropMeldInput,
} from '../game/moves';

export type RoomPlayer = {
  username: string;
  displayName: string;
  seatIdx: number | null;
  avatarUrl: string | null;
  isReady: boolean;
  online: boolean;
  isBot: boolean;
};

export type RoomStateMessage = {
  type: 'room-state';
  players: RoomPlayer[];
  started: boolean;
  roomCode: string;
  you: string; // your username
};

export type GameStateMessage = {
  type: 'game-state';
  game: Game;                              // redacted: only your hand is populated
  handSizes: Record<0 | 1 | 2 | 3, number>; // true sizes for all four hands
  yourSeat: PlayerId | null;                // your seat, or null if you're a spectator
};

export type MoveRejectedMessage = {
  type: 'move-rejected';
  reason: string;
};

export type ServerMessage = RoomStateMessage | GameStateMessage | MoveRejectedMessage;

// ---- Client → server ---------------------------------------------------

export type LobbyMessage =
  | { type: 'set-profile'; displayName?: string; avatarUrl?: string }
  | { type: 'take-seat'; seatIdx: 0 | 1 | 2 | 3 }
  | { type: 'leave-seat' }
  | { type: 'ready'; ready: boolean }
  | { type: 'start-game' }
  | { type: 'add-bot'; seatIdx: 0 | 1 | 2 | 3 }
  | { type: 'remove-bot'; seatIdx: 0 | 1 | 2 | 3 };

export type MoveMessage =
  | { type: 'move-draw-stock' }
  | { type: 'move-pick-discard' }
  | { type: 'move-drop-meld'; input: DropMeldInput }
  | { type: 'move-add-to-sequence'; input: AddToSequenceInput }
  | { type: 'move-add-to-triplet'; input: AddToTripletInput }
  | { type: 'move-joker'; meldId: string; jokerCardId: string; newActingAs: SeqPos }
  | { type: 'move-discard'; cardId: string }
  | { type: 'next-match' };

export type ClientMessage = LobbyMessage | MoveMessage;
