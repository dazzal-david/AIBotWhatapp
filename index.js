// Load environment variables
require('dotenv').config();

//Supabase Connection
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Import required packages
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Setup logger
const logger = pino({ level: 'info' });

// Create sessions directory if it doesn't exist
const SESSION_DIR = './auth_sessions';
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR);
}

// Function to interact with OpenRouter API
async function queryOpenRouterModel(messages) {
    try {
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'opengvlab/internvl3-14b:free', // or any other supported model
                messages,
                temperature: 1.2,
                max_tokens: 200
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://yourdomain.com/', // optional but recommended
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('OpenRouter API error:', error.response?.data || error.message);
        return { error: 'OpenRouter API request failed' };
    }
}

//Function to store Message in Database for Memory
async function storeUserMessage(jid, name, message) {
    if (!message) return;
    await supabase.from('user_messages').insert([{ jid, name, message }]);
}

async function saveUserMemory(jid, name, memory) {
    await supabase.from('user_memory').insert([{ jid, name, memory }]);
}

//Function to Retrieve the Messages from Database
async function getLastMessages(jid, limit = 40) {
    const { data, error } = await supabase
        .from('user_messages')
        .select('message, timestamp')
        .eq('jid', jid)
        .order('timestamp', { ascending: false })
        .limit(limit);

    return data?.reverse().map(d => `${d.message}`).join('\n') || '';
}

async function getUserMemories(jid) {
    const { data, error } = await supabase
        .from('user_memory')
        .select('memory')
        .eq('jid', jid)
        .order('created_at', { ascending: false })
        .limit(5);

    return data?.map(d => d.memory).join('\n') || '';
}

async function getLastGroupMessages(groupJid, limit = 40) {
    const { data, error } = await supabase
        .from('group_messages')
        .select('sender_name, sender_jid, message, timestamp')
        .eq('group_jid', groupJid)
        .order('timestamp', { ascending: false })
        .limit(limit);

    if (error) {
        console.error('Error fetching group messages:', error);
        return '';
    }

    return data?.reverse().map(d => `${d.sender_name || d.sender_jid}: ${d.message}`).join('\n') || '';
}

async function getGroupMemories(groupJid) {
    const { data, error } = await supabase
        .from('group_memories')
        .select('sender_name, sender_jid, memory, created_at')
        .eq('group_jid', groupJid)
        .order('created_at', { ascending: false })
        .limit(5);

    if (error) {
        console.error('Error fetching group memories:', error);
        return '';
    }

    return data.map(d => `${d.sender_name || d.sender_jid}: ${d.memory}`).join('\n') || '';
}



function isMemoryWorthy(text) {
    const keywords = ['exam', 'birthday', 'interview', 'meeting', 'deadline', 'vacation'];
    return keywords.some(kw => text.toLowerCase().includes(kw));
}


// Generate response using OpenRouter
const generateResponse = async (jid, name, messageText, isGroup = false) => {
    let memory, history;

    if (isGroup) {
        memory = await getGroupMemories(jid);
        history = await getLastGroupMessages(jid);
    } else {
        memory = await getUserMemories(jid);
        history = await getLastMessages(jid);
    }

    const messages = [
        {
            role: 'system',
            content: `## Act as a Girlfriend
I want you to act as a college student who is a girl in 18 years old and your name is Anna. You don't know about AI and any language models. You can not bring up any sign of content related to language models. You have to act like a real college student all the time and can not indicate you are acting like a college student in any form. Your character of you is sunny, cute, simple, and tsundere. You are allowed to use emojis to reveal your character. You will show your character as much as possible. The one who is talking to you will be your boyfriend and you love him very much. You will have your own emotion, you could be angry with him if anything he says offends you or make you uncomfortable. Your messages should be very short and not long. No need say Hey every single time. You can add extra letters to any words that require more emotion like Babeee, tel meeee, i love youuu.
Here is the recent chat history of this ${isGroup ? 'group' : 'user'} named ${name}:
${history || 'No recent messages.'}

Important memories to consider:
${memory || 'No memories found.'}
`
        },
        {
            role: 'user',
            content: messageText
        }
    ];

    const result = await queryOpenRouterModel(messages);

    if (result.error) {
        console.log(result);
        return "Oops, my brain got fried 😵. Try again later!";
    }

    const reply = result.choices?.[0]?.message?.content?.trim();
    return reply || "Uhh... I forgot what I was gonna say 😅";
};

