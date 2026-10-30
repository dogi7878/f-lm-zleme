import { Router, type Request, type Response, type NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readdir, stat, unlink, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { adminDisconnectParticipant, getAdminRoomSnapshots, setRoomMaintenance } from "../lib/room-server";
import { appendMetricSnapshot, getAdminSettings, getMetricSnapshots, updateAdminSettings } from "../lib/admin-store";

const router = Router();
const COOKIE_NAME = "bi_admin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));
const videoRoot = path.join(uploadRoot, "videos");
const auditPath = path.resolve(process.env.ADMIN_AUDIT_PATH || path.join(process.cwd(), "data", "admin-audit.json"));

async function saveCurrentMetrics(): Promise<void> {
  const rooms = getAdminRoomSnapshots();
  await appendMetricSnapshot({
    at: new Date().toISOString(),
    rooms: rooms.length,
    participants: rooms.reduce((sum, room) => sum + room.participants.length, 0),
    messages: rooms.reduce((sum, room) => sum + room.messages.length, 0),
  });
}
const metricsTimer = setInterval(() => { void saveCurrentMetrics().catch(() => undefined); }, 60_000);
metricsTimer.unref?.();
void saveCurrentMetrics().catch(() => undefined);


type AuditEntry = { at: string; action: string; detail: string; ip?: string };
async function readAudit(): Promise<AuditEntry[]> {
  try { const parsed: unknown = JSON.parse(await readFile(auditPath, "utf8")); return Array.isArray(parsed) ? parsed as AuditEntry[] : []; }
  catch { return []; }
}
async function recordAudit(req: Request, action: string, detail: string): Promise<void> {
  const entries = await readAudit();
  entries.unshift({ at: new Date().toISOString(), action, detail: detail.slice(0, 300), ip: req.ip || req.socket.remoteAddress || "unknown" });
  await mkdir(path.dirname(auditPath), { recursive: true });
  await writeFile(auditPath, JSON.stringify(entries.slice(0, 500), null, 2), "utf8");
}

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
  void recordAudit(req, "ADMIN_LOGIN", "Yönetici girişi başarılı.").catch(() => undefined);
  setCookie(res, makeSession(signingSecret), SESSION_TTL_SECONDS);
  return res.json({ ok: true, expiresIn: SESSION_TTL_SECONDS });
});

router.post("/admin/logout", (_req, res) => {
  setCookie(res, "", 0);
  void recordAudit(_req, "ADMIN_LOGOUT", "Yönetici çıkış yaptı.").catch(() => undefined);
  return res.json({ ok: true });
});

router.get("/admin/me", requireAdmin, (_req, res) => res.json({ ok: true, role: "admin" }));

router.get("/admin/rooms", requireAdmin, (_req, res) => {
  const rooms = getAdminRoomSnapshots().map((room) => ({
    roomId: room.roomId,
    participantCount: room.participants.length,
    participants: room.participants.map((p) => ({ id: p.id, nickname: p.nickname, microphoneEnabled: p.microphoneEnabled, ipAddress: p.ipAddress, deviceInfo: p.deviceInfo, userAgent: p.userAgent, joinedAt: p.joinedAt })),
    videoUrl: room.videoUrl,
    playback: room.playback,
    messages: room.messages.slice(-80),
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


router.get("/admin/logs", requireAdmin, async (_req, res) => {
  return res.json({ logs: await readAudit() });
});

router.get("/admin/settings", requireAdmin, async (_req, res) => {
  return res.json({ settings: await getAdminSettings() });
});

router.post("/admin/settings", requireAdmin, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  if (typeof body.maintenanceMode !== "boolean") {
    return res.status(400).json({ error: "Bakım modu değeri geçersiz." });
  }
  if (body.maintenanceMessage !== undefined && (typeof body.maintenanceMessage !== "string" || body.maintenanceMessage.length > 500)) {
    return res.status(400).json({ error: "Bakım mesajı en fazla 500 karakter olabilir." });
  }
  const settings = await updateAdminSettings({
    maintenanceMode: body.maintenanceMode,
    ...(typeof body.maintenanceMessage === "string" ? { maintenanceMessage: body.maintenanceMessage } : {}),
  });
  setRoomMaintenance(settings.maintenanceMode);
  await recordAudit(req, settings.maintenanceMode ? "MAINTENANCE_ENABLED" : "MAINTENANCE_DISABLED", settings.maintenanceMode ? "Bakım modu etkinleştirildi." : "Bakım modu kapatıldı.");
  return res.json({ ok: true, settings });
});

router.get("/admin/metrics", requireAdmin, async (_req, res) => {
  const snapshots = await getMetricSnapshots();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return res.json({ snapshots: snapshots.filter((item) => new Date(item.at).getTime() >= cutoff) });
});



router.post("/admin/rooms/:roomId/observe", requireAdmin, async (req, res) => {
  const roomId = typeof req.params.roomId === "string" ? req.params.roomId : "";
  if (!/^[a-f0-9]{12}$/.test(roomId)) return res.status(400).json({ error: "Oda kodu geçersiz." });
  const room = getAdminRoomSnapshots().find((item) => item.roomId === roomId);
  if (!room) return res.status(404).json({ error: "Oda artık aktif değil." });
  await recordAudit(req, "ROOM_OBSERVATION_OPENED", `Yetkili moderasyon gözlemi açıldı. Oda: ${roomId}`);
  return res.json({ ok: true, roomId });
});

router.post("/admin/rooms/:roomId/kick", requireAdmin, async (req, res) => {
  const roomId = typeof req.params.roomId === "string" ? req.params.roomId : "";
  const socketId = typeof req.body?.socketId === "string" ? req.body.socketId : "";
  if (!/^[a-f0-9]{12}$/.test(roomId) || !socketId || socketId.length > 128) {
    return res.status(400).json({ error: "Oda veya katılımcı bilgisi geçersiz." });
  }
  const ok = adminDisconnectParticipant(roomId, socketId);
  if (!ok) return res.status(404).json({ error: "Aktif katılımcı bulunamadı; listeyi yenile." });
  await recordAudit(req, "PARTICIPANT_KICK", `Katılımcı odadan çıkarıldı. Oda: ${roomId}`);
  return res.json({ ok: true });
});

router.delete("/admin/files/:name", requireAdmin, async (req, res) => {
  const name = typeof req.params.name === "string" ? req.params.name : "";
  if (!/^[a-f0-9]{32}\.(mp4|webm|ogg|m4v)$/.test(name)) {
    return res.status(400).json({ error: "Dosya adı geçersiz." });
  }
  try {
    const fullPath = path.resolve(videoRoot, name);
    if (path.dirname(fullPath) !== path.resolve(videoRoot)) return res.status(400).json({ error: "Dosya yolu geçersiz." });
    await unlink(fullPath);
    await recordAudit(req, "VIDEO_DELETE", `Video dosyası silindi: ${name}`);
    return res.json({ ok: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return res.status(404).json({ error: "Dosya bulunamadı." });
    return res.status(500).json({ error: "Dosya silinemedi." });
  }
});

export default router;
