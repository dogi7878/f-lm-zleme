import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect, type ChangeEvent, type FormEvent, type ReactNode, type MouseEvent, type TouchEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetCapabilities, useHealthCheck } from '@workspace/api-client-react';
import { io, type Socket } from 'socket.io-client';
import type Hls from 'hls.js';
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import {
  ArrowDownLeft, ArrowLeft, Clipboard, ExternalLink, Film, Headphones, Link2,
  MessageCircle, Mic, MicOff, Pause, Play, Send, ShieldCheck, Sparkles, Users, Wifi, Settings, LogOut, RotateCcw, RotateCw,
  Youtube, Upload, ListVideo, MoreHorizontal, Crown, MonitorPlay, ChevronRight, PictureInPicture2, Maximize2, Grip,
} from 'lucide-react';

declare global {
  interface Window {
    YT?: {
      Player: new (element: string | HTMLElement, options: {
        videoId: string;
        playerVars?: Record<string, number>;
        events?: {
          onReady?: (event: { target: YouTubePlayer }) => void;
          onStateChange?: (event: { data: number; target: YouTubePlayer }) => void;
          onError?: (event: { data: number }) => void;
        };
      }) => YouTubePlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}
type YouTubePlayer = {
  getCurrentTime: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  destroy: () => void;
};

type Participant = { id: string; nickname: string; microphoneEnabled: boolean };
type ChatMessage = { id: string; nickname: string; text: string; createdAt: number };
type Playback = { isPlaying: boolean; currentTime: number; updatedAt: number };
type RoomState = {
  roomId: string;
  videoUrl: string | null;
  playback: Playback;
  participants: Participant[];
  messages: ChatMessage[];
};
type Ack = { ok: boolean; roomId?: string; error?: string; room?: RoomState };
type SignalMessage = { from: string; signal: RTCSessionDescriptionInit | RTCIceCandidateInit };

const queryClient = new QueryClient();
let liveSocket: Socket | null = null;
let activeRoom = '';
let activeNickname = '';
let seededRoom: RoomState | null = null;
const createSocket = () => {
  if (!liveSocket) liveSocket = io({ path: '/api/socket.io', autoConnect: false });
  return liveSocket;
};
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toLocaleUpperCase('tr-TR');
const formatTime = (time: number) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;

const extractYouTubeVideoId = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) return null;
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    const fromQuery = url.searchParams.get('v');
    if (fromQuery) return fromQuery;
    const parts = url.pathname.split('/').filter(Boolean);
    const markerIndex = parts.findIndex((part) => ['embed', 'live', 'shorts', 'v'].includes(part.toLowerCase()));
    if (markerIndex >= 0 && parts[markerIndex + 1]) return parts[markerIndex + 1];
    return null;
  } catch { return null; }
};

function App() {
  return <QueryClientProvider client={queryClient}>
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/:roomId" component={RoomPage} />
      <Route component={NotFound} />
    </Switch>
  </QueryClientProvider>;
}

function HomePage() {
  const [, navigate] = useLocation();
  const [nickname, setNickname] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [pending, setPending] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState('');
  const { data: capabilities, isLoading: capsLoading, isError: capsError, refetch: retryCaps } = useGetCapabilities();
  const { data: health, isLoading: healthLoading, isError: healthError, refetch: retryHealth } = useHealthCheck();
  const serverReady = health?.status === 'ok' || health?.status === 'healthy';

  const connectRoom = (kind: 'create' | 'join', roomId?: string) => {
    const name = nickname.trim();
    if (name.length < 2) { setError('Birlikte izleyecek kişilerin seni tanıması için adın en az 2 karakter olmalı.'); return; }
    if (kind === 'join' && !roomId?.trim()) { setError('Davet bağlantısındaki oda kodunu yaz.'); return; }
    setPending(kind); setError('');
    const socket = createSocket();
    const begin = () => {
      const payload = kind === 'create' ? { nickname: name } : { roomId: roomId!.trim(), nickname: name };
      socket.once('room:state', (state: RoomState) => { seededRoom = state; });
      socket.timeout(10_000).emit(
        kind === 'create' ? 'room:create' : 'room:join',
        payload,
        (timeoutError: Error | null, response: Ack) => {
          setPending(null);
          if (timeoutError) {
            setError('Sunucu 10 saniye içinde yanıt vermedi. Bağlantıyı kontrol edip yeniden dene.');
            return;
          }
          if (!response?.ok || !response.roomId) {
            setError(response?.error || 'Odaya şu an ulaşılamıyor. Birazdan yeniden dene.');
            return;
          }
          activeRoom = response.roomId;
          activeNickname = name;
          seededRoom = response.room ?? seededRoom;
          navigate(`/${encodeURIComponent(response.roomId)}`);
        },
      );
    };
    if (socket.connected) begin();
    else {
      socket.once('connect', begin);
      socket.once('connect_error', () => { setPending(null); setError('Sunucuya bağlanılamadı. Bağlantını kontrol edip yeniden dene.'); });
      socket.connect();
    }
  };

  const onCreate = (event: FormEvent) => { event.preventDefault(); connectRoom('create'); };
  const onJoin = (event: FormEvent) => { event.preventDefault(); connectRoom('join', joinCode); };
  const sourceList = capabilities?.supportedVideoSources?.join(' · ') || '';
  return <div className="app-shell home-premium">
    <header className="topbar home-topbar">
      <Link href="/" className="brand home-brand" data-testid="link-home">
        <span className="brand-mark"><Film size={20} strokeWidth={2.5} /></span>
        <span className="brand-name">BİRLİKTE İZLE</span>
      </Link>
      <nav className="home-nav" aria-label="Ana menü">
        <a className="active" href="#anasayfa">Ana Sayfa</a><a href="#ozellikler">Özellikler</a><a href="#nasil-calisir">Nasıl Çalışır?</a><a href="#sss">SSS</a>
      </nav>
      <div className="home-top-actions"><a className="home-login" href="#giris" onClick={(e) => { e.preventDefault(); document.getElementById('nickname')?.focus(); }}>Giriş Yap</a><a className="home-start" href="#oda-olustur" onClick={(e) => { e.preventDefault(); document.getElementById('nickname')?.focus(); }}>Hemen Başla</a></div>
    </header>
    <main className="landing home-landing" id="anasayfa">
      <section className="home-hero">
        <div className="home-hero-photo" aria-hidden="true"><div className="home-photo-caption"><span className="home-live-dot" /> BU AKŞAM BERABER İZLEYİN</div></div>
        <div className="home-hero-shade" aria-hidden="true" />
        <div className="home-hero-copy">
          <div className="eyebrow">BİRLİKTE İZLEMEK BAŞKA</div>
          <h1 className="hero-title">Aynı anda.<br />Aynı <em>salonda.</em></h1>
          <p className="hero-copy">Bir bağlantı bırak, arkadaşlarını çağır.<br className="desktop-break" /> Film başlasın, sesin, kahkahaların ve sohbetin de aynı yerde olsun.</p>
          <div className="home-actions" id="oda-olustur">
            <form className="home-create-form" onSubmit={onCreate}>
              <label className="home-visually-hidden" htmlFor="nickname">Adın</label>
              <input id="nickname" data-testid="input-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} placeholder="Adını yaz" autoComplete="nickname" />
              <button className="home-create-button" data-testid="button-create-room" type="submit" disabled={pending !== null}><span className="home-button-icon"><span>＋</span></span><span><b>{pending === 'create' ? 'Salon hazırlanıyor…' : 'Oda Oluştur'}</b><small>Kendi salonunu kur</small></span></button>
            </form>
            <form className="home-join-form" onSubmit={onJoin}>
              <label className="home-visually-hidden" htmlFor="room-code-home">Oda kodu</label>
              <input id="room-code-home" data-testid="input-room-code" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Davet kodu" />
              <button className="home-join-button" type="submit" data-testid="button-join-room" disabled={pending !== null}><span className="home-button-icon"><Link2 size={19} /></span><span><b>{pending === 'join' ? 'Katılınıyor…' : 'Odaya Katıl'}</b><small>Arkadaşının davetiyle gir</small></span></button>
            </form>
          </div>
          {error && <div role="alert" className="error-banner" data-testid="status-connect-error">{error}<button onClick={() => setError('')}>Kapat</button></div>}
          {!healthLoading && healthError && <div role="alert" className="error-banner" data-testid="status-health-error">Sunucu durumu alınamadı.<button onClick={() => void retryHealth()}>Yenile</button></div>}
        </div>
        <div className="home-benefits" id="ozellikler">
          <div className="home-benefit"><span><Film size={19} /></span><div><b>HD Kalite</b><small>Kesintisiz izleme</small></div></div>
          <div className="home-benefit"><span><Wifi size={19} /></span><div><b>Eş Zamanlı</b><small>Aynı anı paylaşın</small></div></div>
          <div className="home-benefit"><span><Play size={18} /></span><div><b>Dosya Yükleme</b><small>Kendi videonu aç</small></div></div>
          <div className="home-benefit"><span><MessageCircle size={19} /></span><div><b>Sohbet</b><small>Film keyfine sohbet kat</small></div></div>
          <div className="home-benefit"><span><Users size={19} /></span><div><b>Tamamen Ücretsiz</b><small>Hemen başla</small></div></div>
        </div>
        <div className="home-hero-bottom-glow" aria-hidden="true" />
      </section>
      <section className="home-how" id="nasil-calisir">
        <div className="home-section-heading"><div><span className="eyebrow">BİRLİKTE OLMAK ÇOK KOLAY</span><h2>Nasıl Çalışır?</h2></div><p>Bir salon kur, arkadaşlarını çağır ve aynı anda izlemeye başlayın.</p></div>
        <div className="home-steps">
          <div className="home-step"><span className="home-step-icon">＋</span><div><b>1. Oda Oluştur</b><small>Kendi izleme salonunu kur.</small></div></div>
          <div className="home-step"><span className="home-step-icon"><Link2 size={22} /></span><div><b>2. Arkadaşlarını Davet Et</b><small>Bağlantıyı paylaş.</small></div></div>
          <div className="home-step"><span className="home-step-icon"><Play size={22} fill="currentColor" /></span><div><b>3. Film Seç</b><small>Linkle veya dosya yükleyerek aç.</small></div></div>
          <div className="home-step"><span className="home-step-icon"><Users size={22} fill="currentColor" /></span><div><b>4. Birlikte İzle</b><small>Aynı anda, aynı salonda.</small></div></div>
        </div>
      </section>
      <div className="capability-foot home-capability" data-testid="text-capabilities">
        {capsLoading && <span>Salon özellikleri yükleniyor…</span>}
        {capsError && <span>Salon sınırları şu an yüklenemedi. <button className="btn-text" onClick={() => void retryCaps()}>Yeniden dene</button></span>}
        {capabilities && <span>Desteklenen bağlantılar: {sourceList || 'Sunucu bilgisi bekleniyor'}. {capabilities.voiceLimitations}</span>}
        {!capsLoading && !capsError && !capabilities && <span>Desteklenen herkese açık video kaynaklarıyla birlikte izleyin.</span>}
        {!healthLoading && !healthError && health && <span> · Sunucu {serverReady ? 'hazır' : `durumu: ${health.status}`}</span>}
      </div>
    </main>
  </div>;
}

