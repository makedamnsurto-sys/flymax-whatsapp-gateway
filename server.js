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
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
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
let starting = false;
let activeSessionDir = SESSION_DIR;

async function loadAuthState() {
  try {
    const auth = await useMultiFileAuthState(SESSION_DIR);
    activeSessionDir = SESSION_DIR;
    return auth;
  } catch (e) {
    console.log("[boot] SESSION_DIR %s indisponível (%s) — usando ./session", SESSION_DIR, e?.message);
    activeSessionDir = "./session";
    return await useMultiFileAuthState("./session");
  }
}

/** Apaga a sessão salva para que o próximo connect gere um QR Code novo. */
function clearSession() {
  for (const dir of new Set([activeSessionDir, SESSION_DIR, "./session"])) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.log("[sessao] não foi possível apagar %s: %s", dir, e?.message);
    }
  }
}

async function start() {
  if (starting) return;
  starting = true;
  try {
    await boot();
  } finally {
    starting = false;
  }
}

async function boot() {
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
  const mySock = makeWASocket({ auth, logger, browser: ["Flymax CRM", "Chrome", "1.0"], version });
  sock = mySock;
  if (state.status !== "conectado") state.status = "conectando";

  mySock.ev.on("creds.update", saveCreds);

  mySock.ev.on("connection.update", async (u) => {
    // Eventos de sockets antigos não podem sobrescrever a conexão ativa.
    if (sock !== mySock) return;
    console.log("[conn]", JSON.stringify({ connection: u.connection, qr: !!u.qr, code: u.lastDisconnect?.error?.output?.statusCode, msg: u.lastDisconnect?.error?.message }));
    if (u.qr && state.status !== "conectado") {
      state.qr = await qrcode.toDataURL(u.qr);
      state.status = "conectando";
    }
    if (u.connection === "open") {
      state = { status: "conectado", qr: null, phone: mySock.user?.id?.split(":")[0] ?? null };
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      state = { status: "desconectado", qr: null, phone: null };
      if (code === DisconnectReason.loggedOut || code === 401 || code === 403) {
        // Sessão inválida: sem apagar os arquivos o Baileys nunca gera um QR novo.
        console.log("[conn] sessão inválida (%s) — apagando credenciais e gerando novo QR", code);
        clearSession();
        setTimeout(start, 1500);
      } else {
        setTimeout(start, 3000);
      }
    }
  });

  mySock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      // Mensagens enviadas no próprio celular costumam chegar como "append",
      // enquanto novas mensagens recebidas chegam como "notify".
      if (type !== "notify" && !(type === "append" && m.key.fromMe)) continue;
      // Grupos vão só para o "Inbox dos grupos" da Comunidade, nunca para o Inbox de clientes.
      if (String(m.key?.remoteJid || "").endsWith("@g.us")) {
        await postGroup(m);
        continue;
      }
      // Status/stories, listas de transmissão, canais e grupos nunca entram no CRM.
      if (isNotConversation(m.key) || m.broadcast) continue;
      const jid = messageJid(m.key);
      if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;
      const payload = await toInbound(m);
      // Mensagens enviadas pelo próprio número (celular ou conversa consigo mesmo)
      // também são espelhadas no CRM, marcadas como saída. chatJid deixa o CRM
      // recusar status/stories mesmo que o gateway esteja desatualizado.
      if (payload)
        await post({ ...payload, chatJid: String(m.key.remoteJid || ""), fromMe: Boolean(m.key.fromMe) });
    }
  });

  // Algumas versões do WhatsApp entregam reações fora de messages.upsert.
  // A chave do evento é a da mensagem reagida — inclusive quando ela é nossa (fromMe).
  mySock.ev.on("messages.reaction", async (reactions) => {
    for (const item of reactions || []) {
      const reaction = item?.reaction;
      const eventKey = item?.key;
      if (isNotConversation(eventKey) || isNotConversation(reaction?.key)) continue;
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
/** Status/stories, canais, listas de transmissão e grupos não são atendimentos. */
function isNotConversation(key = {}) {
  const chats = [key?.remoteJid, key?.remoteJidAlt].map((v) => String(v || ""));
  const notChat = chats.some(
    (chat) =>
      chat === "status@broadcast" ||
      chat.endsWith("@broadcast") ||
      chat.endsWith("@newsletter") ||
      chat.endsWith("@g.us"),
  );
  // Só @lid sem telefone alternativo: o mesmo cliente chega pelo número real.
  const lidOnly =
    String(key?.remoteJid || "").endsWith("@lid") &&
    !String(key?.remoteJidAlt || "").endsWith("@s.whatsapp.net");
  return notChat || lidOnly;
}

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

const groupNames = new Map();
async function groupName(jid) {
  if (groupNames.has(jid)) return groupNames.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    groupNames.set(jid, meta?.subject || jid);
  } catch {
    groupNames.set(jid, jid);
  }
  return groupNames.get(jid);
}

/** Envia ao CRM um resumo leve da mensagem do grupo (texto/legenda, sem baixar mídia). */
async function postGroup(m) {
  let msg = m.message;
  if (!msg) return;
  for (let d = 0; d < 5; d += 1) {
    const nested = msg.ephemeralMessage?.message || msg.viewOnceMessage?.message || msg.viewOnceMessageV2?.message || msg.editedMessage?.message;
    if (!nested) break;
    msg = nested;
  }
  if (msg.protocolMessage || msg.reactionMessage || msg.senderKeyDistributionMessage && Object.keys(msg).length === 1) return;
  const type = msg.imageMessage ? "image" : msg.videoMessage ? "video" : msg.audioMessage ? "audio" : msg.documentMessage ? "document" : msg.stickerMessage ? "sticker" : "text";
  const body = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || msg.documentMessage?.fileName || "";
  if (type === "text" && !body) return;
  const groupJid = String(m.key.remoteJid);
  const participant = String(m.key.participantAlt || m.key.participant || "");
  await post({
    kind: "group",
    groupJid,
    groupName: await groupName(groupJid),
    from: participant.split("@")[0],
    name: m.pushName || null,
    fromMe: Boolean(m.key.fromMe),
    type,
    body,
    externalId: m.key.id,
    timestamp: new Date((Number(m.messageTimestamp) || Date.now() / 1000) * 1000).toISOString(),
  });
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
app.use(express.json({ limit: "40mb" }));
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!CONFIG_OK) return res.status(503).json({ error: "GATEWAY_TOKEN não configurada" });
  if (req.get("x-gateway-token") !== TOKEN) return res.status(401).json({ error: "token inválido" });
  next();
});

