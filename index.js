require("dotenv").config();
const crypto = require("crypto");

const express = require("express");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const axios = require("axios");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();

app.use(express.json());

const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || 3001;

const LARAVEL_WEBHOOK_URL = process.env.LARAVEL_WEBHOOK_URL;

const LARAVEL_WEBHOOK_SECRET = process.env.LARAVEL_WEBHOOK_SECRET;

console.log("===== WEBHOOK CONFIGURATION =====");

console.log("Webhook URL:", LARAVEL_WEBHOOK_URL);

console.log(
  "Webhook Secret:",
  LARAVEL_WEBHOOK_SECRET ? "Configured" : "NOT CONFIGURED",
);

console.log("=================================");

let sock = null;
let isConnected = false;
let reconnectTimer = null;

// Koneksi WhatsApp
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(
    process.env.SESSION_PATH || "./auth_info",
  );

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  // Simpan session WhatsApp
  sock.ev.on("creds.update", saveCreds);

  // Monitoring koneksi WhatsApp
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Tampilkan QR Code
    if (qr) {
      console.log("Silakan scan QR Code berikut:");

      qrcode.generate(qr, {
        small: true,
      });
    }

    // WhatsApp berhasil terhubung
    if (connection === "open") {
      isConnected = true;

      console.log("WhatsApp LacakDuit berhasil terhubung!");
    }

    // WhatsApp terputus
    if (connection === "close") {
      isConnected = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("WhatsApp disconnected");

      if (shouldReconnect && !reconnectTimer) {
        console.log("Mencoba reconnect...");

        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;

          connectWhatsApp().catch(console.error);
        }, 5000);
      } else if (!shouldReconnect) {
        console.log("Session logout. Login ulang diperlukan.");
      }
    }
  });

  // Menerima pesan WhatsApp

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Abaikan sinkronisasi history.
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        // Abaikan pesan dari bot sendiri.
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        const messageId = msg.key.id;
        const senderPn = msg.key.senderPn;

        if (!jid || !messageId) continue;

        // Hanya menerima personal chat.
        if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) {
          continue;
        }

        // Identifikasi pengirim pesan.
        let senderJid = jid;

        // Gunakan Phone Number JID dari Baileys
        // apabila pesan menggunakan LID.
        if (jid.endsWith("@lid")) {
          if (
            typeof senderPn === "string" &&
            /^[0-9]+(?::[0-9]+)?@s\.whatsapp\.net$/.test(senderPn)
          ) {
            senderJid = senderPn;
          }
        }

        // Normalisasi device identifier.
        senderJid = senderJid.replace(/:\d+@/, "@");

        // Ambil isi pesan text.
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        if (!text.trim()) continue;

        // Abaikan pesan yang terlalu lama.
        const timestamp = Number(msg.messageTimestamp);
        const now = Math.floor(Date.now() / 1000);

        if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300) {
          continue;
        }

        // Payload untuk Laravel.
        const payload = {
          message_id: messageId,
          from: senderJid,
          text: text.trim(),
          type: "text",
          timestamp: timestamp,
        };

        console.log("Incoming WhatsApp message.");

        console.log(
          "Identity type:",
          senderJid.endsWith("@lid") ? "LID" : "Phone Number JID",
        );

        // Teruskan pesan ke Laravel.
        const result = await forwardMessageToLaravel(payload);

        if (!result) continue;

        if (result.duplicate) {
          console.log("Duplicate message ignored.");
          continue;
        }

        // Kirim balasan menggunakan JID asli.
        if (
          result.success &&
          typeof result.reply === "string" &&
          result.reply.trim()
        ) {
          await sock.sendMessage(jid, {
            text: result.reply,
          });

          console.log("WhatsApp reply sent.");
        }
      } catch (error) {
        console.error(
          "Failed to process incoming message:",
          error.code || error.name,
        );
      }
    }
  });
}

// API utama
app.get("/", (req, res) => {
  res.json({
    app: "LacakDuit WhatsApp Gateway",
    status: "running",
    whatsapp_connected: isConnected,
  });
});

// API status WhatsApp
app.get("/status", (req, res) => {
  res.json({
    success: true,
    connected: isConnected,
  });
});

function authenticateToken(req, res, next) {
  const token = process.env.API_TOKEN;

  if (!token) {
    return res.status(503).json({
      success: false,
      message: "API token not configured",
    });
  }

  const provided = Buffer.from(req.headers.authorization || "");

  const expected = Buffer.from(`Bearer ${token}`);

  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  next();
}

app.post("/send-message", authenticateToken, async (req, res) => {
  const { phone_number, message } = req.body;

  // Validasi koneksi WhatsApp
  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp is not connected",
    });
  }

  // Validasi input
  if (
    typeof phone_number !== "string" ||
    !phone_number.trim() ||
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 4000
  ) {
    return res.status(422).json({
      success: false,
      message: "Invalid phone number or message",
    });
  }

  // Normalisasi nomor Indonesia
  let phone = phone_number.trim().replace(/[\s()+-]/g, "");

  if (phone.startsWith("0")) {
    phone = "62" + phone.substring(1);
  }

  if (!/^[1-9]\d{7,14}$/.test(phone)) {
    return res.status(422).json({
      success: false,
      message: "Invalid phone number format",
    });
  }

  try {
    // Cek nomor terdaftar di WhatsApp
    const results = await sock.onWhatsApp(phone);
    const recipient = results?.[0];

    if (!recipient?.exists) {
      return res.status(422).json({
        success: false,
        message: "Phone number is not registered on WhatsApp",
      });
    }

    // Kirim pesan
    const result = await sock.sendMessage(recipient.jid, { text: message });

    return res.json({
      success: true,
      message: "Message sent successfully",
      data: {
        phone_number: phone,
        whatsapp_jid: recipient.jid,
        message_id: result.key.id,
      },
    });
  } catch (error) {
    console.error("Send message failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to send message",
    });
  }
});

// Menjalankan server
app.listen(PORT, HOST, () => {
  console.log(`Gateway running on http://${HOST}:${PORT}`);

  connectWhatsApp().catch(console.error);
});

async function forwardMessageToLaravel(payload) {
  if (!LARAVEL_WEBHOOK_URL || !LARAVEL_WEBHOOK_SECRET) {
    console.error("Laravel webhook belum dikonfigurasi.");
    return null;
  }

  try {
    const body = JSON.stringify(payload);

    const timestamp = String(Math.floor(Date.now() / 1000));

    const signature = crypto
      .createHmac("sha256", LARAVEL_WEBHOOK_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    const response = await axios.post(LARAVEL_WEBHOOK_URL, body, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-WA-Signature": signature,
        "X-WA-Timestamp": timestamp,
      },
      timeout: 15000,
    });

    return response.data;
  } catch (error) {
    console.error(
      "Laravel webhook error:",
      error.response?.status || error.code || "UNKNOWN",
    );

    return null;
  }
}