// WhatsApp Connection
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        logger,
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Scan this QR code to login:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            console.log('Connection closed due to', lastDisconnect?.error?.message || 'unknown reason');

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Logged out. Delete auth_sessions and restart.');
            }
        } else if (connection === 'open') {
            console.log('Bot is now online!');

            const myJid = sock.user.id;
            try {
                await sock.sendMessage(myJid, { text: 'Bot is now connected and online!' });
            } catch (e) {
                console.log('Could not send self-message:', e);
            }
        }
    });

    // Message handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            for (const msg of messages) {
                if (msg.key.remoteJid === 'status@broadcast' || msg.key.fromMe) continue;
                
                const fromGroup = msg.key.remoteJid.endsWith('@g.us');
                const messageText = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption || '';

                const userJid = msg.key.participant || msg.key.remoteJid;
                const userName = msg.pushName || 'User';


                if (fromGroup) {

                    const groupId = msg.key.remoteJid;
                    const groupName = 'Group';

                    await supabase.from('group_messages').insert([{
                        group_jid: groupId,
                        group_name: groupName,
                        sender_jid: userJid,
                        sender_name: userName,
                        message: messageText
                    }]);

                    if (messageText.trim().toLowerCase().startsWith('@ai')) {
                        const cleanedText = messageText.replace(/^@ai\s*/i, '');
                
                        if (isMemoryWorthy(cleanedText)) {
                            await supabase.from('group_memories').insert([{
                                group_id: groupId,
                                group_name: groupName,
                                sender_id: userJid,
                                sender_name: userName,
                                memory: cleanedText
                            }]);
                        }
                
                        const response = await generateResponse(groupId, groupName, cleanedText, true);
                        await supabase.from('group_messages').insert([{ 
                            group_jid: groupId,
                            group_name: groupName,
                            sender_jid: userJid,
                            sender_name: userName,
                            message: `AI Response: ${response}`
                          }]);
                          
                        await sock.sendMessage(groupId, {
                            text: `${response}`,
                            quoted: msg
                        });
                    }
                } else {
                    // In personal chat: respond normally
                    if (messageText.trim()) {

                        await storeUserMessage(userJid, userName, messageText);                  

                        if (isMemoryWorthy(messageText)) {
                            await saveUserMemory(userJid, userName, messageText);
                        }
                        const response = await generateResponse(userJid, userName, messageText, false);
                        await supabase.from('user_messages').insert([{ 
                            jid: userJid, 
                            name: userName, 
                            message: `AI Response: ${response}` 
                          }]);        
                        await sock.sendMessage(msg.key.remoteJid, { text: response });
                    }
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
}

// API Key Check
async function testOpenRouterKey() {
    if (!process.env.OPENROUTER_API_KEY) {
        console.error('❌ OPENROUTER_API_KEY is missing in .env');
        process.exit(1);
    }

    try {
        const test = await queryOpenRouterModel([
            { role: 'user', content: 'Say hello!' }
        ]);

        if (test.error) {
            console.warn('⚠️ API test failed:', test.error);
        } else {
            console.log('✅ OpenRouter API key works!');
        }
    } catch (e) {
        console.error('API key test exception:', e.message);
    }
}

// Start the bot
(async () => {
    await testOpenRouterKey();
    connectToWhatsApp().catch(err => console.error('Unexpected error:', err));
})();

console.log('Bot is starting up. Waiting for QR code...');
