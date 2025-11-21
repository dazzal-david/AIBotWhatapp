import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';

// --- CONFIGURATION ---
const OPENROUTER_API_KEY = ''; // <--- APPPPPIII
const OPENROUTER_MODEL = 'qwen/qwen3-14b:free'; 
const SYSTEM_PROMPT = "You are a helpful AI assistant on WhatsApp. Keep your answers concise and friendly.";

// Creates new folder for auth
const AUTH_FOLDER = 'auth_info_baileys';

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), 
        auth: state,
        markOnlineOnConnect: true,
    });

    // Handle Connection Updates (QR Code, Connect, Disconnect)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Manually handle QR code generation
        if (qr) {
            console.log('Please scan the QR code below with your WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            // Reconnect if it wasn't a logout
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connection opened successfully!');
        }
    });

    // Save credentials whenever they update
    sock.ev.on('creds.update', saveCreds);

    // Listen for Incoming Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            // 1. Ignore messages sent by the bot itself
            if (msg.key.fromMe) continue;

            // 2. Ignore status updates (broadcasts)
            if (msg.key.remoteJid === 'status@broadcast') continue;

            // 3. Extract message text (handles simple text and replies)
            const messageText = msg.message?.conversation || 
                                msg.message?.extendedTextMessage?.text || 
                                msg.message?.imageMessage?.caption ||
                                '';

            if (!messageText) continue;

            console.log(`📩 Received from ${msg.pushName || 'Unknown'}: ${messageText}`);

            try {
                // 4. Simulate "typing..." state
                await sock.sendPresenceUpdate('composing', msg.key.remoteJid);

                // 5. Get AI Response from OpenRouter
                const aiResponse = await getOpenRouterResponse(messageText);

                // 6. Stop "typing..." state
                await sock.sendPresenceUpdate('paused', msg.key.remoteJid);

                // 7. Send the Reply
                await sock.sendMessage(msg.key.remoteJid, { 
                    text: aiResponse 
                }, { quoted: msg });

                console.log(`🤖 Replied: ${aiResponse}`);

            } catch (error) {
                console.error('Error processing message:', error);
            }
        }
    });
}

// Function to call OpenRouter API
async function getOpenRouterResponse(userMessage) {
    if (OPENROUTER_API_KEY === 'YOUR_OPENROUTER_KEY_HERE') {
        return "⚠️ Error: OpenRouter API Key is missing in the code.";
    }

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://whatsapp-bot.local",
                "X-Title": "WhatsApp AI Bot"
            },
            body: JSON.stringify({
                "model": OPENROUTER_MODEL,
                "messages": [
                    { "role": "system", "content": SYSTEM_PROMPT },
                    { "role": "user", "content": userMessage }
                ]
            })
        });

        const data = await response.json();
        
        if (data.error) {
            console.error("OpenRouter API Error:", data.error);
            return "Sorry, I'm having trouble thinking right now.";
        }

        return data.choices[0].message.content || "No response generated.";

    } catch (error) {
        console.error("Fetch Error:", error);
        return "Sorry, connection to AI failed.";
    }
}

// Start the bot
connectToWhatsApp();