function Feature({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="feature-item"><span className="feature-icon">{icon}</span><span><b>{title}</b>{text}</span></div>;
}

function RoomPage() {
  const { roomId = '' } = useParams<{ roomId: string }>();
  const [, navigate] = useLocation();
  const [nickname, setNickname] = useState(activeNickname);
  const [room, setRoom] = useState<RoomState | null>(activeRoom === roomId ? seededRoom : null);
  const roomRef = useRef(room);
  useEffect(() => { roomRef.current = room; }, [room]);
  const [socketReady, setSocketReady] = useState(false);
  const [message, setMessage] = useState('');
  const [videoInput, setVideoInput] = useState('');
  const [activeRoomTab, setActiveRoomTab] = useState<'chat' | 'participants' | 'playlist'>('chat');
  const [activeVideoSource, setActiveVideoSource] = useState<'youtube' | 'link' | 'upload'>('youtube');
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [shareBaseUrl, setShareBaseUrl] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try { return window.localStorage.getItem('birlikte-izle-share-base') || ''; } catch { return ''; }
  });
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [micEnabled, setMicEnabled] = useState(false);
  const [audioNeedsTap, setAudioNeedsTap] = useState(false);
  const [videoIsPlaying, setVideoIsPlaying] = useState(false);
  const [videoNeedsTap, setVideoNeedsTap] = useState(false);
  const [joining, setJoining] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const skipInitialRejoinRef = useRef(Boolean(activeRoom === roomId && activeNickname && liveSocket?.connected));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastTouchRef = useRef<{ time: number; x: number } | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const youtubeRef = useRef<YouTubePlayer | null>(null);
  // YouTube IFrame API replaces its target element with an iframe. Keep that
  // target inside an empty React-owned host so React never reconciles a node
  // which the third-party API has replaced.
  const youtubeHostRef = useRef<HTMLDivElement | null>(null);
  const youtubeReadyRef = useRef(false);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const remoteAudioRef = useRef(new Map<string, HTMLAudioElement>());
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatNearBottomRef = useRef(true);
  const previousMessageCountRef = useRef(room?.messages.length ?? 0);
  const miniDragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const miniResizeRef = useRef<{ pointerId: number; startX: number; startY: number; width: number; height: number; edge: string } | null>(null);
  const [miniPlayer, setMiniPlayer] = useState(false);
  const [miniPlayerPosition, setMiniPlayerPosition] = useState<{ x: number; y: number } | null>(null);
  const [miniPlayerSize, setMiniPlayerSize] = useState<{ width: number; height: number } | null>(null);
  const [unreadMessages, setUnreadMessages] = useState(0);
  // Keep a floating player inside the visible viewport when the mobile keyboard opens.
  useEffect(() => {
    if (!miniPlayer || !miniPlayerPosition) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const keepVisible = () => {
      const stage = document.querySelector<HTMLElement>('.cinema-video-stage');
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const left = Math.max(viewport.offsetLeft + 4, Math.min(miniPlayerPosition.x, viewport.offsetLeft + viewport.width - rect.width - 4));
      const top = Math.max(viewport.offsetTop + 4, Math.min(miniPlayerPosition.y, viewport.offsetTop + viewport.height - rect.height - 8));
      setMiniPlayerPosition((current) => current && (current.x !== left || current.y !== top) ? { x: left, y: top } : current);
    };
    viewport.addEventListener('resize', keepVisible);
    viewport.addEventListener('scroll', keepVisible);
    return () => {
      viewport.removeEventListener('resize', keepVisible);
      viewport.removeEventListener('scroll', keepVisible);
    };
  }, [miniPlayer, miniPlayerPosition?.x, miniPlayerPosition?.y]);
  const roomMoreMenuRef = useRef<HTMLDivElement | null>(null);
  const seekHideTimerRef = useRef<number | null>(null);
  const [seekControlsVisible, setSeekControlsVisible] = useState(false);
  const isMember = Boolean(activeNickname && activeRoom === roomId);
  const capabilitiesQuery = useGetCapabilities();
  const cap = capabilitiesQuery.data;

  useEffect(() => {
    if (!moreMenuOpen) return;
    const handleOutsidePress = (event: PointerEvent) => {
      if (roomMoreMenuRef.current && !roomMoreMenuRef.current.contains(event.target as Node)) setMoreMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMoreMenuOpen(false); };
    document.addEventListener('pointerdown', handleOutsidePress);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePress);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [moreMenuOpen]);

  const addPeer = useCallback((peerId: string) => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peersRef.current.set(peerId, pc);
    streamRef.current?.getTracks().forEach((track) => pc.addTrack(track, streamRef.current!));
    pc.onicecandidate = (event) => { if (event.candidate) socketRef.current?.emit('voice:signal', { to: peerId, signal: event.candidate }); };
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current?.emit('voice:signal', { to: peerId, signal: offer });
      } catch { setError('Ses bağlantısı kurulamadı. Birazdan yeniden deneyebilirsin.'); }
    };
    pc.ontrack = (event) => {
      let audio = remoteAudioRef.current.get(peerId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');
        remoteAudioRef.current.set(peerId, audio);
      }
      audio.srcObject = event.streams[0];
      void audio.play().then(() => setAudioNeedsTap(false)).catch(() => setAudioNeedsTap(true));
    };
    return pc;
  }, []);

  useEffect(() => {
    if (!roomId || !nickname || activeRoom !== roomId) return;
    const socket = createSocket();
    socketRef.current = socket;
    const handleState = (state: RoomState) => {
      if (state.roomId !== roomId) return;
      setRoom(state);
      const participantIds = new Set(state.participants.map((person) => person.id));
      for (const [peerId, pc] of peersRef.current) {
        if (participantIds.has(peerId)) continue;
        pc.close();
        peersRef.current.delete(peerId);
        const audio = remoteAudioRef.current.get(peerId);
        if (audio) { audio.pause(); audio.srcObject = null; remoteAudioRef.current.delete(peerId); }
      }
    };
    const handleVideo = ({ videoUrl }: { videoUrl: string | null }) => setRoom((current) => current ? { ...current, videoUrl } : current);
    const handlePlayback = (playback: Playback) => setRoom((current) => current ? { ...current, playback } : current);
    const handleMessage = (incoming: ChatMessage) => setRoom((current) => current ? { ...current, messages: [...current.messages, incoming] } : current);
    const handlePeer = ({ peerId }: { peerId: string; nickname: string }) => { addPeer(peerId); };
    const handleSignal = async ({ from, signal }: SignalMessage) => {
      const pc = addPeer(from);
      if ('type' in signal && signal.type === 'offer') {
        await pc.setRemoteDescription(signal);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice:signal', { to: from, signal: answer });
      } else if ('type' in signal && signal.type === 'answer') {
        await pc.setRemoteDescription(signal);
      } else {
        await pc.addIceCandidate(signal as RTCIceCandidateInit).catch(() => undefined);
      }
    };
    const handleRoomError = ({ message }: { message: string }) => setError(message);
    const handleDisconnect = () => {
      setSocketReady(false);
      streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
      setMicEnabled(false);
      peersRef.current.forEach((pc) => pc.close());
      peersRef.current.clear();
      remoteAudioRef.current.forEach((audio) => { audio.pause(); audio.srcObject = null; });
      remoteAudioRef.current.clear();
    };
    const handleConnectError = () => {
      setSocketReady(false);
      setError('Salona bağlanılamadı. Sunucuya erişim var mı kontrol et.');
    };
    socket.on('room:state', handleState);
    socket.on('room:video', handleVideo);
    socket.on('room:playback', handlePlayback);
    socket.on('room:message', handleMessage);
    socket.on('room:peer-joined', handlePeer);
    socket.on('voice:signal', handleSignal);
    socket.on('room:error', handleRoomError);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    const join = () => {
      if (skipInitialRejoinRef.current) {
        skipInitialRejoinRef.current = false;
        setSocketReady(true);
        return;
      }
      setSocketReady(false);
      socket.emit('room:join', { roomId, nickname }, (response: Ack) => {
        if (!response?.ok) { setError(response?.error || 'Bu salona katılınamadı. Bağlantıyı kontrol et.'); return; }
        activeRoom = roomId; activeNickname = nickname;
        if (response.room) setRoom(response.room);
        setSocketReady(true);
      });
    };
    socket.on('connect', join);
    if (socket.connected) join(); else socket.connect();
    return () => {
      socket.off('room:state', handleState); socket.off('room:video', handleVideo);
      socket.off('room:playback', handlePlayback); socket.off('room:message', handleMessage);
      socket.off('room:peer-joined', handlePeer); socket.off('voice:signal', handleSignal);
      socket.off('room:error', handleRoomError); socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError); socket.off('connect', join);
      socket.disconnect();
      peersRef.current.forEach((pc) => pc.close()); peersRef.current.clear();
      remoteAudioRef.current.forEach((audio) => { audio.pause(); audio.srcObject = null; }); remoteAudioRef.current.clear();
      streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null;
      liveSocket = null; activeRoom = ''; activeNickname = '';
    };
  }, [roomId, nickname, addPeer, isMember]);

  useEffect(() => {
    const count = room?.messages.length ?? 0;
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = count;
    if (count <= previousCount) return;
    const list = chatListRef.current;
    if (!list) return;
    if (chatNearBottomRef.current) {
      list.scrollTop = list.scrollHeight;
      setUnreadMessages(0);
    } else {
      setUnreadMessages((value) => value + (count - previousCount));
    }
  }, [room?.messages.length]);

  const handleChatScroll = () => {
    const list = chatListRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 64;
    chatNearBottomRef.current = nearBottom;
    if (nearBottom) setUnreadMessages(0);
  };

  const jumpToLatestChat = () => {
    const list = chatListRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    chatNearBottomRef.current = true;
    setUnreadMessages(0);
  };

  const startMiniPlayerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!miniPlayer) return;
    const stage = document.querySelector<HTMLElement>('.cinema-video-stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    miniDragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const moveMiniPlayer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = miniDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const stage = document.querySelector<HTMLElement>('.cinema-video-stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    setMiniPlayerPosition({
      x: Math.max(4, Math.min(window.innerWidth - rect.width - 4, event.clientX - drag.offsetX)),
      y: Math.max(4, Math.min(window.innerHeight - rect.height - 72, event.clientY - drag.offsetY)),
    });
    event.preventDefault();
    event.stopPropagation();
  };

  const endMiniPlayerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (miniDragRef.current?.pointerId === event.pointerId) miniDragRef.current = null;
  };

  const startMiniPlayerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!miniPlayer) return;
    const stage = document.querySelector<HTMLElement>('.cinema-video-stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    miniResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, width: rect.width, height: rect.height, edge: event.currentTarget.dataset.edge || 'se' };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const resizeMiniPlayer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = miniResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const dx = event.clientX - resize.startX;
    const dy = event.clientY - resize.startY;
    const horizontal = resize.edge.includes('e') ? dx : resize.edge.includes('w') ? -dx : 0;
    const vertical = resize.edge.includes('s') ? dy : resize.edge.includes('n') ? -dy : 0;
    const width = Math.max(180, Math.min(window.innerWidth - 12, 720, resize.width + horizontal));
    const height = Math.max(105, Math.min(window.innerHeight * 0.78, 720, resize.height + vertical));
    setMiniPlayerSize({ width, height });
    event.preventDefault();
    event.stopPropagation();
  };

  const endMiniPlayerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (miniResizeRef.current?.pointerId === event.pointerId) miniResizeRef.current = null;
  };

  const togglePlayerFullscreen = async () => {
    const stage = document.querySelector<HTMLElement>('.cinema-video-stage');
    if (!stage) return;
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else if (!document.fullscreenElement && stage.requestFullscreen) await stage.requestFullscreen();
    } catch { setToast('Tam ekran bu tarayıcıda desteklenmiyor.'); }
  };
  const isYoutube = useMemo(() => room?.videoUrl ? extractYouTubeVideoId(room.videoUrl) : null, [room?.videoUrl]);
  const isHls = useMemo(() => {
    if (!room?.videoUrl) return false;
    try { return new URL(room.videoUrl).pathname.toLowerCase().endsWith('.m3u8'); }
    catch { return false; }
  }, [room?.videoUrl]);
  const isDirectVideo = useMemo(() => {
    if (!room?.videoUrl) return false;
    try { return /\.(mp4|webm|ogg|m4v)$/i.test(new URL(room.videoUrl).pathname); }
    catch { return false; }
  }, [room?.videoUrl]);
  const isPageLink = Boolean(room?.videoUrl && !isYoutube && !isHls && !isDirectVideo);

  useLayoutEffect(() => {
    const host = youtubeHostRef.current;
    if (!isYoutube || !room?.videoUrl || !host) return;

    let cancelled = false;
    let instance: YouTubePlayer | null = null;
    const previousReadyCallback = window.onYouTubeIframeAPIReady;

    const mountPlayer = () => {
      if (cancelled || !window.YT?.Player || !host.isConnected || instance) return;

      // Only this empty host is owned by React. The mount target itself is
      // created imperatively because the YouTube API replaces it with an iframe.
      host.replaceChildren();
      const target = document.createElement('div');
      target.className = 'youtube-player-target';
      target.style.width = '100%';
      target.style.height = '100%';
      host.appendChild(target);

      try {
        instance = new window.YT.Player(target, {
          videoId: isYoutube,
          playerVars: { controls: 1, modestbranding: 1, rel: 0, playsinline: 1, fs: 1, enablejsapi: 1 },
          events: {
            onReady: ({ target: player }) => {
              if (cancelled) {
                try { player.destroy(); } catch { /* The room may already be closing. */ }
                return;
              }
              youtubeRef.current = player;
              youtubeReadyRef.current = true;
              const latest = roomRef.current;
              const targetTime = (latest?.playback.currentTime ?? 0) + (latest?.playback.isPlaying ? Math.max(0, (Date.now() - latest.playback.updatedAt) / 1000) : 0);
              try { player.seekTo(targetTime, true); } catch { /* Wait for the player to become seekable. */ }
              // A newly loaded YouTube video is already paused by default. Do not
              // issue an unnecessary pause command, which can hide initial playback UI.
              if (latest?.playback.isPlaying) player.playVideo();
            },
            onStateChange: ({ data, target: player }) => {
              if (cancelled || player !== youtubeRef.current) return;
              if (data === 1 || data === 2 || data === 0) {
                socketRef.current?.emit('room:set-playback', { isPlaying: data === 1, currentTime: player.getCurrentTime() });
              }
            },
            onError: ({ data }) => {
              if (!cancelled) setError(`YouTube oynatıcısı açılamadı (kod ${data}). Video yerleştirmeye kapalı olabilir veya YouTube bağlantısı engellenmiş olabilir.`);
            },
          },
        });
        youtubeRef.current = instance;
        youtubeReadyRef.current = false;
      } catch {
        host.replaceChildren();
        if (!cancelled) setError('YouTube oynatıcısı başlatılamadı. Bağlantıyı kontrol edip yeniden dene.');
      }
    };

    const handleApiReady = () => {
      try { previousReadyCallback?.(); } catch { /* Ignore errors in a prior page callback. */ }
      mountPlayer();
    };

    if (window.YT?.Player) {
      mountPlayer();
    } else {
      window.onYouTubeIframeAPIReady = handleApiReady;
      let script = document.querySelector<HTMLScriptElement>('script[data-youtube-iframe-api]');
      if (!script) {
        script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.dataset.youtubeIframeApi = 'true';
        script.onerror = () => {
          if (!cancelled) setError('YouTube oynatıcı betiği yüklenemedi. Ağ veya tarayıcı engellemesini kontrol et.');
        };
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (window.onYouTubeIframeAPIReady === handleApiReady) {
        window.onYouTubeIframeAPIReady = previousReadyCallback;
      }
      youtubeReadyRef.current = false;
      if (youtubeRef.current === instance) youtubeRef.current = null;
      try { instance?.destroy(); } catch { /* YouTube may already have detached its iframe. */ }
      // Do not leave third-party iframe children in the host between videos.
      try { host.replaceChildren(); } catch { /* The host may already be detached. */ }
    };
  }, [isYoutube, room?.videoUrl, roomId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!room?.videoUrl || isYoutube || isPageLink) return;
    let cancelled = false;

    if (isHls) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = room.videoUrl;
        video.load();
      } else {
        void import('hls.js').then(({ default: HlsPlayer }) => {
          if (cancelled) return;
          if (!HlsPlayer.isSupported()) {
            setError('Bu tarayıcı HLS videolarını oynatamıyor. Kaynağın doğrudan MP4 bağlantısı varsa onu dene.');
            return;
          }
          const hls = new HlsPlayer({ emeEnabled: false });
          hlsRef.current = hls;
          hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            setError('HLS akışı yüklenemedi. Kaynak erişimi engelliyor, bağlantı desteklenmiyor veya akış korumalı olabilir.');
            hls.destroy();
            if (hlsRef.current === hls) hlsRef.current = null;
          });
          hls.loadSource(room.videoUrl!);
          hls.attachMedia(video);
        }).catch(() => {
          if (!cancelled) setError('HLS oynatıcı yüklenemedi. Daha sonra yeniden dene veya doğrudan MP4 bağlantısı kullan.');
        });
      }
    } else {
      video.src = room.videoUrl;
      video.load();
    }

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [room?.videoUrl, isYoutube, isHls, isPageLink]);

  const currentUser = room?.participants.find((person) => person.id === socketRef.current?.id);
  useEffect(() => { if (currentUser) setMicEnabled(currentUser.microphoneEnabled); }, [currentUser?.microphoneEnabled]);
  const setVideo = (event: FormEvent) => {
    event.preventDefault();
    const url = videoInput.trim();
    if (!url) { setError('Önce bir video bağlantısı ekle.'); return; }
    let parsed: URL;
    try { parsed = new URL(url); } catch { setError('Geçerli ve herkese açık bir video bağlantısı yaz.'); return; }
    if (parsed.protocol !== 'https:') { setError('Güvenli bağlantı için video URL’si HTTPS ile başlamalı.'); return; }
    const videoId = extractYouTubeVideoId(url) || '';
    const validYoutube = /^[\w-]{11}$/.test(videoId);
    const supportedDirect = /\.(mp4|webm|ogg|m4v)$/i.test(parsed.pathname);
    const supportedHls = /\.m3u8$/i.test(parsed.pathname);
    setVideoIsPlaying(false); setVideoNeedsTap(false);
    socketRef.current?.emit('room:set-video', { videoUrl: url });
    setVideoInput(''); setError('');
    if (!validYoutube && !supportedDirect && !supportedHls) {
      setToast('Sayfa bağlantısı odadakilerle paylaşıldı; salon içinde oynatılamaz.');
      window.setTimeout(() => setToast(''), 3200);
    }
  };
  const uploadLocalVideo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const allowed = /\.(mp4|webm|ogg|m4v)$/i.test(file.name);
    if (!allowed) { setError('MP4, WebM, Ogg veya M4V dosyası seç. MKV gibi bazı biçimler tarayıcıda oynatılmaz.'); return; }
    if (file.size <= 0 || file.size > 2 * 1024 * 1024 * 1024) { setError('Dosya boş olamaz ve en fazla 2 GB olabilir.'); return; }
    setError('');
    setUploadProgress(0);
    try {
      const initResponse = await fetch('/api/uploads/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
      });
      const init = await initResponse.json() as { uploadId?: string; chunkSize?: number; chunks?: number; error?: string };
      if (!initResponse.ok || !init.uploadId || !init.chunkSize || !init.chunks) throw new Error(init.error || 'Yükleme başlatılamadı.');
      for (let index = 0; index < init.chunks; index++) {
        const start = index * init.chunkSize;
        const chunk = file.slice(start, Math.min(start + init.chunkSize, file.size));
        const response = await fetch(`/api/uploads/${init.uploadId}/chunk?index=${index}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk,
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || `Dosya parçası ${index + 1} yüklenemedi.`);
        setUploadProgress(Math.min(99, Math.round(((index + 1) / init.chunks) * 100)));
      }
      const completeResponse = await fetch(`/api/uploads/${init.uploadId}/complete`, { method: 'POST' });
      const complete = await completeResponse.json() as { url?: string; error?: string };
      if (!completeResponse.ok || !complete.url) throw new Error(complete.error || 'Video dosyası tamamlanamadı.');
      const videoUrl = new URL(complete.url, window.location.origin).toString();
      setVideoIsPlaying(false); setVideoNeedsTap(true);
      socketRef.current?.emit('room:set-video', { videoUrl });
      setVideoInput('');
      setUploadProgress(100);
      setToast('Video yüklendi ve salondaki herkesle paylaşıldı.');
      window.setTimeout(() => setToast(''), 3200);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Video yüklenirken bir hata oluştu.');
    } finally {
      window.setTimeout(() => setUploadProgress(null), 1800);
    }
  };

  const submitChat = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text || text.length > 500) return;
    socketRef.current?.emit('room:chat', { text });
    setMessage('');
  };
  const enableRemoteAudio = async () => {
    const audios = [...remoteAudioRef.current.values()];
    if (!audios.length) {
      setAudioNeedsTap(false);
      setToast('Ses bağlantısı bekleniyor. Karşı tarafın mikrofonu açık mı kontrol edin.');
      window.setTimeout(() => setToast(''), 3200);
      return;
    }
    const results = await Promise.all(audios.map((audio) => audio.play().then(() => true).catch(() => false)));
    setAudioNeedsTap(results.some((ok) => !ok));
    if (results.every(Boolean)) { setError(''); setToast('Karşı tarafın sesi etkinleştirildi.'); window.setTimeout(() => setToast(''), 2400); }
    else setError('Telefon ses oynatmayı engelliyor olabilir. Sayfayı yenilemeden önce tarayıcı sesini ve oda sesini kontrol et.');
  };

  const toggleMic = async () => {
    if (micEnabled) {
      streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
      socketRef.current?.emit('room:set-mic', { enabled: false }); setMicEnabled(false); return;
    }
    if (streamRef.current?.getAudioTracks().some((track) => track.readyState === 'live')) {
      streamRef.current.getAudioTracks().forEach((track) => { track.enabled = true; });
      for (const person of room?.participants ?? []) {
        if (person.id === socketRef.current?.id) continue;
        const pc = addPeer(person.id);
        const trackIds = new Set(pc.getSenders().map((sender) => sender.track?.id).filter(Boolean));
        streamRef.current.getAudioTracks().forEach((track) => {
          if (!trackIds.has(track.id)) pc.addTrack(track, streamRef.current!);
        });
      }
      socketRef.current?.emit('room:set-mic', { enabled: true });
      setMicEnabled(true);
      setError('');
      return;
    }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname.toLowerCase());
    if (!navigator.mediaDevices?.getUserMedia || (!window.isSecureContext && !loopback)) {
      setError('Mikrofon için HTTPS bağlantısı gerekli. Telefonda Cloudflare Global Server adresinin https:// ile başlayan bağlantısını aç; bilgisayarda localhost kullanılabilir.');
      return;
    }
    setJoining(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => { track.enabled = true; });
      for (const person of room?.participants ?? []) {
        if (person.id === socketRef.current?.id) continue;
        const pc = addPeer(person.id);
        const trackIds = new Set(pc.getSenders().map((sender) => sender.track?.id).filter(Boolean));
        stream.getAudioTracks().forEach((track) => {
          if (!trackIds.has(track.id)) pc.addTrack(track, stream);
        });
      }
      socketRef.current?.emit('room:set-mic', { enabled: true });
      setMicEnabled(true); setError('');
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : (cause as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        setError('Mikrofon izni reddedildi. Adres çubuğundaki kilit/ayar simgesinden Mikrofon → İzin ver seç; sonra sayfayı yenileyip tekrar dene.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('Bu cihazda kullanılabilir mikrofon bulunamadı. Mikrofonun bağlı olduğunu kontrol et.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setError('Mikrofon başka bir uygulama tarafından kullanılıyor olabilir. Diğer uygulamaları kapatıp tekrar dene.');
      } else {
        setError('Mikrofon açılamadı. HTTPS/Cloudflare bağlantısını ve tarayıcı izinlerini kontrol et.');
      }
    } finally { setJoining(false); }
  };
  const togglePlayback = async () => {
    if (!room) return;
    if (youtubeRef.current && youtubeReadyRef.current) {
      // YouTube uses its own native player controls; this fallback remains for other UI actions.
      if (room.playback.isPlaying) youtubeRef.current.pauseVideo(); else youtubeRef.current.playVideo();
      socketRef.current?.emit('room:set-playback', { isPlaying: !room.playback.isPlaying, currentTime: youtubeRef.current.getCurrentTime() });
      return;
    }
    const element = videoRef.current;
    if (element) {
      if (element.paused) {
        try {
          await element.play();
          setVideoNeedsTap(false);
          setVideoIsPlaying(true);
          setError('');
          socketRef.current?.emit('room:set-playback', { isPlaying: true, currentTime: element.currentTime });
        } catch {
          setVideoNeedsTap(true);
          setVideoIsPlaying(false);
          setToast('Videoyu başlatmak için oynat düğmesine dokun.');
          window.setTimeout(() => setToast(''), 2600);
        }
      } else {
        element.pause();
        setVideoIsPlaying(false);
        socketRef.current?.emit('room:set-playback', { isPlaying: false, currentTime: element.currentTime });
      }
    } else socketRef.current?.emit('room:set-playback', { isPlaying: !room.playback.isPlaying, currentTime: room.playback.currentTime });
  };
  const seekBy = (delta: number) => {
    if (youtubeRef.current && youtubeReadyRef.current) {
      const next = Math.max(0, youtubeRef.current.getCurrentTime() + delta);
      youtubeRef.current.seekTo(next, true);
      socketRef.current?.emit('room:set-playback', { isPlaying: roomRef.current?.playback.isPlaying ?? true, currentTime: next });
      setToast(delta > 0 ? '+10 saniye' : '−10 saniye');
      window.setTimeout(() => setToast(''), 900);
      return;
    }
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) {
      setToast('Bu oynatıcıda ileri/geri sarma desteklenmiyor');
      window.setTimeout(() => setToast(''), 1800);
      return;
    }
    const next = Math.max(0, Math.min(video.duration, video.currentTime + delta));
    video.currentTime = next;
    socketRef.current?.emit('room:set-playback', { isPlaying: !video.paused, currentTime: next });
    setToast(delta > 0 ? '+10 saniye' : '−10 saniye');
    window.setTimeout(() => setToast(''), 900);
  };
  const revealSeekControls = () => {
    setSeekControlsVisible(true);
    if (seekHideTimerRef.current !== null) window.clearTimeout(seekHideTimerRef.current);
    seekHideTimerRef.current = window.setTimeout(() => setSeekControlsVisible(false), 2200);
  };
  useEffect(() => () => {
    if (seekHideTimerRef.current !== null) window.clearTimeout(seekHideTimerRef.current);
  }, []);
  const handleStageDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, a, input')) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    seekBy(event.clientX - bounds.left >= bounds.width / 2 ? 10 : -10);
  };
  const handleStageTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, a, input')) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const now = Date.now();
    const previous = lastTouchRef.current;
    if (previous && now - previous.time < 320) {
      const bounds = event.currentTarget.getBoundingClientRect();
      seekBy(touch.clientX - bounds.left >= bounds.width / 2 ? 10 : -10);
      lastTouchRef.current = null;
    } else {
      lastTouchRef.current = { time: now, x: touch.clientX };
    }
  };
  const handleVideoPlay = () => {
    const video = videoRef.current;
    if (!video) return;
    setVideoIsPlaying(true); setVideoNeedsTap(false);
    socketRef.current?.emit('room:set-playback', { isPlaying: true, currentTime: video.currentTime });
  };
  const handleVideoPause = () => {
    const video = videoRef.current;
    if (!video) return;
    setVideoIsPlaying(false);
    socketRef.current?.emit('room:set-playback', { isPlaying: false, currentTime: video.currentTime });
  };
  const handleVideoSeek = () => { if (videoRef.current) socketRef.current?.emit('room:set-playback', { isPlaying: !videoRef.current.paused, currentTime: videoRef.current.currentTime }); };
  const handleVideoMetadata = () => {
    const video = videoRef.current;
    const playback = roomRef.current?.playback;
    if (!video || !playback) return;
    const targetTime = playback.currentTime + (playback.isPlaying ? Math.max(0, (Date.now() - playback.updatedAt) / 1000) : 0);
    if (Math.abs(video.currentTime - targetTime) > 1.5) {
      try { video.currentTime = targetTime; } catch { /* Wait for the stream to become seekable. */ }
    }
    if (playback.isPlaying && video.paused) {
      void video.play().then(() => {
        setVideoNeedsTap(false); setVideoIsPlaying(true);
      }).catch(() => {
        // Browser autoplay policy: keep the room usable and expose our visible
        // center play button instead of showing a fatal-looking error banner.
        setVideoNeedsTap(true); setVideoIsPlaying(false);
      });
    }
  };
  useEffect(() => {
    const video = videoRef.current;
    const playback = room?.playback;
    const targetTime = playback
      ? playback.currentTime + (playback.isPlaying ? Math.max(0, (Date.now() - playback.updatedAt) / 1000) : 0)
      : 0;
    if (isYoutube && room && youtubeRef.current && youtubeReadyRef.current) {
      const player = youtubeRef.current;
      if (Math.abs(player.getCurrentTime() - targetTime) > 2) player.seekTo(targetTime, true);
      if (room.playback.isPlaying) player.playVideo(); else player.pauseVideo();
      return;
    }
    if (!video || !room?.videoUrl || isYoutube) return;
    if (video.readyState >= 1 && Math.abs(video.currentTime - targetTime) > 1.5) {
      try { video.currentTime = targetTime; } catch { /* Metadata may not be seekable yet. */ }
    }
    if (room.playback.isPlaying && video.paused) {
      void video.play().then(() => {
        setVideoNeedsTap(false); setVideoIsPlaying(true);
      }).catch(() => {
        setVideoNeedsTap(true); setVideoIsPlaying(false);
      });
    }
    if (!room.playback.isPlaying && !video.paused) video.pause();
  }, [room?.playback.currentTime, room?.playback.isPlaying, room?.playback.updatedAt, room?.videoUrl, isYoutube]);

  const copyTextToClipboard = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch { /* Legacy selection copy is useful on local HTTP and older mobile browsers. */ }
    try {
      const field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      field.style.pointerEvents = 'none';
      document.body.appendChild(field);
      field.focus();
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      return copied;
    } catch { return false; }
  };
  const isLoopbackHost = (host: string) => ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host.toLowerCase());
  const configureShareAddress = () => {
    const defaultValue = shareBaseUrl || (isLoopbackHost(window.location.hostname) ? '' : window.location.origin);
    const entered = window.prompt(
      'Telefondan açılabilecek paylaşım adresini gir. Global Server terminalindeki HTTPS Cloudflare adresini veya aynı Wi-Fi için bilgisayarının Network adresini yaz. Örnek: https://ornek.trycloudflare.com',
      defaultValue,
    );
    if (entered === null) return;
    const trimmed = entered.trim();
    if (!trimmed) {
      setShareBaseUrl('');
      try { window.localStorage.removeItem('birlikte-izle-share-base'); } catch { /* Storage may be disabled. */ }
      setToast('Özel paylaşım adresi kaldırıldı.');
      window.setTimeout(() => setToast(''), 2400);
      return;
    }
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('invalid');
      const normalized = parsed.origin;
      setShareBaseUrl(normalized);
      try { window.localStorage.setItem('birlikte-izle-share-base', normalized); } catch { /* Keep it for this page session. */ }
      setToast('Paylaşım adresi kaydedildi. Cloudflare adresi değişirse buradan güncelle.');
      window.setTimeout(() => setToast(''), 3000);
    } catch {
      setToast('Geçerli bir http:// veya https:// adresi gir.');
      window.setTimeout(() => setToast(''), 2600);
    }
  };
  const copyRoomCode = async () => {
    const copied = await copyTextToClipboard(roomId);
    if (copied) setToast('Oda kodu kopyalandı.');
    else window.prompt('Oda kodunu kopyala:', roomId);
    window.setTimeout(() => setToast(''), 2400);
  };
  const copyInvite = async () => {
    let origin = shareBaseUrl || window.location.origin;
    if (isLoopbackHost(window.location.hostname) && !shareBaseUrl) {
      const entered = window.prompt(
        'Bu sayfa localhost üzerinden açık; bu bağlantı telefonda çalışmaz. Global Server terminalindeki Cloudflare HTTPS adresini veya aynı Wi-Fi için Vite Network adresini buraya yapıştır.',
        '',
      );
      if (entered === null || !entered.trim()) {
        setToast('Önce Global/Cloudflare adresini üç nokta menüsünden ayarlayabilirsin.');
        window.setTimeout(() => setToast(''), 3000);
        return;
      }
      try {
        const parsed = new URL(entered.trim());
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('invalid');
        origin = parsed.origin;
        setShareBaseUrl(origin);
        try { window.localStorage.setItem('birlikte-izle-share-base', origin); } catch { /* Browser storage can be unavailable. */ }
      } catch {
        setToast('Geçerli bir http:// veya https:// adresi gir.');
        window.setTimeout(() => setToast(''), 2600);
        return;
      }
    }
    const inviteUrl = new URL(`${window.location.pathname}${window.location.search}`, origin).toString();
    const copied = await copyTextToClipboard(inviteUrl);
    if (copied) setToast('Davet bağlantısı kopyalandı. Telefonda açılmazsa Cloudflare adresini kullan.');
    else window.prompt('Davet bağlantısını kopyala:', inviteUrl);
    window.setTimeout(() => setToast(''), 3000);
  };
  if (!isMember && !socketReady) return <div className="app-shell">
    <header className="topbar"><Link href="/" className="brand"><span className="brand-mark"><Film size={19} /></span><span className="brand-name">salon</span></Link><div className="topbar-note"><i /> Davetli salon</div></header>
    <main className="landing" style={{ maxWidth: 600, minHeight: '70vh', display: 'grid', placeItems: 'center' }}>
      <form className="create-panel" onSubmit={(event) => { event.preventDefault(); if (nickname.trim().length < 2) { setError('Adın en az 2 karakter olmalı.'); return; } setNickname(nickname.trim()); activeNickname = nickname.trim(); setJoining(true); const socket = createSocket(); const enter = () => socket.timeout(10_000).emit(
          'room:join',
          { roomId, nickname: activeNickname },
          (timeoutError: Error | null, response: Ack) => {
            setJoining(false);
            if (timeoutError) {
              setError('Sunucu 10 saniye içinde yanıt vermedi. Bağlantıyı kontrol edip yeniden dene.');
            } else if (!response?.ok) {
              setError(response?.error || 'Odaya katılınamadı.');
            } else {
              activeRoom = roomId;
              if (response.room) setRoom(response.room);
              setSocketReady(true);
            }
          },
        ); if (socket.connected) enter(); else { socket.once('connect', enter); socket.once('connect_error', () => { setJoining(false); setError('Salona bağlanılamadı. Sunucuya erişim var mı kontrol et.'); }); socket.connect(); } }}>
        <div className="eyebrow">Davetin hazır</div><h1 className="room-title" style={{ fontSize: 29, margin: '14px 0 18px' }}>Salona geçmeden önce…</h1>
        <label className="form-label" htmlFor="room-nickname">Sana nasıl seslenelim?</label><div className="input-wrap"><Users size={17} /><input id="room-nickname" data-testid="input-room-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Adını yaz" maxLength={24} /></div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button className="btn-primary" data-testid="button-enter-room" type="submit" disabled={joining}>{joining ? 'Salona bağlanıyor…' : 'Salona katıl'}</button>
      </form>
    </main>
  </div>;

  return <div className="app-shell room-premium-shell">
    <header className="topbar room-topbar">
      <Link href="/" className="brand room-brand" data-testid="link-home">
        <span className="brand-mark"><Film size={21} strokeWidth={2.6} /></span>
        <span className="brand-name">BİRLİKTE <em>İZLE</em></span>
      </Link>
      <nav className="room-primary-nav" aria-label="Ana menü">
        <a className="room-nav-active" href="/">Ana Sayfa</a>
        <a href="/#ozellikler">Özellikler</a>
        <a href="/#nasil-calisir">Nasıl Çalışır?</a>
        <a href="/#sss">SSS</a>
      </nav>
      <div className="room-topbar-actions">
        <span className="room-head-count"><Users size={16} /><b>{room?.participants.length ?? 0} kişi</b></span>
        <button className="room-top-button" type="button" onClick={() => { setToast('Oda ayarları'); window.setTimeout(() => setToast(''), 1400); }}><Settings size={17} /> Ayarlar</button>
        <button className="room-top-exit" type="button" onClick={() => { socketRef.current?.disconnect(); activeRoom = ''; seededRoom = null; navigate('/'); }}><LogOut size={17} /> Odadan Çık</button>
      </div>
    </header>
    <main className="room-layout cinema-layout">
      <section className="watch-main">
        <div className="room-header">
          <div className="room-heading-copy">
            <h1 className="room-title">Bu akşamın salonu <Crown className="room-title-crown" size={21} fill="currentColor" /></h1>
            <div className="room-kicker">
              <span className="room-meta-chip">Oda: {roomId}<button type="button" aria-label="Oda bağlantısını kopyala" onClick={() => void copyInvite()}><Clipboard size={13} /></button></span>
              <span className="room-meta-chip"><Users size={12} /> {room?.participants.length ?? 0} kişi</span>
              <span className="room-status-chip"><i /> {socketReady ? 'Canlı' : 'Bağlanıyor'}</span>
              <span className="room-meta-chip room-theme-chip">Film Gecesi</span>
            </div>
          </div>
          <div className="room-actions">
            <button className="pill-action" data-testid="button-copy-invite" onClick={() => void copyInvite()}><Link2 size={15} /> Davet Et</button>
            {(audioNeedsTap || (room?.participants.length ?? 0) > 1) && <button className="pill-action" data-testid="button-enable-remote-audio" onClick={() => void enableRemoteAudio()}><Headphones size={15} /> Sesi Aç</button>}
            <button className={`pill-action ${micEnabled ? 'mic-is-on' : ''}`} data-testid="button-toggle-mic" onClick={() => void toggleMic()} disabled={joining} title={micEnabled ? 'Mikrofonu kapat' : 'Mikrofonu aç'}>{micEnabled ? <Mic size={15} /> : <MicOff size={15} />}{joining ? 'İzin bekleniyor' : 'Mikrofon'}</button>
            <button className="pill-action settings-action" type="button" onClick={() => { setToast('Oda ayarları'); window.setTimeout(() => setToast(''), 1400); }}><Settings size={16} /> Ayarlar</button>
            <div className="room-more-wrap" ref={roomMoreMenuRef}>
              <button className="pill-action more-action" type="button" aria-label="Diğer oda seçenekleri" aria-haspopup="menu" aria-expanded={moreMenuOpen} onClick={() => setMoreMenuOpen((open) => !open)}><MoreHorizontal size={18} /></button>
              {moreMenuOpen && <div className="room-more-menu" role="menu" aria-label="Oda seçenekleri">
                <div className="room-more-menu-heading">Oda seçenekleri</div>
                <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); void copyInvite(); }}><Link2 size={16} /><span><b>Davet bağlantısını kopyala</b><small>Arkadaşını aynı odaya çağır</small></span></button>
                <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); void copyRoomCode(); }}><Clipboard size={16} /><span><b>Oda kodunu kopyala</b><small>{roomId}</small></span></button>
                <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); configureShareAddress(); }}><ExternalLink size={16} /><span><b>Paylaşım adresini ayarla</b><small>{shareBaseUrl || (isLoopbackHost(window.location.hostname) ? 'Cloudflare / Network adresi gerekli' : window.location.origin)}</small></span></button>
                <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); setActiveRoomTab('participants'); }}><Users size={16} /><span><b>Katılımcıları göster</b><small>Salondaki kişileri görüntüle</small></span></button>
                <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); setActiveRoomTab('playlist'); }}><ListVideo size={16} /><span><b>Oynatma listesini aç</b><small>Paylaşılan videoya git</small></span></button>
                <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); void toggleMic(); }} disabled={joining}><span className="room-more-menu-icon">{micEnabled ? <Mic size={16} /> : <MicOff size={16} />}</span><span><b>{micEnabled ? 'Mikrofonu kapat' : 'Mikrofonu aç'}</b><small>{micEnabled ? 'Mikrofon şu an açık' : 'Tarayıcı izin isteyebilir'}</small></span></button>
                {(audioNeedsTap || (room?.participants.length ?? 0) > 1) && <button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); void enableRemoteAudio(); }}><Headphones size={16} /><span><b>Karşı tarafın sesini aç</b><small>Ses iznini yeniden dene</small></span></button>}
              </div>}
            </div>
          </div>
        </div>
        {error && <div role="alert" className="error-banner" data-testid="status-room-error">{error}<button onClick={() => setError('')}>Kapat</button></div>}
        <div className={`video-stage cinema-video-stage ${miniPlayer ? 'mini-player-active' : ''}`} style={miniPlayer ? { ...(miniPlayerPosition ? { left: miniPlayerPosition.x, top: miniPlayerPosition.y, right: 'auto', bottom: 'auto' } : {}), ...(miniPlayerSize ? { width: miniPlayerSize.width, height: miniPlayerSize.height, aspectRatio: 'auto' } : {}) } : undefined} data-testid="video-stage" onTouchStart={revealSeekControls} onTouchEnd={handleStageTouchEnd} onPointerMove={(event) => { if (event.pointerType === 'mouse') revealSeekControls(); }} onPointerLeave={(event) => { if (event.pointerType === 'mouse') setSeekControlsVisible(false); }}>
          <div className="mini-player-toolbar" aria-label="Oynatıcı kontrolleri">
            {miniPlayer && <button type="button" className="mini-player-drag" aria-label="Mini oynatıcıyı taşı" title="Buradan tutup sürükle" onPointerDown={startMiniPlayerDrag} onPointerMove={moveMiniPlayer} onPointerUp={endMiniPlayerDrag} onPointerCancel={endMiniPlayerDrag}><Grip size={17} /><span>Taşı</span></button>}
            <button type="button" className="mini-player-toggle" aria-label={miniPlayer ? 'Normal oynatıcıya dön' : 'Mini oynatıcıyı aç'} title={miniPlayer ? 'Normal boyuta dön' : 'Mini oynatıcı'} onClick={(event) => { event.stopPropagation(); setMiniPlayer((value) => !value); setMiniPlayerPosition(null); setMiniPlayerSize(null); }}>{miniPlayer ? <Maximize2 size={16} /> : <PictureInPicture2 size={16} />}</button>
            {!miniPlayer && <button type="button" className="mini-player-fullscreen" aria-label="Tam ekran" title="Tam ekran" onClick={(event) => { event.stopPropagation(); void togglePlayerFullscreen(); }}><Maximize2 size={16} /></button>}
          </div>
          {miniPlayer && <>
            {['n','e','s','w','ne','nw','se','sw'].map((edge) => <button key={edge} type="button" data-edge={edge} className={`mini-player-edge mini-player-edge-${edge}`} aria-label={`Oynatıcıyı ${edge} kenarından boyutlandır`} onPointerDown={startMiniPlayerResize} onPointerMove={resizeMiniPlayer} onPointerUp={endMiniPlayerResize} onPointerCancel={endMiniPlayerResize} />)}
          </>}
          {room?.videoUrl && isYoutube
            ? <div ref={youtubeHostRef} className="youtube-player-host" aria-label="Eşzamanlı YouTube videosu" />
            : room?.videoUrl && isPageLink
              ? <div className="embedded-source-wrap">
                  <iframe
                    className="embedded-source-player"
                    src={room.videoUrl}
                    title="Gömülü film oynatıcısı"
                    allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                    allowFullScreen
                    referrerPolicy="no-referrer-when-downgrade"
                  />
                  <a className="embedded-source-fallback" href={room.videoUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} /> Oynatıcı açılmazsa kaynağı yeni sekmede aç</a>
                </div>
              : room?.videoUrl
                ? <video ref={videoRef} controls playsInline onLoadedMetadata={handleVideoMetadata} onPlay={handleVideoPlay} onPause={handleVideoPause} onSeeked={handleVideoSeek} onError={() => setError(isHls ? 'HLS akışı yüklenemedi. Kaynak herkese açık ve tarayıcıdan erişilebilir olmalı; DRM/erişim korumalı akışlar desteklenmez.' : 'Video yüklenemedi. Doğrudan MP4, WebM veya Ogg bağlantısı olduğundan ve kaynağın erişime izin verdiğinden emin ol.')} />
                : <div className="video-empty cinema-video-empty"><div className="film-icon"><Film size={26} /></div><h2>Film gecesi için yer açıldı</h2><p>İzlemek istediğin videonun bağlantısını ekle veya bilgisayarından bir video yükle. Oynatma odadaki herkesle eşzamanlanır.</p></div>}
          {!room?.videoUrl && <div className="stage-overlay"><span className="sync-badge"><Wifi size={12} /> Eşzamanlı salon</span><span className="sync-badge">{formatTime(room?.playback.currentTime || 0)}</span></div>}
          {Boolean(room?.videoUrl && !isYoutube && !isPageLink && !videoIsPlaying) && <div className="local-video-center-overlay"><button className="play-big local-video-center-play" aria-label="Videoyu oynat" onClick={() => void togglePlayback()}><Play size={24} fill="currentColor" /></button><span>{videoNeedsTap ? 'Oynatmak için dokun' : 'Videoyu başlat'}</span></div>}
          {room?.videoUrl && !isPageLink && <div className={`seek-overlay ${seekControlsVisible ? 'seek-overlay-visible' : ''}`} aria-label="Video sarma kontrolleri">
            <button type="button" className="seek-button seek-back" onClick={(event) => { event.stopPropagation(); revealSeekControls(); seekBy(-10); }} aria-label="10 saniye geri sar"><RotateCcw size={22}/><span>10</span></button>
            <button type="button" className="seek-button seek-forward" onClick={(event) => { event.stopPropagation(); revealSeekControls(); seekBy(10); }} aria-label="10 saniye ileri sar"><RotateCw size={22}/><span>10</span></button>
          </div>}
        </div>

        <div className="room-source-grid" aria-label="Video kaynağı seçimi">
          <button type="button" className={`room-source-card source-youtube ${activeVideoSource === 'youtube' ? 'source-selected' : ''}`} onClick={() => { setActiveVideoSource('youtube'); document.getElementById('room-video-url')?.focus(); }}>
            <span className="source-icon source-youtube-icon"><Youtube size={22} fill="currentColor" /></span><span><b>YouTube</b><small>Video izle</small></span>
          </button>
          <button type="button" className={`room-source-card ${activeVideoSource === 'link' ? 'source-selected' : ''}`} onClick={() => { setActiveVideoSource('link'); document.getElementById('room-video-url')?.focus(); }}>
            <span className="source-icon"><Link2 size={23} /></span><span><b>Video Bağlantısı</b><small>MP4, HLS, WebM</small></span>
          </button>
          <button type="button" className={`room-source-card ${activeVideoSource === 'upload' ? 'source-selected' : ''}`} onClick={() => { setActiveVideoSource('upload'); fileInputRef.current?.click(); }} disabled={uploadProgress !== null && uploadProgress < 100}>
            <span className="source-icon"><Upload size={23} /></span><span><b>Dosya Yükle</b><small>{uploadProgress !== null && uploadProgress < 100 ? `Yükleniyor %${uploadProgress}` : 'Bilgisayardan seç'}</small></span>
          </button>
          <button type="button" className={`room-source-card ${activeRoomTab === 'playlist' ? 'source-selected' : ''}`} onClick={() => setActiveRoomTab('playlist')}>
            <span className="source-icon"><ListVideo size={23} /></span><span><b>Oynatma Listesi</b><small>Sıralı oynat</small></span>
          </button>
        </div>
        <form className="video-urlbar cinema-video-urlbar" onSubmit={setVideo}>
          <span className="video-link-symbol"><Link2 size={19} /></span>
          <input id="room-video-url" data-testid="input-video-url" aria-label="Video bağlantısı" value={videoInput} onChange={(e) => setVideoInput(e.target.value)} placeholder={activeVideoSource === 'youtube' ? 'YouTube linki yapıştırın…' : 'Video bağlantısını yapıştırın…'} />
          <button className="url-submit" data-testid="button-set-video" type="submit"><Play size={16} fill="currentColor" /> Başlat</button>
        </form>
        <input ref={fileInputRef} type="file" accept=".mp4,.webm,.ogg,.m4v,video/mp4,video/webm,video/ogg" onChange={(event) => void uploadLocalVideo(event)} hidden />

        <section className="room-queue-section" aria-label="Film sırası">
          <div className="room-queue-heading"><h2>Sıradaki Videolar</h2><span>3</span><small className="sr-only">Tasarım referansındaki örnek kapaklar. Ortak oynatma kuyruğu henüz etkin değil.</small></div>
          <div className="room-queue-strip">
            <div className="room-queue-card queue-current">
              <div className="room-queue-thumb poster-lotr"><span className="queue-play-mark"><Play size={17} fill="currentColor" /></span></div>
              <div className="room-queue-caption"><b>Yüzüklerin Efendisi</b><span>2:18:06</span></div>
            </div>
            <div className="room-queue-card"><div className="room-queue-thumb poster-interstellar"></div><div className="room-queue-caption"><b>Interstellar</b><span>2:49:04</span></div></div>
            <div className="room-queue-card"><div className="room-queue-thumb poster-inception"></div><div className="room-queue-caption"><b>Inception</b><span>2:28:07</span></div></div>
            <div className="room-queue-card"><div className="room-queue-thumb poster-batman"></div><div className="room-queue-caption"><b>The Batman</b><span>2:56:11</span></div></div>
            <div className="room-queue-card queue-card-last"><div className="room-queue-thumb poster-dune"></div><div className="room-queue-caption"><b>Dune</b><span>2:35:20</span></div></div>
            <button type="button" className="queue-next-button" aria-label="Oynatma listesi sekmesini aç" onClick={() => setActiveRoomTab('playlist')}><ChevronRight size={20} /></button>
          </div>
        </section>
        <details className="room-info-details">
          <summary>Video ve ses hakkında bilgi</summary>
          <p>Yerel video dosyaları bu bilgisayarda çalışan sunucuya parça parça yüklenir; yükleme tamamlanınca salondaki herkes aynı video bağlantısını alır. MP4, WebM, Ogg ve M4V desteklenir; tarayıcı/codec uyumluluğu gerekir. Dosyalar sunucu diskinde kalır, bu yüzden yalnızca paylaşmaya hakkın olan videoları yükle. Doğrudan MP4/HLS ve YouTube da desteklenir; dış film sayfaları senkronize oynatılmaz.</p>
        </details>
      </section>
      <aside className="room-side cinema-room-side">
        <div className="room-panel-tabs" role="tablist" aria-label="Salon paneli">
          <button type="button" role="tab" aria-selected={activeRoomTab === 'chat'} className={activeRoomTab === 'chat' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setActiveRoomTab('chat')}><MessageCircle size={15} /> Sohbet</button>
          <button type="button" role="tab" aria-selected={activeRoomTab === 'participants'} className={activeRoomTab === 'participants' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setActiveRoomTab('participants')}><Users size={15} /> Katılımcılar ({room?.participants.length ?? 0})</button>
          <button type="button" role="tab" aria-selected={activeRoomTab === 'playlist'} className={activeRoomTab === 'playlist' ? 'panel-tab panel-tab-active' : 'panel-tab'} onClick={() => setActiveRoomTab('playlist')}><ListVideo size={15} /> Oynatma Listesi</button>
        </div>
        {activeRoomTab === 'chat' && <>
          <div ref={chatListRef} onScroll={handleChatScroll} className="chat-messages cinema-chat-messages" data-testid="list-chat">
            {room?.messages.map((item) => <ChatBubble key={item.id} message={item} />)}
            {!room?.messages.length && <div className="chat-empty">Henüz sohbette ses yok.<br />İlk mesajı sen bırak.</div>}
            <div ref={chatEndRef} />
          </div>
          {unreadMessages > 0 && <button type="button" className="chat-new-messages" onClick={jumpToLatestChat}>{unreadMessages} yeni mesaj · En alta git</button>}
          <form className="chat-form cinema-chat-form" onSubmit={submitChat}>
            <input data-testid="input-chat-message" aria-label="Sohbet mesajı" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Bir şeyler yaz…" maxLength={500} />
            <button className="send-btn" data-testid="button-send-message" type="submit" aria-label="Mesaj gönder" disabled={!message.trim()}><Send size={18} /></button>
          </form>
          <div className="room-side-hint">Sesli konuşma için tarayıcı mikrofon izni ve HTTPS gerekir.</div>
        </>}
        {activeRoomTab === 'participants' && <div className="people cinema-people" data-testid="list-participants">
          {room?.participants.map((person) => <div className="person-row" key={person.id} data-testid={`participant-${person.id}`}><div className="avatar">{initials(person.nickname)}</div><span className="person-name">{person.nickname}{person.id === socketRef.current?.id ? ' (sen)' : ''}</span><span className="person-state">{person.microphoneEnabled ? 'Sesi açık' : 'Dinliyor'}</span></div>)}
          {!room?.participants.length && <div className="chat-empty">Katılımcılar yükleniyor…</div>}
          <div className="participant-side-hint"><Users size={17} /> Aynı salondaki herkes burada görünür.</div>
        </div>}
        {activeRoomTab === 'playlist' && <div className="room-playlist-panel">
          <div className="playlist-empty-icon"><ListVideo size={25} /></div>
          <h3>Oynatma Listesi</h3>
          {room?.videoUrl ? <div className="playlist-current"><span className="playlist-current-icon"><MonitorPlay size={18} /></span><div><b>Paylaşılan video</b><small>{room.videoUrl.length > 48 ? `${room.videoUrl.slice(0, 45)}…` : room.videoUrl}</small></div></div> : <p>Henüz bir video eklenmedi. YouTube bağlantısı, doğrudan video adresi veya dosya yükleyerek başlayabilirsin.</p>}
          <button type="button" className="playlist-add-button" onClick={() => { setActiveVideoSource('youtube'); document.getElementById('room-video-url')?.focus(); }}> <Link2 size={15} /> Video bağlantısı ekle</button>
          <small className="playlist-note">Ortak, sıralı video kuyruğu sunucu tarafında henüz etkin değil.</small>
        </div>}
      </aside>
    </main>
    {toast && <div className="status-toast" role="status">{toast}</div>}
  </div>;
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const date = new Date(message.createdAt);
  return <div className="chat-line" data-testid={`chat-message-${message.id}`}>
    <div className="chat-avatar">{initials(message.nickname)}</div>
    <div className="chat-body"><div className="chat-meta"><b>{message.nickname}</b><time>{Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</time></div><div className="chat-text">{message.text}</div></div>
  </div>;
}

function NotFound() {
  return <div className="app-shell"><header className="topbar"><Link href="/" className="brand"><span className="brand-mark"><Film size={19} /></span><span className="brand-name">salon</span></Link></header><main className="landing" style={{ textAlign: 'center' }}><div className="eyebrow" style={{ justifyContent: 'center' }}>Oda bulunamadı</div><h1 className="hero-title" style={{ marginInline: 'auto' }}>Bir koltuk<br />boşta kaldı.</h1><p className="hero-copy" style={{ marginInline: 'auto' }}>Davet bağlantısı yanlış olabilir ya da oda kapandı.</p><Link href="/" className="btn-primary" style={{ textDecoration: 'none' }}><ArrowLeft size={15} /> Ana sayfaya dön</Link></main></div>;
}

export default App;
