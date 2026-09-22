/**
 * Flymax WhatsApp Gateway (Baileys)
 * ---------------------------------
 * Pequeno serviço Node que mantém a sessão do WhatsApp aberta (QR Code) e
 * conversa com o CRM por HTTP. Deve rodar fora do app (Railway, Render, Fly,
 * VPS) porque o Baileys precisa de um processo Node persistente.
 *
 * Variáveis de ambiente:
 *   GATEWAY_TOKEN  - senha compartilhada entre gateway e CRM (obrigatória)
 *   WEBHOOK_URL    - https://SEU-APP/api/public/whatsapp  (obrigatória)
 *   PORT           - porta HTTP (default 8787)
 *   SESSION_DIR    - pasta da sessão (default ./session)
 */
import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from "baileys";

const TOKEN = process.env.GATEWAY_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 8787;
const SESSION_DIR = process.env.SESSION_DIR || "./session";
if (!TOKEN) throw new Error("GATEWAY_TOKEN é obrigatório");

console.log("[boot] Flymax WhatsApp Gateway iniciando... PORT=%s SESSION_DIR=%s", process.env.PORT || 8787, process.env.SESSION_DIR || "./session");

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
let sock = null;
let state = { status: "desconectado", qr: null, phone: null };

async function loadAuthState() {
  try {
    return await useMultiFileAuthState(SESSION_DIR);
  } catch (e) {
    console.log("[boot] SESSION_DIR %s indisponível (%s) — usando ./session", SESSION_DIR, e?.message);
    return await useMultiFileAuthState("./session");
  }
}

async function start() {
  // Versão do protocolo: env override > versão mais recente do WA Web > padrão da lib
  let version;
  try {
    if (process.env.WA_BAILEYS_VERSION) {
      version = process.env.WA_BAILEYS_VERSION.split(",").map(Number);
    } else {
      version = (await fetchLatestBaileysVersion()).version;
    }
  } catch (e) {
    console.log("[conn] fetchLatestBaileysVersion falhou, usando versão padrão:", e?.message);
  }
  console.log("[conn] versão do protocolo:", version ?? "padrão da lib");

  const { state: auth, saveCreds } = await loadAuthState();
  sock = makeWASocket({ auth, logger, browser: ["Flymax CRM", "Chrome", "1.0"], version });
  state.status = "conectando";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    console.log("[conn]", JSON.stringify({ connection: u.connection, qr: !!u.qr, code: u.lastDisconnect?.error?.output?.statusCode, msg: u.lastDisconnect?.error?.message }));
    if (u.qr) state.qr = await qrcode.toDataURL(u.qr);
    if (u.connection === "open") {
      state = { status: "conectado", qr: null, phone: sock.user?.id?.split(":")[0] ?? null };
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      state = { status: "desconectado", qr: null, phone: null };
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (m.key.fromMe || m.key.remoteJid?.endsWith("@g.us")) continue;
      const payload = await toInbound(m);
      if (payload) await post(payload);
    }
  });
}

async function toInbound(m) {
  const msg = m.message;
  if (!msg) return null;
  const from = (m.key.remoteJid || "").split("@")[0];
  const base = {
    from,
    name: m.pushName || undefined,
    externalId: m.key.id,
    timestamp: new Date((Number(m.messageTimestamp) || Date.now() / 1000) * 1000).toISOString(),
  };
  if (msg.conversation || msg.extendedTextMessage?.text)
    return { ...base, type: "text", body: msg.conversation || msg.extendedTextMessage.text };
  if (msg.audioMessage)
    return { ...base, type: "audio", durationSec: msg.audioMessage.seconds || 0, mediaUrl: await dataUrl(m, "audio/ogg") };
  if (msg.imageMessage)
    return { ...base, type: "image", body: msg.imageMessage.caption || null, mediaUrl: await dataUrl(m, "image/jpeg") };
  if (msg.documentMessage) return { ...base, type: "document", body: msg.documentMessage.fileName || "documento" };
  if (msg.locationMessage)
    return {
      ...base,
      type: "location",
      body: `${msg.locationMessage.degreesLatitude}, ${msg.locationMessage.degreesLongitude}`,
    };
  return { ...base, type: "text", body: "[mensagem não suportada]" };
}

async function dataUrl(m, mime) {
  try {
    const buf = await downloadMediaMessage(m, "buffer", {});
    if (buf.length > 3_000_000) return null; // muito grande para inline
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function post(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": TOKEN },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("webhook falhou", e.message);
  }
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.get("x-gateway-token") !== TOKEN) return res.status(401).json({ error: "token inválido" });
  next();
});

app.get("/health", (_r, res) => res.json({ ok: true }));
app.get("/status", (_r, res) => res.json(state));

app.post("/connect", async (_r, res) => {
  if (!sock || state.status === "desconectado") await start();
  res.json(state);
});

app.post("/disconnect", async (_r, res) => {
  try {
    await sock?.logout();
  } catch {}
  sock = null;
  state = { status: "desconectado", qr: null, phone: null };
  res.json(state);
});

app.post("/send", async (req, res) => {
  if (state.status !== "conectado") return res.status(409).json({ error: "WhatsApp desconectado" });
  const { to, text } = req.body || {};
  const jid = `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text });
  res.json({ externalId: sent?.key?.id ?? null });
});

app.listen(PORT, () => console.log(`Flymax WhatsApp Gateway on :${PORT}`));
start().catch((e) => console.error(e));
