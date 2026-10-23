import { randomBytes, randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";

const MAX_PARTICIPANTS = 6;
const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOM_MESSAGES = 80;
const ROOM_CODE_BYTES = 6;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

type PlaybackState = {
  isPlaying: boolean;
  currentTime: number;
  updatedAt: number;
};

type Participant = {
  id: string;
  nickname: string;
  microphoneEnabled: boolean;
};

type ChatMessage = {
  id: string;
  nickname: string;
  text: string;
  createdAt: number;
};

type Room = {
  roomId: string;
  videoUrl: string | null;
  playback: PlaybackState;
  participants: Map<string, Participant>;
  messages: ChatMessage[];
};

type RoomSnapshot = {
  roomId: string;
  videoUrl: string | null;
  playback: PlaybackState;
  participants: Participant[];
  messages: ChatMessage[];
};

type JoinResult = {
  ok: boolean;
  roomId?: string;
  room?: RoomSnapshot;
  error?: string;
};

const rooms = new Map<string, Room>();
const emptyRoomTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelEmptyRoomCleanup(roomId: string): void {
  const timer = emptyRoomTimers.get(roomId);
  if (!timer) return;
  clearTimeout(timer);
  emptyRoomTimers.delete(roomId);
}

function scheduleEmptyRoomCleanup(room: Room): void {
  cancelEmptyRoomCleanup(room.roomId);
  const timer = setTimeout(() => {
    emptyRoomTimers.delete(room.roomId);
    const currentRoom = rooms.get(room.roomId);
    if (currentRoom === room && currentRoom.participants.size === 0) {
      rooms.delete(room.roomId);
    }
  }, EMPTY_ROOM_TTL_MS);
  timer.unref?.();
  emptyRoomTimers.set(room.roomId, timer);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function cleanNickname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const nickname = value.trim().replace(/\s+/g, " ").slice(0, 24);
  return nickname.length > 0 ? nickname : null;
}

function isShareableVideoUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;

  try {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const localDev = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    return (
      (secure || localDev) &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function snapshot(room: Room): RoomSnapshot {
  return {
    roomId: room.roomId,
    videoUrl: room.videoUrl,
    playback: { ...room.playback },
    participants: [...room.participants.values()].map((person) => ({ ...person })),
    messages: room.messages.map((message) => ({ ...message })),
  };
}

function emitRoomState(io: Server, room: Room, exceptSocketId?: string): void {
  const roomIo = exceptSocketId ? io.to(room.roomId).except(exceptSocketId) : io.to(room.roomId);
  roomIo.emit("room:state", snapshot(room));
}

function leaveRoom(io: Server, socket: Socket): void {
  const roomId = socket.data.roomId as string | undefined;
  if (!roomId) return;

  const room = rooms.get(roomId);
  socket.leave(roomId);
  delete socket.data.roomId;

  if (!room) return;
  room.participants.delete(socket.id);

  if (room.participants.size === 0) {
    scheduleEmptyRoomCleanup(room);
    return;
  }

  emitRoomState(io, room);
}

function joinRoom(
  io: Server,
  socket: Socket,
  roomIdInput: unknown,
  nicknameInput: unknown,
): JoinResult {
  const roomId =
    typeof roomIdInput === "string" ? roomIdInput.trim().toLowerCase() : "";
  const nickname = cleanNickname(nicknameInput);
  const room = rooms.get(roomId);

  if (!/^[a-f0-9]{12}$/.test(roomId) || !room) {
    return { ok: false, error: "Bu oda bulunamadı. Yeni bir oda oluşturabilirsin." };
  }
  if (!nickname) {
    return { ok: false, error: "Devam etmek için bir takma ad yaz." };
  }
  cancelEmptyRoomCleanup(roomId);
  if (socket.data.roomId === roomId && room.participants.has(socket.id)) {
    const participant = room.participants.get(socket.id)!;
    participant.nickname = nickname;
    socket.data.nickname = nickname;
    return { ok: true, roomId, room: snapshot(room) };
  }
  if (!room.participants.has(socket.id) && room.participants.size >= MAX_PARTICIPANTS) {
    return { ok: false, error: "Oda dolu. En fazla 6 kişi katılabilir." };
  }

  leaveRoom(io, socket);
  const existingParticipants = [...room.participants.values()];
  const participant: Participant = {
    id: socket.id,
    nickname,
    microphoneEnabled: false,
  };
  room.participants.set(socket.id, participant);
  socket.data.roomId = roomId;
  socket.data.nickname = nickname;
  void socket.join(roomId);

  for (const existing of existingParticipants) {
    io.to(existing.id).emit("room:peer-joined", {
      peerId: participant.id,
      nickname: participant.nickname,
    });
  }
  emitRoomState(io, room, socket.id);

  return { ok: true, roomId, room: snapshot(room) };
}

function newRoomId(): string {
  let roomId = randomBytes(ROOM_CODE_BYTES).toString("hex");
  while (rooms.has(roomId)) {
    roomId = randomBytes(ROOM_CODE_BYTES).toString("hex");
  }
  return roomId;
}

export function attachRoomServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: "/api/socket.io",
    cors: {
      origin: true,
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 100_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.on("connection", (socket) => {
    socket.on(
      "room:create",
      (payload: unknown, acknowledge?: (result: JoinResult) => void) => {
        const input = asRecord(payload);
        const nickname = cleanNickname(input.nickname);
        if (!nickname) {
          acknowledge?.({ ok: false, error: "Devam etmek için bir takma ad yaz." });
          return;
        }

        const roomId = newRoomId();
        rooms.set(roomId, {
          roomId,
          videoUrl: null,
          playback: { isPlaying: false, currentTime: 0, updatedAt: Date.now() },
          participants: new Map(),
          messages: [],
        });
        const result = joinRoom(io, socket, roomId, nickname);
        acknowledge?.(result);
      },
    );

    socket.on(
      "room:join",
      (payload: unknown, acknowledge?: (result: JoinResult) => void) => {
        const input = asRecord(payload);
        acknowledge?.(joinRoom(io, socket, input.roomId, input.nickname));
      },
    );

    socket.on("room:set-video", (payload: unknown) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room) return;

      const input = asRecord(payload);
      const videoUrl =
        input.videoUrl === null ||
        (typeof input.videoUrl === "string" && input.videoUrl.trim() === "")
          ? null
          : input.videoUrl;
      if (videoUrl !== null && !isShareableVideoUrl(videoUrl)) {
        socket.emit("room:error", {
          message: "Salona HTTPS bağlantısı veya yerel geliştirme için localhost bağlantısı eklenebilir.",
        });
        return;
      }

      room.videoUrl = videoUrl;
      room.playback = { isPlaying: false, currentTime: 0, updatedAt: Date.now() };
      io.to(roomId!).emit("room:video", { videoUrl: room.videoUrl });
      io.to(roomId!).emit("room:playback", { ...room.playback });
    });

    socket.on("room:set-playback", (payload: unknown) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      const input = asRecord(payload);
      if (
        !room ||
        typeof input.isPlaying !== "boolean" ||
        typeof input.currentTime !== "number" ||
        !Number.isFinite(input.currentTime) ||
        input.currentTime < 0
      ) {
        return;
      }

      room.playback = {
        isPlaying: input.isPlaying,
        currentTime: Math.min(input.currentTime, 100_000_000),
        updatedAt: Date.now(),
      };
      io.to(roomId!).emit("room:playback", { ...room.playback });
    });

    socket.on("room:chat", (payload: unknown) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      const nickname = cleanNickname(socket.data.nickname);
      const input = asRecord(payload);
      if (!room || !nickname || typeof input.text !== "string") return;

      const text = input.text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) return;
      const message: ChatMessage = {
        id: randomUUID(),
        nickname,
        text,
        createdAt: Date.now(),
      };
      room.messages.push(message);
      if (room.messages.length > MAX_ROOM_MESSAGES) {
        room.messages.splice(0, room.messages.length - MAX_ROOM_MESSAGES);
      }
      io.to(roomId!).emit("room:message", message);
    });

    socket.on("room:set-mic", (payload: unknown) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      const input = asRecord(payload);
      const participant = room?.participants.get(socket.id);
      if (!room || !participant || typeof input.enabled !== "boolean") return;
      participant.microphoneEnabled = input.enabled;
      emitRoomState(io, room);
    });

    socket.on("voice:signal", (payload: unknown) => {
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      const input = asRecord(payload);
      if (
        !room ||
        typeof input.to !== "string" ||
        !room.participants.has(input.to) ||
        input.to === socket.id ||
        !("signal" in input)
      ) {
        return;
      }

      let serialized: string;
      try {
        serialized = JSON.stringify(input.signal);
      } catch {
        return;
      }
      if (serialized.length > 32_000) return;
      io.to(input.to).emit("voice:signal", { from: socket.id, signal: input.signal });
    });

    socket.on("room:leave", () => leaveRoom(io, socket));
    socket.on("disconnect", () => leaveRoom(io, socket));
  });

  return io;
}
