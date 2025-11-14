import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { createRoom, joinRoom, leaveRoom, getRoom, startGame, nextRound, submitAnswer, settleRound, setReady, allReady, setSettings } from './roomManager';
import { Choice, Room } from './types';

const PORT = Number(process.env.PORT || 4000);
const ROUND_MS = Number(process.env.ROUND_MS || 4000);
const INTERMISSION_MS = Number(process.env.INTERMISSION_MS || 1000);

const app = express();
app.use(cors());

app.get('/', (_req: express.Request, res: express.Response) => {
  res.json({ ok: true, service: 'chidiya-ud-server' });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

io.on('connection', (socket: import('socket.io').Socket) => {
  let roomCode: string | null = null;

  const emitRoomState = () => {
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (room) io.to(roomCode).emit('room:state', room);
  };

  socket.on('room:create', ({ name }: { name: string }) => {
    const room = createRoom(socket.id, name);
    roomCode = room.code;
    socket.join(room.code);
    socket.emit('room:state', room);
  });

  socket.on('room:join', ({ code, name }: { code: string; name: string }) => {
    const room = joinRoom(code, socket.id, name);
    if (!room) return socket.emit('room:error', { message: 'Unable to join room' });
    roomCode = code;
    socket.join(code);
    io.to(code).emit('player:joined', { player: room.players[socket.id] });
    emitRoomState();
  });

  socket.on('room:ready', ({ ready }: { ready: boolean }) => {
    if (!roomCode) return;
    const room = setReady(roomCode, socket.id, ready);
    if (!room) return;
    io.to(room.code).emit('room:state', room);
  });

  socket.on('room:leave', () => {
    if (!roomCode) return;
    const room = leaveRoom(roomCode, socket.id);
    socket.leave(roomCode);
    if (room) {
      io.to(room.code).emit('player:left', { playerId: socket.id });
      emitRoomState();
    }
    roomCode = null;
  });

  socket.on('game:start', () => {
    if (!roomCode) return;
    const now = Date.now();
    const current = getRoom(roomCode);
    const round = startGame(roomCode, now, current?.settings.roundMs ?? ROUND_MS, current?.settings.intermissionMs ?? INTERMISSION_MS);
    if (!round) return;
    io.to(roomCode).emit('game:started', {});

    const tickInterval = setInterval(() => {
      const r = getRoom(roomCode!);
      if (!r || r.status !== 'playing' || !r.round) return;
      io.to(roomCode!).emit('round:tick', { serverTs: Date.now(), deadlineTs: r.round.deadlineTs });
    }, 200);

    const runRoundCycle = () => {
      const r = getRoom(roomCode!);
      if (!r || r.status !== 'playing') return;
      if (!r.round) {
        const n = nextRound(r, Date.now(), r.settings.roundMs, r.settings.intermissionMs);
        io.to(roomCode!).emit('round:started', { round: n });
      } else {
        io.to(roomCode!).emit('round:started', { round: r.round });
      }

      setTimeout(() => {
        const room = getRoom(roomCode!);
        if (!room) return;
        const results = settleRound(room, Date.now());
        io.to(roomCode!).emit('round:results', results);
        io.to(roomCode!).emit('room:state', room);

        if (room.status === 'game_over') {
          io.to(roomCode!).emit('game:over', { winnerId: room.winnerId });
          clearInterval(tickInterval);
          return;
        }

        setTimeout(() => {
          const rr = getRoom(roomCode!);
          if (!rr) return;
          nextRound(rr, Date.now(), rr.settings.roundMs, rr.settings.intermissionMs);
          runRoundCycle();
        }, r.settings.intermissionMs);
      }, r.settings.roundMs);
    };

    runRoundCycle();
  });

  socket.on('round:answer', ({ choice }: { choice: Choice }) => {
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;
    submitAnswer(room as Room, socket.id, choice, Date.now());
  });

  socket.on('room:settings', (payload: { roundMs?: number; intermissionMs?: number }) => {
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;
    // only host can change settings
    if (room.hostId !== socket.id) return;
    const updated = setSettings(roomCode, payload);
    if (updated) io.to(roomCode).emit('room:state', updated);
  });

  socket.on('disconnect', () => {
    if (!roomCode) return;
    const room = leaveRoom(roomCode, socket.id);
    socket.leave(roomCode);
    if (room) {
      io.to(room.code).emit('player:left', { playerId: socket.id });
      io.to(room.code).emit('room:state', room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`chidiya-ud server on :${PORT}`);
});
