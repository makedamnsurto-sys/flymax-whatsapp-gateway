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
import http from "http";
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
// Não derruba o processo se faltar variável: o servidor sobe mesmo assim
// e responde com erro claro nas rotas protegidas.
const CONFIG_OK = Boolean(TOKEN);

console.log("[boot] Flymax WhatsApp Gateway iniciando... PORT=%s SESSION_DIR=%s config_ok=%s", process.env.PORT || 8787, process.env.SESSION_DIR || "./session", CONFIG_OK);

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
    for (const m of messages) {
      // Mensagens enviadas no próprio celular costumam chegar como "append",
      // enquanto novas mensagens recebidas chegam como "notify".
      if (type !== "notify" && !(type === "append" && m.key.fromMe)) continue;
      const jid = messageJid(m.key);
      if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;
      const payload = await toInbound(m);
      // Mensagens enviadas pelo próprio número (celular ou conversa consigo mesmo)
      // também são espelhadas no CRM, marcadas como saída.
      if (payload) await post({ ...payload, fromMe: Boolean(m.key.fromMe) });
    }
  });

  // Algumas versões do WhatsApp entregam reações fora de messages.upsert.
  // A chave do evento é a da mensagem reagida — inclusive quando ela é nossa (fromMe).
  sock.ev.on("messages.reaction", async (reactions) => {
    for (const item of reactions || []) {
      const reaction = item?.reaction;
      const eventKey = item?.key;
      const jid = messageJid(eventKey) || messageJid(reaction?.key);
      if (!jid || jid.endsWith("@g.us")) continue;
      await post({
        from: jid.split("@")[0],
        jid,
        type: "reaction",
        body: reaction?.text || "",
        reactionTo: reaction?.key?.id || eventKey?.id || null,
        externalId: eventKey?.id || null,
        timestamp: new Date().toISOString(),
      });
    }
  });
}

async function toInbound(m) {
  let msg = m.message;
  if (!msg) return null;
  // Mensagens efêmeras, editadas e de visualização única trazem o conteúdo aninhado.
  for (let depth = 0; depth < 5; depth += 1) {
    const nested =
      msg.ephemeralMessage?.message ||
      msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message ||
      msg.viewOnceMessageV2Extension?.message ||
      msg.editedMessage?.message;
    if (!nested) break;
    msg = nested;
  }
  const jid = messageJid(m.key);
  const from = jid.split("@")[0];
  const base = {
    from,
    jid,
    name: m.pushName || undefined,
    externalId: m.key.id,
    timestamp: new Date((Number(m.messageTimestamp) || Date.now() / 1000) * 1000).toISOString(),
  };
  if (msg.conversation || msg.extendedTextMessage?.text)
    return { ...base, type: "text", body: msg.conversation || msg.extendedTextMessage.text };
  if (msg.audioMessage) {
    const mime = msg.audioMessage.mimetype || "audio/ogg";
    return {
      ...base,
      type: "audio",
      durationSec: msg.audioMessage.seconds || 0,
      ...(await media(m, mime)),
    };
  }
  if (msg.imageMessage) {
    const mime = msg.imageMessage.mimetype || "image/jpeg";
    return { ...base, type: "image", body: msg.imageMessage.caption || null, ...(await media(m, mime)) };
  }
  if (msg.videoMessage) {
    const mime = msg.videoMessage.mimetype || "video/mp4";
    const gif = Boolean(msg.videoMessage.gifPlayback);
    return {
      ...base,
      type: "video",
      body: msg.videoMessage.caption || (gif ? "GIF" : null),
      durationSec: msg.videoMessage.seconds || 0,
      ...(await media(m, mime)),
    };
  }
  if (msg.stickerMessage) {
    const mime = msg.stickerMessage.mimetype || "image/webp";
    return { ...base, type: "image", body: "Figurinha", ...(await media(m, mime)) };
  }
  if (msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage) {
    const doc = msg.documentMessage || msg.documentWithCaptionMessage.message.documentMessage;
    const mime = doc.mimetype || "application/octet-stream";
    return {
      ...base,
      type: "document",
      body: doc.caption || null,
      fileName: doc.fileName || "documento",
      ...(await media(m, mime)),
    };
  }
  if (msg.contactMessage || msg.contactsArrayMessage)
    return {
      ...base,
      type: "contact",
      body: msg.contactMessage?.displayName || "Contato compartilhado",
    };
  if (msg.locationMessage)
    return {
      ...base,
      type: "location",
      body: `${msg.locationMessage.degreesLatitude}, ${msg.locationMessage.degreesLongitude}`,
    };
  if (msg.reactionMessage)
    return {
      ...base,
      type: "reaction",
      body: msg.reactionMessage.text || "",
      reactionTo: msg.reactionMessage.key?.id || null,
    };
  // Eventos internos do protocolo não devem aparecer como mensagens para o atendente.
  logger.debug({ keys: Object.keys(msg) }, "evento de mensagem ignorado");
  return null;
}

