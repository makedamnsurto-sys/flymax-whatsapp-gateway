# Flymax WhatsApp Gateway (Baileys)

Serviço que mantém seu WhatsApp conectado por QR Code e conversa com o CRM.
Precisa rodar num servidor Node sempre ligado (Railway, Render, Fly.io, VPS) —
não roda dentro do próprio app.

## Subir

1. Suba esta pasta para um repositório ou faça deploy direto (`npm install && npm start`).
2. Configure as variáveis:

| Variável | Valor |
|---|---|
| `GATEWAY_TOKEN` | uma senha longa e aleatória, inventada por você (ex.: `openssl rand -hex 32`) |
| `WEBHOOK_URL` | `https://project--c300ffa2-549a-4201-9210-544f3a4eb597.lovable.app/api/public/whatsapp` |
| `PORT` | normalmente definido pela hospedagem |
| `SESSION_DIR` | pasta persistente, ex.: `/data/session` (use disco persistente para não pedir QR de novo) |

3. No CRM, salve os segredos `WHATSAPP_GATEWAY_URL` (ex.: `https://meu-gateway.up.railway.app`) e
   `WHATSAPP_GATEWAY_TOKEN` (o mesmo `GATEWAY_TOKEN`).
4. Abra **Configurações → WhatsApp → Conectar** e leia o QR Code no celular.

## Endpoints (protegidos por `x-gateway-token`)

- `GET /status` → `{ status, qr, phone }`
- `POST /connect` / `POST /disconnect`
- `POST /send` `{ to, text }`
- envia mensagens recebidas para `WEBHOOK_URL`

> Aviso: Baileys é uma biblioteca não oficial. Use um número que você possa
> perder; a Meta pode bloquear números com uso abusivo.
