import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { io, type Socket } from "socket.io-client";
import { ArrowLeft, RefreshCw, ShieldCheck, Users, Film, FileVideo, LogOut, AlertTriangle, LayoutDashboard, Activity, Search, Trash2, UserRoundX, Clock3, HardDrive, Settings2, ScrollText, LockKeyhole, Play, Pause } from "lucide-react";

type Participant = { id: string; nickname: string; microphoneEnabled: boolean; ipAddress?: string; deviceInfo?: string; userAgent?: string; joinedAt?: number };
type ChatMessage = { id: string; nickname: string; text: string; createdAt: number };
type Room = { roomId: string; participantCount: number; participants: Participant[]; videoUrl: string | null; playback: { isPlaying: boolean; currentTime: number; updatedAt: number }; messages: ChatMessage[]; messageCount: number; lastActivityAt: number };
type FileInfo = { name: string; size: number; modifiedAt: string };
type Audit = { at: string; action: string; detail: string; ip?: string };
type AdminSettings = { maintenanceMode: boolean; maintenanceMessage: string; emptyRoomTimeoutSeconds: number };
type Health = { status: string; checkedAt: string; uptimeSeconds: number; rooms: number; participants: number; memoryBytes: { rss: number; heapUsed: number; heapTotal: number }; nodeVersion: string };
type Metric = { at: string; rooms: number; participants: number; messages: number };
type Tab = "overview" | "rooms" | "videos" | "users" | "logs" | "settings";
const formatBytes = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;
const time = (v: number | string) => v ? new Date(v).toLocaleString("tr-TR") : "—";

function youtubeEmbedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    let id = "";
    if (url.hostname === "youtu.be" || url.hostname.endsWith(".youtu.be")) id = url.pathname.slice(1);
    else if (url.hostname.includes("youtube.com")) {
      if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
      else if (url.pathname.startsWith("/embed/")) id = url.pathname.split("/")[2] || "";
      else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] || "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=0&controls=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}` : null;
  } catch { return null; }
}
function isDirectVideo(raw: string): boolean {
  try { return /\.(mp4|webm|ogg|m4v)(?:$|[?#])/i.test(new URL(raw).href); } catch { return false; }
}

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [logs, setLogs] = useState<Audit[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [adminSettings, setAdminSettings] = useState<AdminSettings>({ maintenanceMode: false, maintenanceMessage: "Sitemiz kısa bir bakım çalışması nedeniyle geçici olarak kullanılamıyor. Lütfen biraz sonra tekrar dene.", emptyRoomTimeoutSeconds: 120 });
  const [health, setHealth] = useState<Health | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [totalBytes, setTotalBytes] = useState(0);
  const [tab, setTab] = useState<Tab>("overview");
  const [updatedAt, setUpdatedAt] = useState("");
  const [query, setQuery] = useState("");
  const [observedRoomId, setObservedRoomId] = useState<string | null>(null);
  const [observeError, setObserveError] = useState("");
  const [audioStatus, setAudioStatus] = useState("");
  const audioSocketRef = useRef<Socket | null>(null);
  const liveSocketRef = useRef<Socket | null>(null);
  const audioPeersRef = useRef(new Map<string, RTCPeerConnection>());
  const audioElementsRef = useRef(new Map<string, HTMLAudioElement>());
  const observeVideoRef = useRef<HTMLVideoElement | null>(null);
  const observeYoutubeRef = useRef<HTMLIFrameElement | null>(null);

  const stopAudioObservation = useCallback(() => {
    const socket = audioSocketRef.current;
    if (socket?.connected) socket.emit("admin:audio-stop");
    socket?.disconnect(); audioSocketRef.current = null;
    audioPeersRef.current.forEach((pc) => pc.close()); audioPeersRef.current.clear();
    audioElementsRef.current.forEach((audio) => { audio.pause(); audio.srcObject = null; }); audioElementsRef.current.clear();
    setAudioStatus("");
  }, []);

  useEffect(() => () => {
    const socket = audioSocketRef.current;
    if (socket?.connected) socket.emit("admin:audio-stop");
    socket?.disconnect();
    audioPeersRef.current.forEach((pc) => pc.close()); audioPeersRef.current.clear();
    audioElementsRef.current.forEach((audio) => { audio.pause(); audio.srcObject = null; }); audioElementsRef.current.clear();
  }, []);

  const api = async (url: string, init?: RequestInit) => {
    const r = await fetch(url, { credentials: "same-origin", ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `İstek başarısız (${r.status})`);
    return data;
  };

  const loadData = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const [roomData, fileData, logData, settingsData, metricsData, healthData] = await Promise.all([
        fetch("/api/admin/rooms", { credentials: "same-origin" }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "Odalar alınamadı."); return d; }),
        fetch("/api/admin/files", { credentials: "same-origin" }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "Dosyalar alınamadı."); return d; }),
        fetch("/api/admin/logs", { credentials: "same-origin" }).then(async r => { const d = await r.json(); if (!r.ok) return { logs: [] }; return d; }),
        fetch("/api/admin/settings", { credentials: "same-origin" }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "Ayarlar alınamadı."); return d; }),
        fetch("/api/admin/metrics", { credentials: "same-origin" }).then(async r => { const d = await r.json(); if (!r.ok) return { snapshots: [] }; return d; }),
        fetch("/api/admin/health", { credentials: "same-origin" }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "Sistem durumu alınamadı."); return d; }),
      ]);
      setRooms(roomData.rooms || []); setFiles(fileData.files || []); setTotalBytes(fileData.totalBytes || 0); setLogs(logData.logs || []);
      setAdminSettings(settingsData.settings || { maintenanceMode: false, maintenanceMessage: "", emptyRoomTimeoutSeconds: 120 }); setSettingsDirty(false); setMetrics(metricsData.snapshots || []); setHealth(healthData);
      setUpdatedAt(new Date().toLocaleTimeString("tr-TR"));
    } catch (e) { setError(e instanceof Error ? e.message : "Bağlantı hatası."); }
    finally { setBusy(false); setChecking(false); }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/me", { credentials: "same-origin" }).then(r => { if (alive && r.ok) { setLoggedIn(true); void loadData(); } else if (alive) setChecking(false); }).catch(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [loadData]);

  // Real-time admin room updates arrive over a short-lived, server-issued Socket.IO ticket.
  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    let socket: Socket | null = null;
    void api("/api/admin/live-ticket", { method: "POST" }).then((result) => {
      if (cancelled) return;
      socket = io({ path: "/api/socket.io", auth: { adminAudioTicket: result.ticket }, autoConnect: false });
      liveSocketRef.current = socket;
      socket.on("admin:rooms-update", (data: Room[]) => {
        setRooms(data || []);
        setUpdatedAt(new Date().toLocaleTimeString("tr-TR"));
      });
      socket.on("connect_error", () => setError("Canlı yönetim bağlantısı kesildi; sayfayı yenileyip tekrar giriş yap."));
      socket.connect();
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Canlı yönetim bağlantısı başlatılamadı."); });
    return () => { cancelled = true; socket?.disconnect(); if (liveSocketRef.current === socket) liveSocketRef.current = null; };
  }, [loggedIn]);

  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) }); setLoggedIn(true); setPassword(""); await loadData(); }
    catch (e) { setError(e instanceof Error ? e.message : "Giriş yapılamadı."); }
    finally { setBusy(false); }
  }
  async function logout() {
    await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    setLoggedIn(false); setRooms([]); setFiles([]); setLogs([]);
  }
  async function kick(room: Room, person: Participant) {
    if (!confirm(`${person.nickname} kullanıcısını ${room.roomId} odasından çıkarmak istiyor musun?`)) return;
    try { await api(`/api/admin/rooms/${room.roomId}/kick`, { method: "POST", body: JSON.stringify({ socketId: person.id }) }); setNotice(`${person.nickname} odadan çıkarıldı.`); await loadData(); }
    catch (e) { setError(e instanceof Error ? e.message : "Moderasyon işlemi başarısız."); }
  }
  async function deleteFile(file: FileInfo) {
    if (!confirm(`${file.name} dosyası sunucudan kalıcı olarak silinsin mi? Bu işlem geri alınamaz.`)) return;
    try { await api(`/api/admin/files/${encodeURIComponent(file.name)}`, { method: "DELETE" }); setNotice("Video dosyası silindi."); await loadData(); }
    catch (e) { setError(e instanceof Error ? e.message : "Dosya silinemedi."); }
  }
  async function saveSettings() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api("/api/admin/settings", { method: "POST", body: JSON.stringify(adminSettings) });
      setAdminSettings(result.settings); setSettingsDirty(false);
      setNotice(result.settings.maintenanceMode ? "Bakım modu etkinleştirildi. Aktif oda bağlantıları kapatıldı." : "Bakım modu kapatıldı; oda bağlantıları yeniden kabul ediliyor.");
      await loadData();
    } catch (e) { setError(e instanceof Error ? e.message : "Ayarlar kaydedilemedi."); }
    finally { setBusy(false); }
  }

  async function startAudioObservation(room: Room) {
    stopAudioObservation();
    setAudioStatus("Katılımcılara ses erişimi isteği gönderiliyor…");
    try {
      const ticketResult = await api(`/api/admin/rooms/${room.roomId}/audio-ticket`, { method: "POST" });
      const socket = io({ path: "/api/socket.io", auth: { adminAudioTicket: ticketResult.ticket }, autoConnect: false });
      audioSocketRef.current = socket;
      socket.on("connect", () => { socket.emit("admin:audio-request", { roomId: room.roomId }); setAudioStatus("İstek gönderildi; katılımcıların onayı bekleniyor."); });
      socket.on("connect_error", (e: Error) => setAudioStatus(`Ses bağlantısı kurulamadı: ${e.message}`));
      socket.on("admin:audio-request-sent", ({ participantCount }: { participantCount: number }) => setAudioStatus(participantCount ? "İzinler bekleniyor…" : "Bu odada aktif katılımcı yok."));
      socket.on("admin:audio-consent", async ({ participantId, nickname, accepted }: { participantId: string; nickname: string; accepted: boolean }) => {
        if (!accepted) { setAudioStatus(`${nickname} ses erişimini reddetti.`); return; }
        setAudioStatus(`${nickname} izin verdi; ses bağlantısı kuruluyor…`);
        const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        audioPeersRef.current.set(participantId, pc);
        pc.onicecandidate = (event) => { if (event.candidate) socket.emit("voice:signal", { to: participantId, signal: event.candidate }); };
        pc.ontrack = (event) => {
          let audio = audioElementsRef.current.get(participantId);
          if (!audio) { audio = new Audio(); audio.autoplay = true; audio.setAttribute("playsinline", ""); audioElementsRef.current.set(participantId, audio); }
          audio.srcObject = event.streams[0];
          void audio.play().then(() => setAudioStatus(`Canlı ses açık: ${nickname}`)).catch(() => setAudioStatus(`Ses akışı hazır (${nickname}); tarayıcı sesi otomatik başlatmadı. Ses erişimini yeniden başlatmak için kapatıp tekrar aç.`));
        };
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
        await pc.setLocalDescription(offer);
        socket.emit("voice:signal", { to: participantId, signal: offer });
      });
      socket.on("voice:signal", async ({ from, signal }: { from: string; signal: RTCSessionDescriptionInit | RTCIceCandidateInit }) => {
        const pc = audioPeersRef.current.get(from);
        if (!pc) return;
        try {
          if ("type" in signal && signal.type === "answer") await pc.setRemoteDescription(signal as RTCSessionDescriptionInit);
          else if ("type" in signal && signal.type === "offer") { await pc.setRemoteDescription(signal as RTCSessionDescriptionInit); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit("voice:signal", { to: from, signal: answer }); }
          else await pc.addIceCandidate(signal as RTCIceCandidateInit);
        } catch { setAudioStatus("Ses bağlantısı kurulamadı. Katılımcıdan yeniden izin isteyebilirsin."); }
      });
      socket.connect();
    } catch (e) { setAudioStatus(e instanceof Error ? e.message : "Ses erişimi başlatılamadı."); }
  }

  async function openObservation(room: Room) {
    setObserveError("");
    try {
      await api(`/api/admin/rooms/${room.roomId}/observe`, { method: "POST" });
      setObservedRoomId(room.roomId);
    } catch (e) { setObserveError(e instanceof Error ? e.message : "Gözlem modu açılamadı."); }
  }
  const observedRoom = rooms.find(r => r.roomId === observedRoomId) || null;

  // Keep the moderator preview aligned with the room's authoritative playback state.
  // Playback timestamps are snapshots; while playing, advance by elapsed wall-clock time.
  const syncObservedPlayer = useCallback(() => {
    if (!observedRoom) return;
    const playback = observedRoom.playback;
    const targetTime = Math.max(0, playback.currentTime + (playback.isPlaying ? (Date.now() - playback.updatedAt) / 1000 : 0));
    const video = observeVideoRef.current;
    if (video && video.readyState >= 1 && Number.isFinite(targetTime)) {
      if (Math.abs(video.currentTime - targetTime) > 1.25) {
        try { video.currentTime = targetTime; } catch { /* Wait until the media becomes seekable. */ }
      }
      if (playback.isPlaying && video.paused) void video.play().catch(() => setObserveError("Tarayıcı otomatik oynatmayı engelledi. Gözlem videosundaki oynat düğmesine bas."));
      else if (!playback.isPlaying && !video.paused) video.pause();
    }
    const frame = observeYoutubeRef.current;
    if (frame?.contentWindow) {
      const send = (func: string, args: unknown[] = []) => frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
      send("seekTo", [targetTime, true]);
      send(playback.isPlaying ? "playVideo" : "pauseVideo");
    }
  }, [observedRoom?.roomId, observedRoom?.videoUrl, observedRoom?.playback.currentTime, observedRoom?.playback.isPlaying, observedRoom?.playback.updatedAt]);

  useEffect(() => {
    if (!observedRoom) return;
    // Let the player finish mounting before applying the latest room snapshot.
    const id = window.setTimeout(syncObservedPlayer, 150);
    return () => window.clearTimeout(id);
  }, [syncObservedPlayer, observedRoom?.videoUrl]);

  const participantCount = rooms.reduce((n, r) => n + r.participantCount, 0);
  const filteredRooms = useMemo(() => rooms.filter(r => `${r.roomId} ${r.participants.map(p => p.nickname).join(" ")}`.toLowerCase().includes(query.toLowerCase())), [rooms, query]);
  const filteredFiles = useMemo(() => files.filter(f => f.name.toLowerCase().includes(query.toLowerCase())), [files, query]);
  const chartMetrics = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = metrics.filter(m => new Date(m.at).getTime() >= cutoff);
    if (recent.length <= 12) return recent;
    const step = Math.ceil(recent.length / 12);
    return recent.filter((_, i) => i % step === 0).slice(-12);
  }, [metrics]);
  const nav: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
    { id: "overview", label: "Genel bakış", icon: LayoutDashboard }, { id: "rooms", label: "Odalar", icon: Users }, { id: "videos", label: "Video arşivi", icon: Film }, { id: "users", label: "Katılımcılar", icon: UserRoundX }, { id: "logs", label: "İşlem kayıtları", icon: ScrollText }, { id: "settings", label: "Sistem ve güvenlik", icon: Settings2 },
  ];

  if (checking) return <div className="admin-shell"><div className="admin-login-card">Yönetici oturumu kontrol ediliyor…</div></div>;
  if (!loggedIn) return <div className="admin-shell"><div className="admin-login-card"><Link className="admin-back" href="/"><ArrowLeft size={16}/> Ana sayfaya dön</Link><div className="admin-brand-icon"><ShieldCheck size={27}/></div><p className="admin-eyebrow">BİRLİKTE İZLE · GÜVENLİ ALAN</p><h1>Yönetici girişi</h1><p className="admin-muted">Yönetim verilerine yalnızca yetkili hesap erişebilir.</p><form onSubmit={login}><label className="admin-label" htmlFor="admin-password">Yönetici şifresi</label><input id="admin-password" className="admin-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required/><button className="admin-primary" disabled={busy}>{busy ? "Kontrol ediliyor…" : "Güvenli giriş yap"}</button></form>{error && <div className="admin-error"><AlertTriangle size={16}/>{error}</div>}<p className="admin-footnote">Giriş sunucu tarafında doğrulanır. Şifreyi frontend koduna yazma.</p></div></div>;

  return <div className="admin-shell admin-pro"><header className="admin-header"><Link href="/" className="admin-back"><ArrowLeft size={16}/> Siteye dön</Link><div className="admin-header-title"><div className="admin-brand-icon small"><ShieldCheck size={20}/></div><div><b>Birlikte İzle</b><small>Yönetim merkezi / v3</small></div></div><div className="admin-header-actions"><span className="admin-secure-label">● Korumalı oturum · Anlık canlı bağlantı</span><button className="admin-quiet-btn" onClick={() => void loadData()} disabled={busy}><RefreshCw size={15} className={busy ? "admin-spin" : ""}/> Yenile</button><button className="admin-quiet-btn" onClick={() => void logout()}><LogOut size={15}/> Çıkış</button></div></header>
    <div className="admin-layout"><aside className="admin-sidebar"><p className="admin-sidebar-label">ÇALIŞMA ALANI</p>{nav.map(item => { const Icon = item.icon; return <button key={item.id} className={`admin-nav-item ${tab === item.id ? "active" : ""}`} onClick={() => { setTab(item.id); setQuery(""); setError(""); setNotice(""); }}><Icon size={17}/><span>{item.label}</span>{item.id === "rooms" && <em>{rooms.length}</em>}</button>; })}<div className="admin-sidebar-bottom"><span className="admin-online-dot"/> API bağlantısı açık<small>Son kontrol: {updatedAt || "—"}</small></div></aside>
    <main className="admin-content"><div className="admin-welcome"><div><p className="admin-eyebrow">YÖNETİM / {nav.find(n => n.id === tab)?.label.toLocaleUpperCase("tr-TR")}</p><h1>{tab === "overview" ? "Kontrol paneli" : nav.find(n => n.id === tab)?.label}</h1><p className="admin-muted">Canlı oda durumu, medya depolama ve güvenlik kontrolleri.</p></div><span className="admin-updated"><Clock3 size={13}/> Son yenileme: {updatedAt || "—"}</span></div>
    {error && <div className="admin-error"><AlertTriangle size={16}/>{error}</div>}{notice && <div className="admin-success">✓ {notice}</div>}
    {tab === "overview" && <>
      <div className="admin-stats admin-stats-pro"><div className="admin-stat"><span><Users size={17}/> Aktif odalar <i className="admin-stat-icon purple"><Activity size={16}/></i></span><b>{rooms.length}</b><small>Sunucu belleğinde bulunan odalar</small></div><div className="admin-stat"><span><Users size={17}/> Katılımcılar <i className="admin-stat-icon green"><Users size={16}/></i></span><b>{participantCount}</b><small>Şu an bağlı katılımcılar</small></div><div className="admin-stat"><span><FileVideo size={17}/> Video dosyaları <i className="admin-stat-icon blue"><HardDrive size={16}/></i></span><b>{files.length}</b><small>{formatBytes(totalBytes)} depolama kullanımı</small></div><div className="admin-stat"><span><ScrollText size={17}/> Kayıtlar <i className="admin-stat-icon amber"><Activity size={16}/></i></span><b>{logs.length}</b><small>Kaydedilmiş yönetici işlemleri</small></div></div>
      <div className="admin-overview-grid"><section className="admin-panel"><div className="admin-panel-heading"><div><h2>Canlı aktivite özeti</h2><p>Mevcut bellekteki oda verilerinden hesaplanır.</p></div><span className="admin-tag"><span className="admin-online-dot"/> CANLI ANLIK</span></div><div className="admin-chart"><div className="admin-chart-legend"><span><i className="legend-purple"/> Katılımcılar / oda</span><span><i className="legend-blue"/> Mesajlar / oda</span></div>{rooms.length ? <div className="admin-bars">{rooms.slice(0, 10).map(r => { const max = Math.max(1, ...rooms.map(x => Math.max(x.participantCount, x.messageCount))); return <div className="admin-bar-group" key={r.roomId} title={`${r.roomId}: ${r.participantCount} katılımcı, ${r.messageCount} mesaj`}><div className="admin-bar-pair"><i className="bar-purple" style={{ height: `${Math.max(4, r.participantCount / max * 100)}%` }}/><i className="bar-blue" style={{ height: `${Math.max(4, r.messageCount / max * 100)}%` }}/></div><small>{r.roomId.slice(0, 5)}</small></div>; })}</div> : <div className="admin-empty">Grafik için açık oda bulunmuyor.</div>}<p className="admin-chart-footnote">Bu görsel geçmiş zaman serisi değildir; yalnızca şu anki oda durumunun karşılaştırmasıdır.</p></div></section>
      <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Sistem özeti</h2><p>Bu sunucuda görülebilen mevcut durum.</p></div><Activity size={18} color="#8b7cff"/></div><div className="admin-system-list"><div><span>API yönetici oturumu</span><b className="state-good">Korumalı</b></div><div><span>Canlı oda belleği</span><b>{rooms.length} oda</b></div><div><span>Medya depolaması</span><b>{formatBytes(totalBytes)}</b></div><div><span>API sağlık durumu</span><b className={health?.status === "ok" ? "state-good" : "state-muted"}>{health?.status === "ok" ? "Sağlıklı" : "Kontrol ediliyor"}</b></div><div><span>Sunucu çalışma süresi</span><b>{health ? `${Math.floor(health.uptimeSeconds / 3600)} sa ${Math.floor((health.uptimeSeconds % 3600) / 60)} dk` : "—"}</b></div><div><span>RAM / Heap</span><b>{health ? `${(health.memoryBytes.heapUsed / 1024 / 1024).toFixed(0)} / ${(health.memoryBytes.heapTotal / 1024 / 1024).toFixed(0)} MB` : "—"}</b></div><div><span>Kalıcı hesap sistemi</span><b className="state-muted">Bağlı değil</b></div><div><span>Bakım modu</span><b className={adminSettings.maintenanceMode ? "state-good" : "state-muted"}>{adminSettings.maintenanceMode ? "Etkin" : "Kapalı"}</b></div><div><span>Kalıcı kullanıcı hesapları</span><b className="state-muted">Henüz bağlı değil</b></div></div></section></div>
      <section className="admin-panel admin-history-panel"><div className="admin-panel-heading"><div><h2>24 saatlik geçmiş</h2><p>Sunucu çalıştığı sürece dakikada bir alınan kalıcı ölçümler.</p></div><span className="admin-tag">{chartMetrics.length} ölçüm</span></div>{chartMetrics.length ? <div className="admin-history-chart">{chartMetrics.map((m, i) => { const max = Math.max(1, ...chartMetrics.map(x => Math.max(x.rooms, x.participants))); return <div className="admin-history-point" key={m.at + i} title={`${time(m.at)} · ${m.rooms} oda · ${m.participants} kişi`}><div className="admin-history-bars"><i style={{height: `${Math.max(3, m.rooms / max * 100)}%`}}/><b style={{height: `${Math.max(3, m.participants / max * 100)}%`}}/></div><small>{new Date(m.at).toLocaleTimeString("tr-TR", {hour:"2-digit",minute:"2-digit"})}</small></div>; })}</div> : <div className="admin-empty">Geçmiş ölçümler bir dakika içinde oluşmaya başlar. Yeni kurulumda önceki günlere ait veri bulunmaz.</div>}<p className="admin-chart-footnote">Grafik yalnızca sunucu çalışırken alınan gerçek ölçümleri gösterir; uygulama kapalıyken ölçüm alınmaz.</p></section>
      <section className="admin-panel admin-recent"><div className="admin-panel-heading"><div><h2>Aktif odalar</h2><p>En son görülen oda durumu.</p></div><button className="admin-inline-action" onClick={() => setTab("rooms")}>Tüm odalar ↗</button></div>{rooms.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>ODA</th><th>KATILIMCI</th><th>İÇERİK DURUMU</th><th>MESAJ</th><th>OYNATMA</th></tr></thead><tbody>{rooms.slice(0, 5).map(r=><tr key={r.roomId}><td><b>{r.roomId}</b></td><td>{r.participantCount}</td><td>{r.videoUrl ? "Video seçili" : "İçerik seçilmedi"}</td><td>{r.messageCount}</td><td><span className={`admin-status ${r.playback.isPlaying ? "live" : ""}`}>{r.playback.isPlaying ? <><Play size={11}/> Oynatılıyor</> : <><Pause size={11}/> Duraklatıldı</>}</span></td></tr>)}</tbody></table></div> : <div className="admin-empty">Şu anda açık oda görünmüyor.</div>}</section>
    </>}
    {tab === "rooms" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Oda yönetimi</h2><p>Katılımcıları incele, gerekli durumlarda kişiyi odadan çıkar.</p></div><span className="admin-tag">{rooms.length} açık oda</span></div><div className="admin-toolbar"><label className="admin-search"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Oda kodu veya takma ad ara…"/></label></div>{filteredRooms.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>ODA KODU</th><th>KATILIMCILAR / MODERASYON</th><th>İÇERİK</th><th>SON HAREKET</th></tr></thead><tbody>{filteredRooms.map(room=><tr key={room.roomId}><td><b>{room.roomId}</b><small className="admin-cell-sub">{room.messageCount} mesaj</small></td><td><div className="admin-people">{room.participants.map(p=><div key={p.id || p.nickname} className="admin-person"><span><b>{p.nickname}</b><small>{p.microphoneEnabled ? "Mikrofon açık" : "Mikrofon kapalı"}</small><small>{p.deviceInfo || "Cihaz bilgisi yok"} · IP: {p.ipAddress || "bilinmiyor"}</small></span>{p.id && <button title="Kullanıcıyı odadan çıkar" className="admin-danger-icon" onClick={() => void kick(room,p)}><UserRoundX size={15}/></button>}</div>)}</div></td><td><button className="admin-primary" style={{padding:"7px 10px",marginBottom:8}} onClick={() => void openObservation(room)}>Canlı gözlem ↗</button><div>{room.videoUrl ? <a href={room.videoUrl} target="_blank" rel="noreferrer">Bağlantıyı aç ↗</a> : <span className="admin-muted">İçerik seçilmedi</span>}</div><div><span className={`admin-status ${room.playback.isPlaying ? "live" : ""}`}>{room.playback.isPlaying ? "Oynatılıyor" : "Duraklatıldı"}</span></div></td><td>{time(room.lastActivityAt)}</td></tr>)}</tbody></table></div> : <div className="admin-empty">Aramayla eşleşen oda yok.</div>}</section>}
    {tab === "videos" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Video ve depolama yönetimi</h2><p>Dosya meta verileri. Silme işlemi kalıcıdır ve onay ister.</p></div><span className="admin-tag">{formatBytes(totalBytes)} toplam</span></div><div className="admin-toolbar"><label className="admin-search"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Dosya adına göre ara…"/></label></div>{filteredFiles.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>DOSYA</th><th>BOYUT</th><th>SON DEĞİŞİKLİK</th><th>İŞLEM</th></tr></thead><tbody>{filteredFiles.map(file=><tr key={file.name}><td><b>{file.name}</b></td><td>{formatBytes(file.size)}</td><td>{time(file.modifiedAt)}</td><td><button className="admin-danger-btn" onClick={() => void deleteFile(file)}><Trash2 size={14}/> Sil</button></td></tr>)}</tbody></table></div> : <div className="admin-empty">Video klasöründe eşleşen dosya bulunamadı.</div>}</section>}
    {tab === "users" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Katılımcı ve moderasyon merkezi</h2><p>Şu anda yalnızca aktif odalara bağlı kişilere erişilebilir.</p></div><span className="admin-tag">{participantCount} aktif katılımcı</span></div>{participantCount ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>TAKMA AD</th><th>ODA</th><th>MİKROFON</th><th>CİHAZ / TARAYICI</th><th>IP ADRESİ</th><th>KATILMA</th><th>MODERASYON</th></tr></thead><tbody>{rooms.flatMap(r=>r.participants.map(p=><tr key={`${r.roomId}-${p.id || p.nickname}`}><td><b>{p.nickname}</b></td><td>{r.roomId}</td><td><span className={`admin-status ${p.microphoneEnabled ? "live" : ""}`}>{p.microphoneEnabled ? "Açık" : "Kapalı"}</span></td><td title={p.userAgent || ""}>{p.deviceInfo || "Bilinmiyor"}</td><td><code>{p.ipAddress || "Bilinmiyor"}</code></td><td>{p.joinedAt ? time(p.joinedAt) : "—"}</td><td><button className="admin-danger-btn" onClick={() => void kick(r,p)} disabled={!p.id}><UserRoundX size={14}/> Odadan çıkar</button></td></tr>))}</tbody></table></div> : <div className="admin-empty">Aktif katılımcı bulunmuyor.</div>}<div className="admin-note"><ShieldCheck size={18}/><div><b>Gizlilik ve hesap yönetimi</b><p>IP adresi ve tarayıcı bilgisi yalnızca yetkili yönetim panelinde, aktif bağlantı süresince görünür. IP bilgisi proxy/tünel yapılandırmasına bağlı olarak gerçek ziyaretçi adresi yerine ara sunucuyu gösterebilir. Bu verileri güvenlik ve moderasyon amacıyla kullan; gizlilik bilgilendirmeni buna göre güncelle. Kalıcı üyelik veritabanı olmadığı için geçmiş ziyaretçiler burada tutulmaz.</p></div></div></section>}
    {tab === "logs" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Güvenlik ve işlem kayıtları</h2><p>Yönetici tarafından gerçekleştirilen desteklenen işlemler.</p></div><span className="admin-tag">{logs.length} kayıt</span></div>{logs.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>ZAMAN</th><th>İŞLEM</th><th>AYRINTI</th><th>İSTEK KAYNAĞI</th></tr></thead><tbody>{logs.map((log,i)=><tr key={`${log.at}-${i}`}><td>{time(log.at)}</td><td><b>{log.action}</b></td><td>{log.detail}</td><td>{log.ip || "—"}</td></tr>)}</tbody></table></div> : <div className="admin-empty">Henüz kayıt yok. Desteklenen yönetici işlemleri burada listelenecek.</div>}<div className="admin-note"><LockKeyhole size={18}/><div><b>Güvenlik notu</b><p>Bu kayıtlar uygulama sunucusunun yerel veri dosyasında tutulur. Sunucunun dosya sistemi kalıcı değilse kayıtlar kalıcı olmayabilir.</p></div></div></section>}
    {tab === "settings" && <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Sistem ve güvenlik</h2><p>Bakım modu API ve canlı oda bağlantılarını sunucu tarafında kısıtlar.</p></div><span className={`admin-tag ${adminSettings.maintenanceMode ? "admin-tag-danger" : ""}`}>{adminSettings.maintenanceMode ? "BAKIM AKTİF" : "SİSTEM AKTİF"}</span></div><div className="admin-system-list admin-settings-list"><div><span><LockKeyhole size={16}/> Yönetici oturumu</span><b className="state-good">HttpOnly oturum çerezi</b></div><div><span><ShieldCheck size={16}/> Şifre doğrulaması</span><b className="state-good">Sunucu tarafında</b></div><div><span><HardDrive size={16}/> Video klasörü</span><b>{files.length} dosya · {formatBytes(totalBytes)}</b></div><div><span><Users size={16}/> Aktif oda belleği</span><b>{rooms.length} oda</b></div></div><div className="admin-maintenance-card"><div className="admin-maintenance-copy"><b>Boş oda otomatik kapatma süresi</b><p>Odada hiç katılımcı kalmadığında oda bu süre sonunda silinir. Birisi süre dolmadan geri gelirse oda korunur.</p></div><label className="admin-label" htmlFor="empty-room-timeout">Süre</label><select id="empty-room-timeout" className="admin-input" value={adminSettings.emptyRoomTimeoutSeconds} onChange={e => { setAdminSettings(v => ({...v, emptyRoomTimeoutSeconds: Number(e.target.value)})); setSettingsDirty(true); }}><option value={30}>30 saniye</option><option value={60}>1 dakika</option><option value={120}>2 dakika</option><option value={180}>3 dakika</option><option value={300}>5 dakika</option><option value={600}>10 dakika</option><option value={900}>15 dakika</option></select></div><div className="admin-maintenance-card"><div className="admin-maintenance-copy"><b>Bakım modu</b><p>Açıldığında normal API istekleri bakım mesajıyla 503 döner ve canlı oda bağlantıları kapatılır. Yönetim paneli erişilebilir kalır.</p></div><button type="button" role="switch" aria-checked={adminSettings.maintenanceMode} className={`admin-toggle ${adminSettings.maintenanceMode ? "on" : ""}`} onClick={() => { setAdminSettings(v => ({...v, maintenanceMode: !v.maintenanceMode})); setSettingsDirty(true); }}><span/></button></div><label className="admin-label" htmlFor="maintenance-message">Ziyaretçilere gösterilecek bakım mesajı</label><textarea id="maintenance-message" className="admin-textarea" maxLength={500} value={adminSettings.maintenanceMessage} onChange={e => { setAdminSettings(v => ({...v, maintenanceMessage: e.target.value})); setSettingsDirty(true); }} rows={3}/><div className="admin-settings-actions"><span>{adminSettings.maintenanceMessage.length}/500 karakter · {settingsDirty ? "Kaydedilmemiş değişiklikler" : "Ayarlar kayıtlı"}</span><button className="admin-primary admin-save-settings" onClick={() => void saveSettings()} disabled={busy || !settingsDirty}>{busy ? "Kaydediliyor…" : "Ayarları kaydet"}</button></div><div className="admin-note"><AlertTriangle size={18}/><div><b>Önemli</b><p>Bakım modu yeni Socket.IO bağlantılarını engeller ve açık bağlantıları kapatır. Web sayfasının kendisi yüklenebilir; ziyaretçi API üzerinden işlem yapmaya çalıştığında bakım mesajı alır. Bu sürüm kalıcı hesap/kimlik sistemi kurmaz; kullanıcı yasaklama için önce güvenilir kullanıcı kimliği gerekir.</p></div></div></section>}
    {observedRoomId && <div role="dialog" aria-modal="true" aria-label="Canlı oda gözlemi" onClick={(e) => { if (e.target === e.currentTarget) { stopAudioObservation(); setObservedRoomId(null); } }} style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(3,6,18,.82)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <section style={{width:"min(1180px,100%)",maxHeight:"94vh",overflow:"auto",background:"#101522",color:"#f3f5ff",border:"1px solid #30384d",borderRadius:18,padding:20,boxShadow:"0 24px 80px #0009"}}>
        <div style={{display:"flex",gap:12,alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",marginBottom:14}}><div><div style={{fontSize:11,letterSpacing:2,color:"#a9a1ff",fontWeight:800}}>YETKİLİ MODERASYON · CANLI</div><h2 style={{margin:"5px 0",fontSize:22}}>Oda gözlemi <code style={{fontSize:15,color:"#c5c9d8"}}>{observedRoomId}</code></h2><p style={{margin:0,color:"#aeb6ca",fontSize:13}}>Oda durumu sunucu olayları geldikçe anlık yenilenir. Bu işlem yönetici işlem kayıtlarına eklenir.</p></div><div style={{display:"flex",gap:8,flexWrap:"wrap"}}><button className="admin-primary" onClick={() => observedRoom && (audioSocketRef.current ? stopAudioObservation() : void startAudioObservation(observedRoom))}>{audioSocketRef.current ? "Canlı sesi kapat" : "Canlı ses iste"}</button><button className="admin-secondary" onClick={() => { stopAudioObservation(); setObservedRoomId(null); }}>Gözlemi kapat ✕</button></div></div>
        {!observedRoom ? <div className="admin-empty">Oda artık aktif değil veya sunucu belleğinden kaldırıldı.</div> : <div className="admin-observe-grid" style={{display:"grid",gridTemplateColumns:"minmax(0,1.7fr) minmax(280px,1fr)",gap:16}}>
          <div style={{minWidth:0}}><div style={{aspectRatio:"16/9",background:"#05070c",borderRadius:12,overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center",border:"1px solid #30384d"}}>
            {!observedRoom.videoUrl ? <div style={{textAlign:"center",padding:20,color:"#aeb6ca"}}>Bu odada şu anda video seçilmemiş.</div> : youtubeEmbedUrl(observedRoom.videoUrl) ? <iframe ref={observeYoutubeRef} onLoad={syncObservedPlayer} title="Oda YouTube oynatıcısı" src={youtubeEmbedUrl(observedRoom.videoUrl)!} style={{width:"100%",height:"100%",border:0}} allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen /> : isDirectVideo(observedRoom.videoUrl) ? <video ref={observeVideoRef} key={observedRoom.videoUrl} src={observedRoom.videoUrl} onLoadedMetadata={syncObservedPlayer} controls style={{width:"100%",height:"100%",objectFit:"contain"}} /> : <iframe title="Oda içeriği" src={observedRoom.videoUrl} style={{width:"100%",height:"100%",border:0}} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" allow="autoplay; encrypted-media; picture-in-picture" />}
          </div><div style={{display:"flex",gap:12,flexWrap:"wrap",padding:"12px 2px",color:"#d3d8e8",fontSize:13}}><span className={`admin-status ${observedRoom.playback.isPlaying ? "live" : ""}`}>{observedRoom.playback.isPlaying ? "▶ Oynatılıyor" : "Ⅱ Duraklatıldı"}</span><span>Sunucu zaman konumu: <b>{Math.floor(observedRoom.playback.currentTime || 0)} sn</b></span><span>{observedRoom.participantCount} katılımcı</span><span>{observedRoom.messageCount} mesaj</span></div><p style={{fontSize:12,color:"#98a3bb",lineHeight:1.5}}>Not: Bu önizleme oda bağlantısını görüntülemeyi dener. Bazı üçüncü taraf siteler güvenlik politikaları nedeniyle iframe içinde açılmaz; senkronizasyon bilgisi sunucunun oda durumundan alınır. Yönetici önizlemesi katılımcıların oynatıcısını kontrol etmez.</p>{audioStatus && <div role="status" style={{marginTop:8,padding:10,borderRadius:8,background:"#1b2435",color:"#dce4ff",fontSize:12}}>{audioStatus}</div>}<p style={{fontSize:12,color:"#98a3bb",lineHeight:1.5}}>Canlı ses yalnızca isteği kabul eden katılımcılardan gelir. Her katılımcı erişimi kendi ekranından onaylar.</p></div>
          <div style={{display:"flex",flexDirection:"column",gap:12,minWidth:0}}>
            <section style={{background:"#171e2d",borderRadius:12,padding:12,border:"1px solid #30384d"}}>
              <h3 style={{margin:"0 0 10px",fontSize:15}}>Katılımcılar ve mikrofon</h3>
              {observedRoom.participants.length ? observedRoom.participants.map((person) => (
                <div key={person.id || person.nickname} style={{padding:"9px 0",borderTop:"1px solid #30384d",display:"flex",justifyContent:"space-between",gap:10}}>
                  <div><b>{person.nickname}</b><div style={{fontSize:12,color:"#aeb6ca",marginTop:3}}>{person.deviceInfo || "Cihaz bilinmiyor"} · {person.microphoneEnabled ? "Mikrofon açık" : "Mikrofon kapalı"}</div></div>
                  <span style={{fontSize:11,color:person.microphoneEnabled ? "#6ee7b7" : "#aeb6ca"}}>{person.microphoneEnabled ? "AÇIK" : "KAPALI"}</span>
                </div>
              )) : <p style={{color:"#aeb6ca"}}>Katılımcı yok.</p>}
            </section>
            <section style={{background:"#171e2d",borderRadius:12,padding:12,border:"1px solid #30384d",minHeight:200}}>
              <h3 style={{margin:"0 0 10px",fontSize:15}}>Oda sohbeti · son {Math.min(80, observedRoom.messages?.length || 0)} mesaj</h3>
              <div style={{maxHeight:330,overflowY:"auto",display:"flex",flexDirection:"column",gap:10}}>
                {(observedRoom.messages || []).slice(-80).map((message) => (
                  <div key={message.id} style={{borderTop:"1px solid #30384d",paddingTop:8}}><div style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:12}}><b>{message.nickname}</b><span style={{color:"#8e9ab4"}}>{time(message.createdAt)}</span></div><div style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontSize:13,marginTop:4}}>{message.text}</div></div>
                ))}
                {!observedRoom.messages?.length && <p style={{color:"#aeb6ca"}}>Henüz mesaj yok.</p>}
              </div>
            </section>
          </div>
        </div>}
      </section></div>}
    <footer className="admin-footer"><span><ShieldCheck size={14}/> Güvenli yönetim alanı</span><span>Veriler sunucunun mevcut erişimine göre gösterilir · {updatedAt || "—"}</span></footer></main></div></div>;
}
