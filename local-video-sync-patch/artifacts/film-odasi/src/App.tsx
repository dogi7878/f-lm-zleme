import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetCapabilities, useHealthCheck } from '@workspace/api-client-react';
import { io, type Socket } from 'socket.io-client';
import type Hls from 'hls.js';
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import {
  ArrowDownLeft, ArrowLeft, Clipboard, ExternalLink, Film, Headphones, Link2,
  MessageCircle, Mic, MicOff, Pause, Play, Send, ShieldCheck, Sparkles, Users, Wifi,
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
  return <div className="app-shell">
    <header className="topbar">
      <Link href="/" className="brand" data-testid="link-home">
        <span className="brand-mark"><Film size={19} strokeWidth={2.2} /></span>
        <span className="brand-name">salon</span>
      </Link>
      <div className="topbar-note"><i /> Bir koltuk da sana ayırdık</div>
    </header>
    <main className="landing">
      <section className="hero-grid">
        <div className="hero-content">
          <div className="eyebrow">Birlikte izlemek başka</div>
          <h1 className="hero-title">Aynı anda.<br />Aynı <em>salonda.</em></h1>
          <p className="hero-copy">Bir bağlantı bırak, arkadaşlarını çağır. Film başlarken sesiniz, kahkahalarınız ve sohbetiniz de aynı yerde olsun.</p>
          <div className="create-card">
            <form className="create-panel" onSubmit={onCreate}>
              <label className="form-label" htmlFor="nickname">Önce sana nasıl seslenelim?</label>
              <div className="input-wrap"><Users size={17} /><input id="nickname" data-testid="input-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} placeholder="Adını yaz" autoComplete="nickname" /></div>
              <button className="btn-primary" data-testid="button-create-room" type="submit" disabled={pending !== null}>
                {pending === 'create' ? <span className="skeleton" style={{ width: 16, height: 16 }} /> : <Sparkles size={16} />}
                {pending === 'create' ? 'Salon hazırlanıyor…' : 'Yeni bir salon aç'}
              </button>
              <div className="join-panel">
                <span>Bir davet bağlantın mı var?</span>
                <div className="join-row"><input aria-label="Oda kodu" data-testid="input-room-code" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Oda kodu" /><button className="btn-text" type="button" data-testid="button-join-room" disabled={pending !== null} onClick={() => connectRoom('join', joinCode)}>Salona katıl <ArrowDownLeft size={13} /></button></div>
              </div>
            </form>
          </div>
          {error && <div role="alert" className="error-banner" data-testid="status-connect-error">{error}<button onClick={() => setError('')}>Kapat</button></div>}
          {!healthLoading && healthError && <div role="alert" className="error-banner" data-testid="status-health-error">Sunucu durumu alınamadı.<button onClick={() => void retryHealth()}>Yenile</button></div>}
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="room-illustration">
            <div className="room-window" /><div className="screen" /><div className="sofa" /><div className="plant" />
            <div className="orbit-note note-a">Dizi mi, film mi?</div><div className="orbit-note note-b">Herkes burada.</div>
          </div>
        </div>
      </section>
      <section className="features-row" aria-label="Salon özellikleri">
        <Feature icon={<Wifi size={16} />} title="Aynı ritimde" text="Oynatma herkesle eşzamanlı" />
        <Feature icon={<Headphones size={16} />} title="Sesin de burada" text="Tarayıcıdan canlı konuş" />
        <Feature icon={<MessageCircle size={16} />} title="Sohbet açık" text="Tepkiler anında salonda" />
        <Feature icon={<ShieldCheck size={16} />} title="Sadece davetliler" text={capabilities ? `Oda sınırı ${capabilities.maxParticipants} kişi` : capsLoading ? 'Oda bilgisi alınıyor' : 'Özel davet bağlantısı'} />
      </section>
      <div className="capability-foot" data-testid="text-capabilities">
        {capsLoading && <span>Salon özellikleri yükleniyor…</span>}
        {capsError && <span>Salon sınırları şu an yüklenemedi. <button className="btn-text" onClick={() => void retryCaps()}>Yeniden dene</button></span>}
        {capabilities && <span>Desteklenen bağlantılar: {sourceList || 'Sunucu bilgisi bekleniyor'}. Boş odalar 30 dakika sonra kapanır; sunucu yeniden başladığında bellekteki odalar silinir. {capabilities.voiceLimitations}. Ekran paylaşımı bu uygulamada yok; desteklenen video bağlantısını paylaş.</span>}
        {!capsLoading && !capsError && !capabilities && <span>Bağlantıdaki videoyu herkes kendi cihazında oynatır; yalnızca desteklenen herkese açık kaynaklar çalışır.</span>}
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
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [micEnabled, setMicEnabled] = useState(false);
  const [audioNeedsTap, setAudioNeedsTap] = useState(false);
  const [joining, setJoining] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const skipInitialRejoinRef = useRef(Boolean(activeRoom === roomId && activeNickname && liveSocket?.connected));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const youtubeRef = useRef<YouTubePlayer | null>(null);
  const youtubeReadyRef = useRef(false);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const remoteAudioRef = useRef(new Map<string, HTMLAudioElement>());
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const isMember = Boolean(activeNickname && activeRoom === roomId);
  const capabilitiesQuery = useGetCapabilities();
  const cap = capabilitiesQuery.data;

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

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [room?.messages.length]);
  const isYoutube = useMemo(() => {
    if (!room?.videoUrl) return null;
    try {
      const url = new URL(room.videoUrl);
      if (url.hostname === 'youtu.be') return url.pathname.slice(1);
      if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) return url.searchParams.get('v') || url.pathname.match(/\/embed\/([^/]+)/)?.[1] || null;
      return null;
    } catch { return null; }
  }, [room?.videoUrl]);
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

  useEffect(() => {
    if (!isYoutube || !room?.videoUrl) return;
    let cancelled = false;
    const mountPlayer = () => {
      if (cancelled || !window.YT?.Player) return;
      youtubeRef.current?.destroy();
      youtubeReadyRef.current = false;
      youtubeRef.current = new window.YT.Player(`youtube-player-${roomId}`, {
        videoId: isYoutube,
        playerVars: { controls: 0, modestbranding: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: ({ target }) => {
            youtubeRef.current = target; youtubeReadyRef.current = true;
            const latest = roomRef.current;
            const targetTime = (latest?.playback.currentTime ?? 0) + (latest?.playback.isPlaying ? Math.max(0, (Date.now() - latest.playback.updatedAt) / 1000) : 0);
            target.seekTo(targetTime, true);
            if (latest?.playback.isPlaying) target.playVideo(); else target.pauseVideo();
          },
          onStateChange: ({ data, target }) => {
            if (data === 1 || data === 2 || data === 0) {
              socketRef.current?.emit('room:set-playback', { isPlaying: data === 1, currentTime: target.getCurrentTime() });
            }
          },
          onError: () => setError('Bu YouTube videosu dışarıdan oynatıma izin vermiyor veya kullanılamıyor. Başka bir desteklenen bağlantı dene.'),
        },
      });
    };
    if (window.YT?.Player) mountPlayer();
    else {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { previous?.(); mountPlayer(); };
      if (!document.querySelector('script[data-youtube-iframe-api]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.dataset.youtubeIframeApi = 'true';
        document.head.appendChild(script);
      }
    }
    return () => {
      cancelled = true;
      youtubeRef.current?.destroy();
      youtubeRef.current = null;
      youtubeReadyRef.current = false;
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
    const youtubeHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'];
    const videoId = parsed.hostname === 'youtu.be'
      ? parsed.pathname.slice(1)
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(parsed.hostname)
        ? parsed.searchParams.get('v') || parsed.pathname.match(/^\/embed\/([\w-]{11})$/)?.[1] || ''
        : '';
    const validYoutube = youtubeHosts.includes(parsed.hostname) && /^[\w-]{11}$/.test(videoId);
    const supportedDirect = /\.(mp4|webm|ogg|m4v)$/i.test(parsed.pathname);
    const supportedHls = /\.m3u8$/i.test(parsed.pathname);
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
    if (!navigator.mediaDevices?.getUserMedia) { setError('Mikrofon için güvenli bağlantı (HTTPS) ve desteklenen bir tarayıcı gerekli.'); return; }
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
    } catch {
      setError('Mikrofona erişim verilmedi. Tarayıcı izinlerini ve HTTPS bağlantısını kontrol et.');
    } finally { setJoining(false); }
  };
  const togglePlayback = () => {
    if (!room) return;
    if (youtubeRef.current && youtubeReadyRef.current) {
      if (room.playback.isPlaying) youtubeRef.current.pauseVideo(); else youtubeRef.current.playVideo();
      socketRef.current?.emit('room:set-playback', { isPlaying: !room.playback.isPlaying, currentTime: youtubeRef.current.getCurrentTime() });
      return;
    }
    const element = videoRef.current;
    if (element) {
      if (element.paused) void element.play().catch(() => undefined); else element.pause();
      socketRef.current?.emit('room:set-playback', { isPlaying: element.paused === false, currentTime: element.currentTime });
    } else socketRef.current?.emit('room:set-playback', { isPlaying: !room.playback.isPlaying, currentTime: room.playback.currentTime });
  };
  const handleVideoPlay = () => { if (videoRef.current) socketRef.current?.emit('room:set-playback', { isPlaying: true, currentTime: videoRef.current.currentTime }); };
  const handleVideoPause = () => { if (videoRef.current) socketRef.current?.emit('room:set-playback', { isPlaying: false, currentTime: videoRef.current.currentTime }); };
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
      void video.play().catch(() => setError('Tarayıcı otomatik oynatmayı engelledi. Videoyu başlatmak için oynat düğmesine dokun.'));
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
      void video.play().catch(() => setError('Tarayıcı otomatik oynatmayı engelledi. Videoyu başlatmak için oynat düğmesine dokun.'));
    }
    if (!room.playback.isPlaying && !video.paused) video.pause();
  }, [room?.playback.currentTime, room?.playback.isPlaying, room?.playback.updatedAt, room?.videoUrl, isYoutube]);

  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setToast('Davet bağlantısı kopyalandı'); window.setTimeout(() => setToast(''), 2400); }
    catch { setToast('Bağlantıyı adres çubuğundan kopyalayabilirsin'); window.setTimeout(() => setToast(''), 3000); }
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

  return <div className="app-shell">
    <header className="topbar">
      <Link href="/" className="brand" data-testid="link-home"><span className="brand-mark"><Film size={19} /></span><span className="brand-name">salon</span></Link>
      <div className="topbar-note"><i /> {socketReady ? 'Arkadaşlarınla aynı salondasın' : 'Salona bağlanıyor'}</div>
    </header>
    <main className="room-layout">
      <section className="watch-main">
        <div className="room-header">
          <div><h1 className="room-title">Bu akşamın salonu</h1><div className="room-kicker">Oda {roomId} <span style={{ margin: '0 6px' }}>·</span> <span className="live-indicator" /> {socketReady ? 'Canlı' : 'Bağlantı kuruluyor'}</div></div>
          <div className="room-actions">
            <button className="pill-action" data-testid="button-copy-invite" onClick={() => void copyInvite()}><Clipboard size={14} /> Davet et</button>
            {(audioNeedsTap || (room?.participants.length ?? 0) > 1) && <button className="pill-action" data-testid="button-enable-remote-audio" onClick={() => void enableRemoteAudio()}><Headphones size={14} /> Karşı tarafın sesini aç</button>}
            <button className="pill-action" data-testid="button-toggle-mic" onClick={() => void toggleMic()} disabled={joining} title={micEnabled ? 'Mikrofonu kapat' : 'Mikrofonu aç'}>{micEnabled ? <Mic size={14} /> : <MicOff size={14} />}{joining ? 'İzin bekleniyor' : micEnabled ? 'Mikrofon açık' : 'Mikrofon kapalı'}</button>
          </div>
        </div>
        {error && <div role="alert" className="error-banner" data-testid="status-room-error">{error}<button onClick={() => setError('')}>Kapat</button></div>}
        <div className="video-stage" data-testid="video-stage">
          {room?.videoUrl && isYoutube
            ? <div id={`youtube-player-${roomId}`} aria-label="Eşzamanlı YouTube videosu" style={{ width: '100%', height: '100%' }} />
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
                : <div className="video-empty"><div className="film-icon"><Film size={25} /></div><h2>Film gecesi için yer açıldı</h2><p>Herkese açık desteklenen bir video bağlantısı ekle. Oynatma odadaki herkesle eşzamanlanır.</p></div>}
          {(!room?.videoUrl || isYoutube) && <div className="stage-overlay"><span className="sync-badge"><Wifi size={12} /> {room?.playback.isPlaying ? 'Şimdi oynatılıyor' : 'Eşzamanlı salon'}</span><button className="play-big" aria-label={room?.playback.isPlaying ? 'Duraklat' : 'Oynat'} onClick={togglePlayback}>{room?.playback.isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button><span className="sync-badge">{formatTime(room?.playback.currentTime || 0)}</span></div>}
        </div>
        <form className="video-urlbar" onSubmit={setVideo}>
          <Link2 size={15} /><input data-testid="input-video-url" aria-label="Video bağlantısı" value={videoInput} onChange={(e) => setVideoInput(e.target.value)} placeholder="YouTube, doğrudan MP4/HLS veya sayfa bağlantısı…" />
          <button className="url-submit" data-testid="button-set-video" type="submit">Bağlantıyı ekle</button>
        </form>
        <div className="local-video-row">
          <input ref={fileInputRef} type="file" accept=".mp4,.webm,.ogg,.m4v,video/mp4,video/webm,video/ogg" onChange={(event) => void uploadLocalVideo(event)} hidden />
          <button className="local-video-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadProgress !== null && uploadProgress < 100}><Film size={15} /> {uploadProgress !== null && uploadProgress < 100 ? `Video yükleniyor… %${uploadProgress}` : 'Cihazımdan video seç'}</button>
          <span>Seçilen video sunucuya yüklenir ve odadakilerle paylaşılır.</span>
        </div>
        <div className="room-footnote">Yerel video dosyaları bu bilgisayarda çalışan sunucuya parça parça yüklenir; yükleme tamamlanınca salondaki herkes aynı video bağlantısını alır. MP4, WebM, Ogg ve M4V desteklenir; tarayıcı/codec uyumluluğu gerekir. Dosyalar sunucu diskinde kalır, bu yüzden yalnızca paylaşmaya hakkın olan videoları yükle. Doğrudan MP4/HLS ve YouTube da desteklenir; dış film sayfaları senkronize oynatılmaz.</div>
      </section>
      <aside className="room-side">
        <div className="side-head"><span className="side-title">Salondakiler</span><span className="count-tag" data-testid="text-participant-count">{room?.participants.length ?? 0}{cap ? ` / ${cap.maxParticipants}` : ''}</span></div>
        <div className="people" data-testid="list-participants">
          {room?.participants.map((person) => <div className="person-row" key={person.id} data-testid={`participant-${person.id}`}><div className="avatar">{initials(person.nickname)}</div><span className="person-name">{person.nickname}{person.id === socketRef.current?.id ? ' (sen)' : ''}</span><span className="person-state">{person.microphoneEnabled ? 'Sesi açık' : 'Dinliyor'}</span></div>)}
          {!room && <div className="person-row"><div className="skeleton" style={{ width: 31, height: 31 }} /><div className="skeleton" style={{ width: '58%', height: 12 }} /></div>}
        </div>
        <div className="chat-head"><span className="side-title">Salon sohbeti</span><MessageCircle size={15} color="#809085" /></div>
        <div className="chat-messages" data-testid="list-chat">
          {room?.messages.map((item) => <ChatBubble key={item.id} message={item} />)}
          {!room?.messages.length && <div className="chat-empty">Henüz sohbette ses yok.<br />İlk mesajı sen bırak.</div>}
          <div ref={chatEndRef} />
        </div>
        <form className="chat-form" onSubmit={submitChat}>
          <input data-testid="input-chat-message" aria-label="Sohbet mesajı" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Bir şeyler yaz…" maxLength={500} />
          <button className="send-btn" data-testid="button-send-message" type="submit" aria-label="Mesaj gönder" disabled={!message.trim()}><Send size={15} /></button>
        </form>
        <div className="room-footnote">Sesli konuşma tarayıcı mikrofon izni ve HTTPS gerektirir. Bazı ağlarda bağlantı kurulamayabilir; TURN aktarım sunucusu sağlanmıyor.</div>
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
