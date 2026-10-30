import express, { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";

const router: IRouter = Router();
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GiB
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB per request, works around common per-request body limits
const ALLOWED_EXTENSIONS = new Set([".mp4", ".webm", ".ogg", ".m4v"]);
const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));
const TEMP_ROOT = path.join(UPLOAD_ROOT, ".tmp");
const VIDEO_ROOT = path.join(UPLOAD_ROOT, "videos");

type UploadSession = { id: string; extension: string; size: number; chunks: number; received: Set<number> };
const sessions = new Map<string, UploadSession>();

async function ensureDirs() {
  await mkdir(TEMP_ROOT, { recursive: true });
  await mkdir(VIDEO_ROOT, { recursive: true });
}
function sendError(res: Response, status: number, message: string) {
  return res.status(status).json({ error: message });
}

router.post("/uploads/init", async (req, res) => {
  const body = req.body as { fileName?: unknown; fileSize?: unknown };
  const fileName = typeof body?.fileName === "string" ? body.fileName : "";
  const fileSize = Number(body?.fileSize);
  const extension = path.extname(fileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return sendError(res, 400, "Desteklenen dosyalar: MP4, WebM, Ogg ve M4V.");
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MAX_FILE_SIZE) {
    return sendError(res, 413, "Dosya boş olamaz ve en fazla 2 GB olabilir.");
  }
  await ensureDirs();
  const id = randomBytes(16).toString("hex");
  const chunks = Math.ceil(fileSize / CHUNK_SIZE);
  sessions.set(id, { id, extension, size: fileSize, chunks, received: new Set() });
  await mkdir(path.join(TEMP_ROOT, id), { recursive: true });
  return res.json({ uploadId: id, chunkSize: CHUNK_SIZE, chunks });
});

router.post("/uploads/:uploadId/chunk", express.raw({ type: "application/octet-stream", limit: "9mb" }), async (req: Request, res: Response) => {
  const id = req.params.uploadId;
  const session = sessions.get(id);
  const index = Number(req.query.index);
  if (!session || !/^[a-f0-9]{32}$/.test(id)) return sendError(res, 404, "Yükleme oturumu bulunamadı; tekrar deneyin.");
  if (!Number.isInteger(index) || index < 0 || index >= session.chunks) return sendError(res, 400, "Parça numarası geçersiz.");
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const expectedSize = index === session.chunks - 1 ? session.size - CHUNK_SIZE * index : CHUNK_SIZE;
  if (body.length !== expectedSize) return sendError(res, 400, "Dosya parçası eksik veya bozuk; tekrar deneyin.");
  const chunkPath = path.join(TEMP_ROOT, id, `${index}.part`);
  await writeFile(chunkPath, body);
  session.received.add(index);
  return res.json({ ok: true, received: session.received.size, total: session.chunks });
});

router.post("/uploads/:uploadId/complete", async (req, res) => {
  const id = req.params.uploadId;
  const session = sessions.get(id);
  if (!session || !/^[a-f0-9]{32}$/.test(id)) return sendError(res, 404, "Yükleme oturumu bulunamadı; tekrar deneyin.");
  if (session.received.size !== session.chunks) return sendError(res, 400, "Dosyanın tüm parçaları gelmedi; yüklemeyi tekrar deneyin.");
  const finalName = `${id}${session.extension}`;
  const finalPath = path.join(VIDEO_ROOT, finalName);
  try {
    await writeFile(finalPath, Buffer.alloc(0));
    for (let i = 0; i < session.chunks; i++) {
      const chunkPath = path.join(TEMP_ROOT, id, `${i}.part`);
      const chunk = await readFile(chunkPath);
      await appendFile(finalPath, chunk);
    }
    const finalStat = await stat(finalPath);
    if (finalStat.size !== session.size) {
      await rm(finalPath, { force: true });
      return sendError(res, 500, "Yüklenen dosyanın boyutu doğrulanamadı.");
    }
    await rm(path.join(TEMP_ROOT, id), { recursive: true, force: true });
    sessions.delete(id);
    return res.json({ ok: true, url: `/api/uploads/${finalName}`, size: finalStat.size });
  } catch (error) {
    await rm(finalPath, { force: true }).catch(() => undefined);
    throw error;
  }
});

router.get("/uploads/:filename", async (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9]{32}\.(mp4|webm|ogg|m4v)$/.test(filename)) return sendError(res, 404, "Video bulunamadı.");
  await ensureDirs();
  const filePath = path.join(VIDEO_ROOT, filename);
  try {
    await stat(filePath);
    // Express sendFile supports byte ranges, so seeking in the video works.
    return res.sendFile(filePath);
  } catch {
    return sendError(res, 404, "Video bulunamadı.");
  }
});

export default router;