app.get("/health", (_r, res) => res.json({ ok: true }));
app.get("/status", (_r, res) => res.json(state));

app.post("/connect", async (req, res) => {
  // reset=1 força apagar a sessão antiga e pedir um QR Code novo.
  if (req.query.reset === "1" || req.body?.reset === true) {
    try {
      await sock?.logout();
    } catch {}
    sock = null;
    clearSession();
    state = { status: "desconectado", qr: null, phone: null };
  }
  if (!sock?.user) start();
  // Espera até 20s o QR Code aparecer, para o CRM já receber a imagem pronta.
  for (let i = 0; i < 40 && !state.qr && state.status !== "conectado"; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
  }
  res.json(state);
});

app.post("/disconnect", async (_r, res) => {
  try {
    await sock?.logout();
  } catch {}
  sock = null;
  clearSession();
  state = { status: "desconectado", qr: null, phone: null };
  res.json(state);
});

// Lista os grupos (inclusive os da Comunidade Flymax) para o CRM disparar promoções.
// Só leitura: mensagens de grupo continuam fora do Inbox.
app.get("/groups", async (_r, res) => {
  if (!sock?.user) return res.status(409).json({ error: "WhatsApp desconectado" });
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all || {}).map((g) => ({
      jid: g.id,
      name: g.subject || g.id,
      size: g.size ?? g.participants?.length ?? 0,
      announce: Boolean(g.announce),
      isCommunity: Boolean(g.isCommunity),
      linkedParent: g.linkedParent || null,
    }));
    groups.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    res.json({ groups });
  } catch (e) {
    console.error("[groups] falhou:", e?.message);
    res.status(500).json({ error: e?.message || "falha ao listar grupos" });
  }
});

