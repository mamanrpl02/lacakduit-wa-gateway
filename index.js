
require('dotenv').config();
const crypto = require('crypto');

const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();

app.use(express.json());

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || 3001;

let sock = null;
let isConnected = false;
let reconnectTimer = null;

// Koneksi WhatsApp
async function connectWhatsApp() {

    const { state, saveCreds } =
        await useMultiFileAuthState(
            process.env.SESSION_PATH || './auth_info'
        );

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    // Simpan session WhatsApp
    sock.ev.on('creds.update', saveCreds);

    // Monitoring koneksi WhatsApp
    sock.ev.on('connection.update', (update) => {

        const {
            connection,
            lastDisconnect,
            qr
        } = update;

        // Tampilkan QR Code
        if (qr) {
            console.log('Silakan scan QR Code berikut:');

            qrcode.generate(qr, {
                small: true
            });
        }

        // WhatsApp berhasil terhubung
        if (connection === 'open') {

            isConnected = true;

            console.log(
                'WhatsApp LacakDuit berhasil terhubung!'
            );
        }

        // WhatsApp terputus
        if (connection === 'close') {

            isConnected = false;

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            const shouldReconnect =
                statusCode !== DisconnectReason.loggedOut;

            console.log('WhatsApp disconnected');

            if (shouldReconnect && !reconnectTimer) {

                console.log('Mencoba reconnect...');

                reconnectTimer = setTimeout(() => {

                    reconnectTimer = null;

                    connectWhatsApp().catch(console.error);

                }, 5000);

            } else if (!shouldReconnect) {

                console.log(
                    'Session logout. Login ulang diperlukan.'
                );
            }
        }
    });

    // Menerima pesan WhatsApp
    sock.ev.on('messages.upsert', async (event) => {

        // Abaikan pesan hasil sinkronisasi history
        if (event.type !== 'notify') return;

        for (const msg of event.messages) {

            if (!msg.message) continue;

            // Abaikan pesan dari bot sendiri
            if (msg.key.fromMe) continue;

            const sender = msg.key.remoteJid;

            // Hanya menerima personal chat
            if (!sender) continue;

            if (
                !sender.endsWith('@s.whatsapp.net') &&
                !sender.endsWith('@lid')
            ) continue;

            const content =
                msg.message.ephemeralMessage?.message ||
                msg.message;

            const message =
                content.conversation ||
                content.extendedTextMessage?.text ||
                '';

            if (!message.trim()) continue;

            console.log('-----------------------');
            console.log('Sender:', sender);
            console.log('Pesan teks diterima');
            console.log('-----------------------');

            // Testing auto reply
            if (message.trim().toLowerCase() === 'ping') {

                try {

                    await sock.sendMessage(sender, {
                        text: 'Pong! LacakDuit Bot aktif.'
                    });

                } catch (error) {

                    console.error(
                        'Gagal membalas pesan:',
                        error.message
                    );
                }
            }
        }
    });
}

// API utama
app.get('/', (req, res) => {

    res.json({
        app: 'LacakDuit WhatsApp Gateway',
        status: 'running',
        whatsapp_connected: isConnected
    });
});

// API status WhatsApp
app.get('/status', (req, res) => {

    res.json({
        success: true,
        connected: isConnected
    });
});


function authenticateToken(req, res, next) {

    const token = process.env.API_TOKEN;

    if (!token) {
        return res.status(503).json({
            success: false,
            message: 'API token not configured'
        });
    }

    const provided = Buffer.from(
        req.headers.authorization || ''
    );

    const expected = Buffer.from(`Bearer ${token}`);

    if (
        provided.length !== expected.length ||
        !crypto.timingSafeEqual(provided, expected)
    ) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized'
        });
    }

    next();
}


app.post('/send-message', authenticateToken, async (req, res) => {

    const { phone_number, message } = req.body;

    // Validasi koneksi WhatsApp
    if (!isConnected || !sock) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp is not connected'
        });
    }

    // Validasi input
    if (
        typeof phone_number !== 'string' ||
        !phone_number.trim() ||
        typeof message !== 'string' ||
        !message.trim() ||
        message.length > 4000
    ) {
        return res.status(422).json({
            success: false,
            message: 'Invalid phone number or message'
        });
    }

    // Normalisasi nomor Indonesia
    let phone = phone_number.trim()
        .replace(/[\s()+-]/g, '');

    if (phone.startsWith('0')) {
        phone = '62' + phone.substring(1);
    }

    if (!/^[1-9]\d{7,14}$/.test(phone)) {
        return res.status(422).json({
            success: false,
            message: 'Invalid phone number format'
        });
    }

    try {

        // Cek nomor terdaftar di WhatsApp
        const results = await sock.onWhatsApp(phone);
        const recipient = results?.[0];

        if (!recipient?.exists) {
            return res.status(422).json({
                success: false,
                message: 'Phone number is not registered on WhatsApp'
            });
        }

        // Kirim pesan
        const result = await sock.sendMessage(
            recipient.jid,
            { text: message }
        );

        return res.json({
            success: true,
            message: 'Message sent successfully',
            data: {
                phone_number: phone,
                whatsapp_jid: recipient.jid,
                message_id: result.key.id
            }
        });

    } catch (error) {

        console.error('Send message failed:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Failed to send message'
        });
    }
});


// Menjalankan server
app.listen(PORT, HOST, () => {

    console.log(
        `Gateway running on http://${HOST}:${PORT}`
    );

    connectWhatsApp().catch(console.error);
});
