// Correção necessária desde fev/2026: o WhatsApp passou a rejeitar o
// identificador "WEB" em novos pareamentos (erro 405 Connection Failure).
// A biblioteca precisa se identificar como "MACOS" para gerar o QR Code.
// Este script é executado automaticamente após `npm install` (postinstall).
import { readFileSync, writeFileSync } from "fs";

const file = "node_modules/baileys/lib/Utils/validate-connection.js";
let content = readFileSync(file, "utf8");
const before = content;
content = content.replace(
  "proto.ClientPayload.UserAgent.Platform.WEB",
  "proto.ClientPayload.UserAgent.Platform.MACOS"
);
if (content !== before) {
  writeFileSync(file, content);
  console.log("[patch] platforma MACOS aplicada em", file);
} else if (content.includes("Platform.MACOS")) {
  console.log("[patch] plataforma MACOS já aplicada");
} else {
  console.warn("[patch] padr�o não encontrado em", file);
}