app.post("/send", async (req, res) => {
  if (!sock?.user) return res.status(409).json({ error: "WhatsApp desconectado" });
  try {
    const { to, text } = req.body || {};
    const jid = String(to).includes("@") ? String(to) : `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, { text });
    res.json({ externalId: sent?.key?.id ?? null });
  } catch (e) {
    console.error("[send] falhou:", e?.message);
    res.status(500).json({ error: e?.message || "falha ao enviar" });
  }
});

// Reagir a uma mensagem com emoji, igual ao WhatsApp (emoji vazio remove a reação).
app.post("/send-reaction", async (req, res) => {
  if (!sock?.user) return res.status(409).json({ error: "WhatsApp desconectado" });
  const { to, messageId, emoji, fromMe } = req.body || {};
  if (!to || !messageId) return res.status(400).json({ error: "to e messageId são obrigatórios" });
  try {
    const digits = String(to).replace(/\D/g, "");
    const jid = String(to).includes("@") ? String(to) : `${digits}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, {
      react: { text: emoji || "", key: { remoteJid: jid, id: String(messageId), fromMe: Boolean(fromMe) } },
    });
    res.json({ externalId: sent?.key?.id ?? null });
  } catch (e) {
    console.error("[send-reaction] falhou:", e?.message);
    res.status(500).json({ error: e?.message || "falha ao reagir" });
  }
});

// Converte o áudio do navegador (WebM/Opus) em MP4/AAC: o iPhone recusa o
// Opus gerado pelo ffmpeg em mensagens de voz, mas toca AAC nativamente.
function toMp4Aac(input) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg indisponível"));
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "44100", "-c:a", "aac", "-b:a", "64k", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"]);
    const out = []; let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(err || `ffmpeg ${code}`))));
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

app.post("/send-document", async (req, res) => {
  if (!sock?.user) return res.status(409).json({ error: "WhatsApp desconectado" });
  const { to, filename, base64, caption, mimetype } = req.body || {};
  if (!to || !filename || !base64) return res.status(400).json({ error: "to, filename e base64 são obrigatórios" });
  try {
    const digits = String(to).replace(/\D/g, "");
    const jid = String(to).includes("@") ? String(to) : `${digits}@s.whatsapp.net`;
    const buf = Buffer.from(base64, "base64");
    const mime = mimetype || "application/pdf";
    const isAudio = mime.startsWith("audio/");
    // Áudio que não veio do WhatsApp (gravado no navegador) vira MP4/AAC,
    // formato que toca no iPhone e no Android. Ogg nativo é mantido.
    let audioBuf = buf;
    let audioMime = /ogg/i.test(mime) ? "audio/ogg; codecs=opus" : "audio/mp4";
    if (isAudio && !/ogg/i.test(mime)) {
      try {
        audioBuf = await toMp4Aac(buf);
      } catch (e) {
        console.error("[send-document] conversão mp4 falhou:", e?.message);
        return res.status(500).json({ error: "não consegui converter o áudio para o formato do WhatsApp — tente gravar de novo" });
      }
    }
    const sent = await sock.sendMessage(
      jid,
      mime.startsWith("image/")
        ? { image: buf, mimetype: mime, caption: caption || undefined }
        : mime.startsWith("video/")
          ? { video: buf, mimetype: mime, caption: caption || undefined }
          : isAudio
            // ptt:true mostra como mensagem de voz, nunca documento/anexo.
            ? { audio: audioBuf, mimetype: audioMime, ptt: true, fileName: undefined }
            : { document: buf, mimetype: mime, fileName: filename, caption: caption || undefined },
    );
    res.json({ externalId: sent?.key?.id ?? null });
  } catch (e) {
    console.error("[send-document] falhou:", e?.message);
    res.status(500).json({ error: e?.message || "falha ao enviar o anexo" });
  }
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
