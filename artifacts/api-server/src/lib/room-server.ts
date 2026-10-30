import { randomBytes, randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { getAdminSettings } from "./admin-store";

const MAX_PARTICIPANTS = 6;
const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOM_MESSAGES = 80;
const ROOM_CODE_BYTES = 6;
// Empty rooms are removed after the configurable grace period (default: 120 seconds).

type PlaybackState = {
  isPlaying: boolean;
  currentTime: number;
  updatedAt: number;
};

type Participant = {
  id: string;
  nickname: string;
  microphoneEnabled: boolean;
  ipAddress: string;
  deviceInfo: string;
  userAgent: string;
  joinedAt: number;
};

type PublicParticipant = Pick<Participant, "id" | "nickname" | "microphoneEnabled">;
type AdminParticipant = Participant;

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
  participants: PublicParticipant[];
  messages: ChatMessage[];
};

type AdminRoomSnapshot = Omit<RoomSnapshot, "participants"> & { participants: AdminParticipant[] };

type JoinResult = {
  ok: boolean;
  roomId?: string;
  room?: RoomSnapshot;
  error?: string;
};

const rooms = new Map<string, Room>();
let roomIo: Server | undefined;
const emptyRoomTimers = new Map<string, ReturnType<typeof setTimeout>>();
const adminAudioTickets = new Map<string, { roomId?: string; purpose: "audio" | "live"; expiresAt: number }>();
const adminAudioConsent = new Map<string, Set<string>>();

/** Create a short-lived, single-use ticket only after the REST admin route has authenticated. */
export function createAdminAudioTicket(roomId: string): string | null {
  if (!rooms.has(roomId)) return null;
  const now = Date.now();
  for (const [ticket, value] of adminAudioTickets) if (value.expiresAt <= now) adminAudioTickets.delete(ticket);
  const ticket = randomBytes(32).toString("hex");
  adminAudioTickets.set(ticket, { roomId, purpose: "audio", expiresAt: now + 60_000 });
  return ticket;
}

export function createAdminLiveTicket(): string {
  const now = Date.now();
  for (const [ticket, value] of adminAudioTickets) if (value.expiresAt <= now) adminAudioTickets.delete(ticket);
  const ticket = randomBytes(32).toString("hex");
  adminAudioTickets.set(ticket, { purpose: "live", expiresAt: now + 60_000 });
  return ticket;
}

function cancelEmptyRoomCleanup(roomId: string): void {
  const timer = emptyRoomTimers.get(roomId);
  if (!timer) return;
  clearTimeout(timer);
  emptyRoomTimers.delete(roomId);
}

function scheduleEmptyRoomCleanup(room: Room): void {
  cancelEmptyRoomCleanup(room.roomId);
  void getAdminSettings().then((settings) => {
    // The room may have been rejoined while settings were loading.
    if (rooms.get(room.roomId) !== room || room.participants.size !== 0) return;
    const timer = setTimeout(() => {
      emptyRoomTimers.delete(room.roomId);
      const currentRoom = rooms.get(room.roomId);
      if (currentRoom === room && currentRoom.participants.size === 0) {
        rooms.delete(room.roomId);
        if (roomIo) emitAdminRoomUpdates(roomIo);
      }
    }, settings.emptyRoomTimeoutSeconds * 1000);
    timer.unref?.();
    emptyRoomTimers.set(room.roomId, timer);
  }).catch(() => undefined);
}

