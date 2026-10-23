import { Router, type IRouter } from "express";

const router: IRouter = Router();
const allowedHosts = new Set([
  "fullhdfilmizlesene.now", "www.fullhdfilmizlesene.now",
  "fullhdfilmizlesene.com", "www.fullhdfilmizlesene.com",
  "fullhdfilmizlesene.net", "www.fullhdfilmizlesene.net",
  "fullhdfilmizlesene.org", "www.fullhdfilmizlesene.org",
]);

router.get("/embed-source", async (req, res) => {
  const raw = req.query.url;
  if (typeof raw !== "string" || raw.length > 2048) {
    res.status(400).json({ error: "Geçersiz kaynak URL'si." });
    return;
  }
  let source: URL;
  try { source = new URL(raw); } catch {
    res.status(400).json({ error: "Geçersiz kaynak URL'si." });
    return;
  }
  if (source.protocol !== "https:" || !allowedHosts.has(source.hostname.toLowerCase()) || source.username || source.password) {
    res.status(400).json({ error: "Bu kaynak desteklenmiyor." });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(source, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; FilmRoomEmbedResolver/1.0)", accept: "text/html" },
    });
    if (!response.ok) { res.status(502).json({ error: "Kaynak sayfa okunamadı." }); return; }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) { res.status(415).json({ error: "Kaynak HTML sayfası değil." }); return; }
    const html = (await response.text()).slice(0, 5_000_000);
    const candidates = [...html.matchAll(/<iframe\b[^>]*?src\s*=\s*(["'])(.*?)\1[^>]*>/gis)]
      .map((match) => match[2].replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/\\\//g, "/"));
    for (const candidate of candidates) {
      try {
        const embed = new URL(candidate, source);
        if (embed.protocol === "https:" && (embed.hostname === "rapidvid.org" || embed.hostname.endsWith(".rapidvid.org"))) {
          res.setHeader("Cache-Control", "public, max-age=120");
          res.json({ embedUrl: embed.toString() });
          return;
        }
      } catch { /* Ignore malformed iframe URLs. */ }
    }
    res.status(404).json({ error: "Uyumlu bir Rapidvid oynatıcısı bulunamadı." });
  } catch {
    res.status(502).json({ error: "Kaynak sayfa okunamadı veya zaman aşımına uğradı." });
  } finally {
    clearTimeout(timeout);
  }
});

export default router;
