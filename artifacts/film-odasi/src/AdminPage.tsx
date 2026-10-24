import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { ArrowLeft, RefreshCw, ShieldCheck, Users, Film, FileVideo, LogOut, AlertTriangle } from "lucide-react";

type Room = { roomId: string; participantCount: number; participants: { nickname: string; microphoneEnabled: boolean }[]; videoUrl: string | null; playback: { isPlaying: boolean; currentTime: number; updatedAt: number }; messageCount: number; lastActivityAt: number };
type FileInfo = { name: string; size: number; modifiedAt: string };
const formatBytes = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1024 * 1024)).toFixed(2)} MB`;

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [tab, setTab] = useState<"rooms" | "files">("rooms");
  const [updatedAt, setUpdatedAt] = useState("");

  const loadData = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const [roomRes, fileRes] = await Promise.all([
        fetch("/api/admin/rooms", { credentials: "same-origin" }),
        fetch("/api/admin/files", { credentials: "same-origin" }),
      ]);
      if (roomRes.status === 401 || fileRes.status === 401) { setLoggedIn(false); return; }
      if (!roomRes.ok || !fileRes.ok) throw new Error("Yönetim verileri alınamadı.");
      const roomData = await roomRes.json(); const fileData = await fileRes.json();
      setRooms(roomData.rooms || []); setFiles(fileData.files || []); setTotalBytes(fileData.totalBytes || 0);
      setUpdatedAt(new Date().toLocaleTimeString("tr-TR"));
    } catch (e) { setError(e instanceof Error ? e.message : "Bağlantı hatası."); }
    finally { setBusy(false); setChecking(false); }
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/me", { credentials: "same-origin" }).then(r => { if (alive && r.ok) { setLoggedIn(true); void loadData(); } else if (alive) setChecking(false); }).catch(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [loadData]);

  async function login(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const r = await fetch("/api/admin/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Giriş başarısız.");
      setLoggedIn(true); setPassword(""); await loadData();
    } catch (e) { setError(e instanceof Error ? e.message : "Giriş yapılamadı."); }
    finally { setBusy(false); }
  }
  async function logout() {
    await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    setLoggedIn(false); setRooms([]); setFiles([]);
  }

  if (checking) return <div className="admin-shell"><div className="admin-login-card">Yönetici oturumu kontrol ediliyor…</div></div>;
  if (!loggedIn) return <div className="admin-shell"><div className="admin-login-card">
    <Link className="admin-back" href="/"><ArrowLeft size={16}/> Ana sayfaya dön</Link>
    <div className="admin-brand-icon"><ShieldCheck size={27}/></div><p className="admin-eyebrow">BİRLİKTE İZLE · GÜVENLİ ALAN</p><h1>Yönetici girişi</h1>
    <p className="admin-muted">Yönetim verilerine yalnızca yetkili hesap erişebilir.</p>
    <form onSubmit={login}><label className="admin-label" htmlFor="admin-password">Yönetici şifresi</label><input id="admin-password" className="admin-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required/><button className="admin-primary" disabled={busy}>{busy ? "Kontrol ediliyor…" : "Güvenli giriş yap"}</button></form>
    {error && <div className="admin-error"><AlertTriangle size={16}/>{error}</div>}
    <p className="admin-footnote">Giriş, sunucu tarafında ADMIN_PASSWORD ile doğrulanır. Bu şifreyi frontend koduna yazma.</p>
  </div></div>;

  return <div className="admin-shell"><header className="admin-header"><Link href="/" className="admin-back"><ArrowLeft size={16}/> Siteye dön</Link><div className="admin-header-title"><div className="admin-brand-icon small"><ShieldCheck size={20}/></div><div><b>Birlikte İzle</b><small>Yönetici paneli</small></div></div><div className="admin-header-actions"><span className="admin-secure-label">● Korumalı oturum</span><button className="admin-quiet-btn" onClick={loadData} disabled={busy}><RefreshCw size={15}/> Yenile</button><button className="admin-quiet-btn" onClick={logout}><LogOut size={15}/> Çıkış</button></div></header>
    <main className="admin-content"><div className="admin-welcome"><div><p className="admin-eyebrow">GÜVENLİK VE MODERASYON</p><h1>Yönetim merkezi</h1><p className="admin-muted">Canlı oda durumu ve sunucuda bulunan video dosyaları.</p></div><span className="admin-updated">Son yenileme: {updatedAt || "—"}</span></div>
      {error && <div className="admin-error"><AlertTriangle size={16}/>{error}</div>}
      <div className="admin-stats"><div className="admin-stat"><span><Users size={18}/> Açık oda</span><b>{rooms.length}</b><small>Şu an bellekte bulunan odalar</small></div><div className="admin-stat"><span><Users size={18}/> Katılımcı</span><b>{rooms.reduce((n,r)=>n+r.participantCount,0)}</b><small>Aktif oda katılımcıları</small></div><div className="admin-stat"><span><FileVideo size={18}/> Sunucudaki video</span><b>{files.length}</b><small>{formatBytes(totalBytes)} toplam</small></div></div>
      <div className="admin-tabs"><button className={tab === "rooms" ? "selected" : ""} onClick={()=>setTab("rooms")}><Users size={16}/> Açık odalar ({rooms.length})</button><button className={tab === "files" ? "selected" : ""} onClick={()=>setTab("files")}><Film size={16}/> Video dosyaları ({files.length})</button></div>
      {tab === "rooms" ? <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Açık odalar</h2><p>Yalnızca bu sunucu sürecinde halen açık olan odalar gösterilir.</p></div><span className="admin-tag">Canlı bellek</span></div>{rooms.length === 0 ? <div className="admin-empty">Şu anda açık oda görünmüyor.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>ODA KODU</th><th>KATILIMCI</th><th>İÇERİK</th><th>OYNATMA</th><th>SON HAREKET</th></tr></thead><tbody>{rooms.map(room=><tr key={room.roomId}><td><b>{room.roomId}</b></td><td><div className="admin-names">{room.participants.map(p=><span key={p.nickname}>{p.nickname}{p.microphoneEnabled ? " · Mikrofon açık" : ""}</span>)}</div></td><td>{room.videoUrl ? <a href={room.videoUrl} target="_blank" rel="noreferrer">Bağlantıyı aç ↗</a> : <span className="admin-muted">İçerik seçilmedi</span>}</td><td><span className={room.playback.isPlaying ? "admin-status live" : "admin-status"}>{room.playback.isPlaying ? "Oynatılıyor" : "Duraklatıldı"}</span></td><td>{room.lastActivityAt ? new Date(room.lastActivityAt).toLocaleTimeString("tr-TR") : "—"}</td></tr>)}</tbody></table></div>}</section> : <section className="admin-panel"><div className="admin-panel-heading"><div><h2>Sunucudaki video dosyaları</h2><p>Dosya adı, boyutu ve son değiştirilme zamanı. Bu liste antivirüs taraması anlamına gelmez.</p></div><span className="admin-tag">{formatBytes(totalBytes)}</span></div>{files.length === 0 ? <div className="admin-empty">Video klasöründe dosya bulunamadı.</div> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>DOSYA</th><th>BOYUT</th><th>SON DEĞİŞİKLİK</th><th>DURUM</th></tr></thead><tbody>{files.map(file=><tr key={file.name}><td><b>{file.name}</b></td><td>{formatBytes(file.size)}</td><td>{new Date(file.modifiedAt).toLocaleString("tr-TR")}</td><td><span className="admin-status">Tarama entegrasyonu bekleniyor</span></td></tr>)}</tbody></table></div>}</section>}
      <div className="admin-note"><ShieldCheck size={18}/><div><b>Güvenlik sınırları</b><p>Bu ilk entegrasyon canlı odaları ve sunucu dosyalarını yetkili yöneticiye gösterir. Henüz üyelik/veritabanı sistemi olmadığı için geçmiş ziyaretçiler, geçmiş izlenen içerikler ve antivirüs sonuçları mevcut değil. Oda moderasyon erişimleri ayrıca kayıt altına alınmalı; gizli ve kayıtsız oda ziyareti bu sürümde yoktur.</p></div></div>
    </main></div>;
}