export function refreshEmptyRoomCleanupTimers(): void {
  for (const [roomId, timer] of emptyRoomTimers) {
    clearTimeout(timer);
    emptyRoomTimers.delete(roomId);
  }
  for (const room of rooms.values()) {
    if (room.participants.size === 0) scheduleEmptyRoomCleanup(room);
  }
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

export function getAdminRoomSnapshots(): AdminRoomSnapshot[] {
  // Keep network/device metadata exclusively in the admin API. The public room snapshot
  // deliberately strips these fields so they are never broadcast to other participants.
  return [...rooms.values()].map((room) => ({
    roomId: room.roomId,
    videoUrl: room.videoUrl,
    playback: { ...room.playback },
    participants: [...room.participants.values()].map((person) => ({ ...person })),
    messages: room.messages.map((message) => ({ ...message })),
  }));
}

function emitAdminRoomUpdates(io: Server): void {
  io.to("admin:live").emit("admin:rooms-update", getAdminRoomSnapshots().map((room) => ({
    roomId: room.roomId, videoUrl: room.videoUrl, playback: room.playback,
    participantCount: room.participants.length, participants: room.participants,
    messages: room.messages.slice(-80), messageCount: room.messages.length,
    lastActivityAt: Math.max(room.playback.updatedAt, ...room.messages.map((message) => message.createdAt), 0),
  })));
}

export function adminDisconnectParticipant(roomId: string, socketId: string): boolean {
  const room = rooms.get(roomId);
  if (!room || !roomIo || !room.participants.has(socketId)) return false;
  const socket = roomIo.sockets.sockets.get(socketId);
  if (!socket) return false;
  socket.disconnect(true);
  return true;
}

function snapshot(room: Room): RoomSnapshot {
  return {
    roomId: room.roomId,
    videoUrl: room.videoUrl,
    playback: { ...room.playback },
    participants: [...room.participants.values()].map(({ id, nickname, microphoneEnabled }) => ({ id, nickname, microphoneEnabled })),
    messages: room.messages.map((message) => ({ ...message })),
  };
}

function emitRoomState(io: Server, room: Room, exceptSocketId?: string): void {
  const roomIo = exceptSocketId ? io.to(room.roomId).except(exceptSocketId) : io.to(room.roomId);
  roomIo.emit("room:state", snapshot(room));
  emitAdminRoomUpdates(io);
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
    emitAdminRoomUpdates(io);
    return;
  }

  emitRoomState(io, room);
}