/** Prefere o número telefônico alternativo quando o WhatsApp usa um JID @lid. */
function messageJid(key = {}) {
  const candidates = [key.remoteJidAlt, key.remoteJid, key.participantAlt, key.participant].filter(Boolean);
  return candidates.find((value) => String(value).endsWith("@s.whatsapp.net")) || candidates[0] || "";
}

/** Baixa a mídia e devolve data URL, tamanho e mime. Acima de 8 MB guarda só os metadados. */
async function media(m, mime) {
  try {
    const buf = await downloadMediaMessage(m, "buffer", {});
    const size = buf.length;
    if (size > 8_000_000) return { mediaUrl: null, mediaSize: size, mediaMime: mime };
    return { mediaUrl: `data:${mime};base64,${buf.toString("base64")}`, mediaSize: size, mediaMime: mime };
  } catch {
    return { mediaUrl: null, mediaSize: null, mediaMime: mime };
  }
}

async function post(payload) {
  if (!WEBHOOK_URL) return;
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": TOKEN },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error("webhook recusou evento [%s]: %s", response.status, body.slice(0, 500));
    }
  } catch (e) {
    console.error("webhook falhou", e.message);
  }
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!CONFIG_OK) return res.status(503).json({ error: "GATEWAY_TOKEN não configurada" });
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
  const jid = String(to).includes("@") ? String(to) : `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text });
  res.json({ externalId: sent?.key?.id ?? null });
});

// Reagir a uma mensagem com emoji, igual ao WhatsApp (emoji vazio remove a reação).
app.post("/send-reaction", async (req, res) => {
  if (state.status !== "conectado") return res.status(409).json({ error: "WhatsApp desconectado" });
  const { to, messageId, emoji, fromMe } = req.body || {};
  if (!to || !messageId) return res.status(400).json({ error: "to e messageId são obrigatórios" });
  const digits = String(to).replace(/\D/g, "");
  const jid = String(to).includes("@") ? String(to) : `${digits}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, {
    react: { text: emoji || "", key: { remoteJid: jid, id: String(messageId), fromMe: Boolean(fromMe) } },
  });
  res.json({ externalId: sent?.key?.id ?? null });
});

app.post("/send-document", async (req, res) => {
  if (state.status !== "conectado") return res.status(409).json({ error: "WhatsApp desconectado" });
  const { to, filename, base64, caption, mimetype } = req.body || {};
  if (!to || !filename || !base64) return res.status(400).json({ error: "to, filename e base64 são obrigatórios" });
  const digits = String(to).replace(/\D/g, "");
  const jid = String(to).includes("@") ? String(to) : `${digits}@s.whatsapp.net`;
  const buf = Buffer.from(base64, "base64");
  const mime = mimetype || "application/pdf";
  const isAudio = mime.startsWith("audio/");
  const sent = await sock.sendMessage(
    jid,
    mime.startsWith("image/")
      ? { image: buf, mimetype: mime, caption: caption || undefined }
      : mime.startsWith("video/")
        ? { video: buf, mimetype: mime, caption: caption || undefined }
        : isAudio
          // ptt:true força mensagem de voz nativa, nunca documento/anexo.
          ? { audio: buf, mimetype: mime, ptt: true, fileName: undefined }
          : { document: buf, mimetype: mime, fileName: filename, caption: caption || undefined },
  );
  res.json({ externalId: sent?.key?.id ?? null });
});

// Escuta em TODAS as portas possíveis (PORT do Railway + 8787) para eliminar
// qualquer desalinhamento entre a porta do aplicativo e a porta do domínio.
function listenOn(port, label) {
  const server = http.createServer(app);
  server.on("error", (e) => console.log(`[http] ${label}:${port} indisponível —`, e.message));
  server.listen(port, "0.0.0.0", () => console.log(`Flymax WhatsApp Gateway on :${port} (${label})`));
}
listenOn(Number(process.env.PORT) || 8787, "PORT");
if (Number(process.env.PORT) !== 8787) listenOn(8787, "fixa");

// Nada pode derrubar o servidor HTTP: erros do WhatsApp ficam apenas no log.
process.on("uncaughtException", (e) => console.error("[erro não tratado]", e?.message));
process.on("unhandledRejection", (e) => console.error("[promise rejeitada]", e?.message ?? e));

start().catch((e) => console.error("[start] falhou:", e?.message));
