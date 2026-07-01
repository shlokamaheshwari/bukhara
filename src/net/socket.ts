// Thin wrapper around partysocket. Callers subscribe to typed server
// messages; the sender takes typed client messages.

import PartySocket from 'partysocket';
import { getPartyHost } from './api';
import type { ClientMessage, ServerMessage } from './messages';

export type RoomHandle = {
  send: (msg: ClientMessage) => void;
  close: () => void;
};

export function connectToRoom(
  roomCode: string,
  token: string,
  onMessage: (msg: ServerMessage) => void,
  onOpen?: () => void,
  onError?: (msg: string) => void,
): RoomHandle {
  const host = getPartyHost();
  const socket = new PartySocket({
    host,
    room: roomCode.toLowerCase(),
    query: { token },
  });

  socket.addEventListener('open', () => onOpen?.());
  socket.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data) as ServerMessage;
      onMessage(msg);
    } catch {
      /* ignore malformed */
    }
  });
  socket.addEventListener('error', () => onError?.('Connection error'));

  return {
    send: (msg) => socket.send(JSON.stringify(msg)),
    close: () => socket.close(),
  };
}
