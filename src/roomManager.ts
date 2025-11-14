import { Room, Player, Choice, RoomSettings, RoundResultsSummary, RoundResultsDetail } from './types';
import { ITEMS } from './items';

const rooms = new Map<string, Room>();

const randomAvatar = () => {
  const emojis = ['🐥','🐯','🦊','🐼','🐵','🐸','🐶','🐱','🐰','🦁','🐨','🐷'];
  return emojis[Math.floor(Math.random() * emojis.length)];
};

export const generateRoomCode = () => {
  return Math.floor(10000 + Math.random() * 90000).toString(); // 5 digits
};

export const createRoom = (hostId: string, hostName: string): Room => {
  let code = generateRoomCode();
  while (rooms.has(code)) code = generateRoomCode();
  const player: Player = { id: hostId, name: hostName, avatar: randomAvatar(), ready: false, alive: true };
  const room: Room = {
    code,
    hostId,
    status: 'lobby',
    players: { [hostId]: player },
    settings: { roundMs: 4000, intermissionMs: 1000 }
  };
  rooms.set(code, room);
  return room;
};

export const joinRoom = (code: string, id: string, name: string): Room | null => {
  const room = rooms.get(code);
  if (!room) return null;
  if (room.status !== 'lobby') return null;
  room.players[id] = { id, name, avatar: randomAvatar(), ready: false, alive: true };
  return room;
};

export const leaveRoom = (code: string, id: string): Room | null => {
  const room = rooms.get(code);
  if (!room) return null;
  delete room.players[id];
  if (Object.keys(room.players).length === 0) {
    rooms.delete(code);
    return null;
  }
  if (room.hostId === id) {
    room.hostId = Object.keys(room.players)[0];
  }
  return room;
};

export const getRoom = (code: string) => rooms.get(code) || null;

export const listRooms = () => Array.from(rooms.values());

export const startGame = (code: string, now: number, roundMs: number, intermissionMs: number) => {
  const room = rooms.get(code);
  if (!room) return null;
  // all players in lobby must be ready
  const players = Object.values(room.players);
  if (room.status !== 'lobby') return null;
  if (!players.length) return null;
  if (!players.every(p => p.ready)) return null;
  room.status = 'playing';
  return nextRound(room, now, roundMs, intermissionMs);
};

export const nextRound = (room: Room, now: number, roundMs: number, _intermissionMs: number) => {
  const item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
  room.round = {
    itemId: item.id,
    itemText: item.text,
    itemImage: item.image,
    flies: item.flies,
    roundStartTs: now,
    deadlineTs: now + roundMs,
    responses: {}
  };
  // reset transient fields
  Object.values(room.players).forEach(p => { p.respondedAt = undefined; p.response = undefined; if (!p.alive) p.alive = false; });
  return room.round;
};

export const submitAnswer = (room: Room, playerId: string, choice: Choice, serverTs: number) => {
  if (!room.round) return false;
  const p = room.players[playerId];
  if (!p || !p.alive) return false;
  if (serverTs < room.round.roundStartTs) return false;
  if (serverTs > room.round.deadlineTs) return false;
  if (room.round.responses[playerId]) return false;
  room.round.responses[playerId] = choice;
  p.response = choice;
  p.respondedAt = serverTs;
  return true;
};

export const settleRound = (room: Room, serverTs: number) => {
  if (!room.round) return { eliminated: [], survivors: [], summary: { itemText: '', flies: false, perPlayer: {} as Record<string, RoundResultsDetail> } as RoundResultsSummary };
  const r = room.round;
  const eliminated: string[] = [];
  const survivors: string[] = [];
  const correct = r.flies ? 'ud' : 'not_ud';

  const perPlayer: Record<string, RoundResultsDetail> = {};

  Object.values(room.players).forEach(p => {
    // If player is already eliminated from an earlier round, do not overwrite their failure info
    if (!p.alive) {
      const resp = r.responses[p.id];
      perPlayer[p.id] = { choice: resp, correct: false, inTime: true };
      return;
    }
    const resp = r.responses[p.id];
    const ok = resp === correct;
    const inTime = (p.respondedAt ?? Infinity) <= r.deadlineTs;
    perPlayer[p.id] = { choice: resp, correct: !!resp && ok, inTime };
    if (!resp || !ok || !inTime) {
      p.alive = false;
      if (!p.failedAtWord) p.failedAtWord = r.itemText;
      if (!p.failedChoice) p.failedChoice = resp;
      eliminated.push(p.id);
    } else {
      survivors.push(p.id);
    }
  });

  const alive = Object.values(room.players).filter(p => p.alive);
  if (alive.length <= 1) {
    room.status = 'game_over';
    room.winnerId = alive[0]?.id;
  }
  const summary: RoundResultsSummary = { itemText: r.itemText, flies: r.flies, perPlayer };
  return { eliminated, survivors, summary };
};

export const setReady = (code: string, playerId: string, ready: boolean): Room | null => {
  const room = rooms.get(code);
  if (!room) return null;
  if (room.status !== 'lobby') return room; // ignore once started
  const p = room.players[playerId];
  if (p) p.ready = ready;
  return room;
};

export const allReady = (room: Room) => Object.values(room.players).every(p => p.ready);

export const setSettings = (code: string, updater: Partial<RoomSettings>): Room | null => {
  const room = rooms.get(code);
  if (!room) return null;
  if (room.status !== 'lobby') return room;
  const next: RoomSettings = { ...room.settings };
  if (typeof updater.roundMs === 'number') {
    // clamp between 500ms and 8000 ms
    next.roundMs = Math.max(500, Math.min(8000, Math.floor(updater.roundMs)));
  }
  if (typeof updater.intermissionMs === 'number') {
    next.intermissionMs = Math.max(500, Math.min(5000, Math.floor(updater.intermissionMs)));
  }
  room.settings = next;
  return room;
};

export const resetToLobby = (code: string): Room | null => {
  const room = rooms.get(code);
  if (!room) return null;
  room.status = 'lobby';
  room.round = undefined;
  room.winnerId = undefined;
  Object.values(room.players).forEach(p => {
    p.alive = true;
    p.ready = false;
    p.respondedAt = undefined;
    p.response = undefined;
    p.failedAtWord = undefined;
    p.failedChoice = undefined;
  });
  return room;
};