function describeDevice(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  const device = /ipad|tablet/.test(ua) ? "Tablet" : /mobile|iphone|ipod|android/.test(ua) ? "Mobil" : "Masaüstü";
  const browser = /edg\//.test(ua) ? "Microsoft Edge" : /opr\//.test(ua) ? "Opera" : /firefox\//.test(ua) ? "Firefox" : /chrome\//.test(ua) && !/edg\//.test(ua) ? "Chrome" : /safari\//.test(ua) && !/chrome\//.test(ua) ? "Safari" : "Bilinmeyen tarayıcı";
  const os = /android/.test(ua) ? "Android" : /iphone|ipad|ipod/.test(ua) ? "iOS/iPadOS" : /windows/.test(ua) ? "Windows" : /mac os|macintosh/.test(ua) ? "macOS" : /linux/.test(ua) ? "Linux" : "Bilinmeyen sistem";
  return `${device} · ${os} · ${browser}`;
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
  const headers = socket.handshake.headers;
  const forwardedFor = headers["x-forwarded-for"];
  const cloudflareIp = headers["cf-connecting-ip"];
  const headerIp = typeof cloudflareIp === "string" ? cloudflareIp.trim()
    : typeof forwardedFor === "string" ? forwardedFor.split(",")[0].trim()
    : Array.isArray(forwardedFor) ? String(forwardedFor[0] || "").split(",")[0].trim() : "";
  const remoteIp = socket.handshake.address || "unknown";
  const ipAddress = (headerIp || remoteIp).replace(/^::ffff:/, "").slice(0, 64);
  const userAgent = String(headers["user-agent"] || "Bilinmeyen tarayıcı").slice(0, 500);
  const deviceInfo = describeDevice(userAgent);
  const participant: Participant = {
    id: socket.id,
    nickname,
    microphoneEnabled: false,
    ipAddress,
    deviceInfo,
    userAgent,
    joinedAt: Date.now(),
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

export function setRoomMaintenance(enabled: boolean): void {
  if (enabled) roomIo?.disconnectSockets(true);
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

  roomIo = io;

  io.use((socket, next) => {
    void getAdminSettings().then((settings) => {
      if (settings.maintenanceMode) {
        next(new Error(settings.maintenanceMessage || "Site bakım modunda."));
        return;
      }
      const auth = asRecord(socket.handshake.auth);
      if (auth.adminAudioTicket !== undefined) {
        const ticket = typeof auth.adminAudioTicket === "string" ? auth.adminAudioTicket : "";
        const entry = adminAudioTickets.get(ticket);
        adminAudioTickets.delete(ticket);
        if (!entry || entry.expiresAt <= Date.now() || (entry.purpose === "audio" && (!entry.roomId || !rooms.has(entry.roomId)))) {
          next(new Error("Yönetici bağlantısı geçersiz veya süresi dolmuş."));
          return;
        }
        if (entry.purpose === "audio" && entry.roomId) {
          socket.data.adminAudioObserverRoomId = entry.roomId;
          socket.data.adminAudioAllowedParticipants = new Set<string>();
        } else if (entry.purpose === "live") socket.data.adminLiveObserver = true;
      }
      next();
    }).catch(() => next());
  });

  io.on("connection", (socket) => {
    const observerRoomId = socket.data.adminAudioObserverRoomId as string | undefined;
    if (socket.data.adminLiveObserver === true) {
      void socket.join("admin:live");
      socket.emit("admin:rooms-update", getAdminRoomSnapshots().map((room) => ({
        roomId: room.roomId, videoUrl: room.videoUrl, playback: room.playback,
        participantCount: room.participants.length, participants: room.participants,
        messages: room.messages.slice(-80), messageCount: room.messages.length,
        lastActivityAt: Math.max(room.playback.updatedAt, ...room.messages.map((message) => message.createdAt), 0),
      })));
    }
    if (observerRoomId) socket.emit("admin:audio-connected", { roomId: observerRoomId, socketId: socket.id });

    socket.on("admin:audio-request", (payload: unknown) => {
      const roomId = socket.data.adminAudioObserverRoomId as string | undefined;
      const input = asRecord(payload);
      const room = roomId ? rooms.get(roomId) : undefined;
      if (!room || input.roomId !== roomId) return;
      for (const participant of room.participants.values()) {
        io.to(participant.id).emit("room:admin-audio-request", { observerId: socket.id, nickname: "Yönetici" });
      }
      socket.emit("admin:audio-request-sent", { participantCount: room.participants.size });
    });

    socket.on("room:admin-audio-consent", (payload: unknown) => {
      const input = asRecord(payload);
      const roomId = socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      const observerId = typeof input.observerId === "string" ? input.observerId : "";
      const observer = io.sockets.sockets.get(observerId);
      if (!room || !room.participants.has(socket.id) || !observer || observer.data.adminAudioObserverRoomId !== roomId || typeof input.accepted !== "boolean") return;
      let allowed = adminAudioConsent.get(observerId);
      if (!allowed) { allowed = new Set<string>(); adminAudioConsent.set(observerId, allowed); }
      if (input.accepted) allowed.add(socket.id); else allowed.delete(socket.id);
      const socketAllowed = observer.data.adminAudioAllowedParticipants as Set<string> | undefined;
      if (input.accepted) socketAllowed?.add(socket.id); else socketAllowed?.delete(socket.id);
      observer.emit("admin:audio-consent", { participantId: socket.id, nickname: room.participants.get(socket.id)?.nickname || "Katılımcı", accepted: input.accepted });
    });

    socket.on("admin:audio-stop", () => {
      const roomId = socket.data.adminAudioObserverRoomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      if (room) for (const participant of room.participants.values()) io.to(participant.id).emit("room:admin-audio-ended", { observerId: socket.id });
      adminAudioConsent.delete(socket.id);
      (socket.data.adminAudioAllowedParticipants as Set<string> | undefined)?.clear();
    });

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
      emitAdminRoomUpdates(io);
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
      emitAdminRoomUpdates(io);
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
      emitAdminRoomUpdates(io);
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
      const observerRoomId = socket.data.adminAudioObserverRoomId as string | undefined;
      const roomId = observerRoomId || socket.data.roomId as string | undefined;
      const room = roomId ? rooms.get(roomId) : undefined;
      const input = asRecord(payload);
      if (!room || typeof input.to !== "string" || input.to === socket.id || !("signal" in input)) return;
      const target = io.sockets.sockets.get(input.to);
      if (!target) return;
      if (observerRoomId) {
        const allowed = socket.data.adminAudioAllowedParticipants as Set<string> | undefined;
        if (!room.participants.has(input.to) || !allowed?.has(input.to)) return;
      } else if (socket.data.roomId) {
        const targetIsParticipant = room.participants.has(input.to);
        const targetIsObserver = target.data.adminAudioObserverRoomId === roomId && (target.data.adminAudioAllowedParticipants as Set<string> | undefined)?.has(socket.id);
        if (!targetIsParticipant && !targetIsObserver) return;
      } else return;
      let serialized: string;
      try { serialized = JSON.stringify(input.signal); } catch { return; }
      if (serialized.length > 32_000) return;
      target.emit("voice:signal", { from: socket.id, signal: input.signal });
    });

    socket.on("room:leave", () => leaveRoom(io, socket));
    socket.on("disconnect", () => {
      const observerRoomId = socket.data.adminAudioObserverRoomId as string | undefined;
      if (observerRoomId) {
        const room = rooms.get(observerRoomId);
        if (room) for (const participant of room.participants.values()) io.to(participant.id).emit("room:admin-audio-ended", { observerId: socket.id });
        adminAudioConsent.delete(socket.id);
      }
      for (const allowed of adminAudioConsent.values()) allowed.delete(socket.id);
      leaveRoom(io, socket);
    });
  });

  return io;
}
