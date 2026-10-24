import { Router, type Request, type Response, type NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getAdminRoomSnapshots } from "../lib/room-server";

const router = Router();
const COOKIE_NAME = "bi_admin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));
const videoRoot = path.join(uploadRoot, "videos");

function secret(): string | undefined {
  const value = process.env.ADMIN_SESSION_SECRET;
  return value && value.length >= 32 ? value : undefined;
}
function signature(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}
function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function cookieValue(req: Request): string | undefined {
  const header = req.headers.cookie || "";
  const entry = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!entry) return undefined;
  try { return decodeURIComponent(entry.slice(COOKIE_NAME.length + 1)); } catch { return undefined; }
}
function makeSession(key: string): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS, role: "admin" })).toString("base64url");
  return `${payload}.${signature(payload, key)}`;
}
function validSession(req: Request): boolean {
  const key = secret();
  const token = cookieValue(req);
  if (!key || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expected = signature(parts[0], key);
  if (!safeEqual(parts[1], expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { exp?: number; role?: string };
    return payload.role === "admin" && typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!validSession(req)) return res.status(401).json({ error: "Yönetici oturumu gerekli." });
  next();
}
function setCookie(res: Response, value: string, maxAge: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

router.post("/admin/login", (req, res) => {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const signingSecret = secret();
  if (!configuredPassword || !signingSecret) {
    return res.status(503).json({ error: "Yönetici girişi yapılandırılmamış. ADMIN_PASSWORD ve en az 32 karakterlik ADMIN_SESSION_SECRET tanımlanmalı." });
  }
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && record.resetAt > now && record.count >= 8) {
    return res.status(429).json({ error: "Çok fazla giriş denemesi. Bir süre sonra tekrar dene." });
  }
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEqual(password, configuredPassword)) {
    const next = !record || record.resetAt <= now ? { count: 1, resetAt: now + 15 * 60 * 1000 } : { ...record, count: record.count + 1 };
    loginAttempts.set(ip, next);
    return res.status(401).json({ error: "Şifre hatalı." });
  }
  loginAttempts.delete(ip);
  setCookie(res, makeSession(signingSecret), SESSION_TTL_SECONDS);
  return res.json({ ok: true, expiresIn: SESSION_TTL_SECONDS });
});

router.post("/admin/logout", (_req, res) => {
  setCookie(res, "", 0);
  return res.json({ ok: true });
});

router.get("/admin/me", requireAdmin, (_req, res) => res.json({ ok: true, role: "admin" }));

router.get("/admin/rooms", requireAdmin, (_req, res) => {
  const rooms = getAdminRoomSnapshots().map((room) => ({
    roomId: room.roomId,
    participantCount: room.participants.length,
    participants: room.participants.map((p) => ({ nickname: p.nickname, microphoneEnabled: p.microphoneEnabled })),
    videoUrl: room.videoUrl,
    playback: room.playback,
    messageCount: room.messages.length,
    lastActivityAt: Math.max(room.playback.updatedAt, ...room.messages.map((m) => m.createdAt), 0),
  }));
  return res.json({ rooms, total: rooms.length, note: "Yalnızca bu sunucu sürecinde şu anda bellekte bulunan odalar listelenir." });
});

router.get("/admin/files", requireAdmin, async (_req, res) => {
  try {
    const names = await readdir(videoRoot);
    const files = [];
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.(mp4|webm|ogg|m4v)$/.test(name)) continue;
      try {
        const info = await stat(path.join(videoRoot, name));
        if (!info.isFile()) continue;
        files.push({ name, size: info.size, modifiedAt: info.mtime.toISOString() });
      } catch { /* File may have been removed during listing. */ }
    }
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return res.json({ files, total: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return res.json({ files: [], total: 0, totalBytes: 0 });
    return res.status(500).json({ error: "Dosya listesi okunamadı." });
  }
});

export default router;
