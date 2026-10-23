import { Router, type IRouter } from "express";
import { GetCapabilitiesResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/capabilities", (_req, res) => {
  res.json(
    GetCapabilitiesResponse.parse({
      maxParticipants: 6,
      supportedVideoSources: [
        "HTTPS doğrudan MP4, WebM, Ogg ve erişilebilir HLS (.m3u8) video bağlantıları",
        "Herkese açık YouTube video bağlantıları",
        "HTTPS film sayfaları odadakilerle paylaşılır; harici oynatma senkronize edilmez",
      ],
      screenSharing: {
        mobileSupported: false,
        desktopSupported: false,
        alternative: "Desteklenen bir video bağlantısını odaya ekleyin.",
      },
      roomPersistence:
        "Odalar bellekte tutulur. Son kişi bağlantıyı kestiğinde boş oda 30 dakika sonra silinir; sunucu yeniden başladığında bellekteki odalar kaybolur.",
      voiceLimitations:
        "Ses doğrudan tarayıcılar arasında WebRTC ile aktarılır. Ücretsiz STUN kullanılır; TURN aktarımı olmadığı için bazı ağlarda bağlantı kurulamayabilir.",
    }),
  );
});

export default router;
