const { default: makeWASocket, useSingleFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const axios = require('axios')
const fs = require('fs')

// Check if auth.json exists, and create it if necessary
if (!fs.existsSync('./auth.json')) {
    console.log("No auth.json found. A new QR code will be generated for login.")
}

// Use Single File Auth State
const { state, saveState } = useSingleFileAuthState('./auth.json')

async function connectBot() {
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    })

    // Save authentication state updates
    sock.ev.on('creds.update', saveState)

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Connection closed. Reconnecting...', shouldReconnect)
            if (shouldReconnect) {
                connectBot()
            }
        } else if (connection === 'open') {
            console.log('Connected successfully!')
        }
    })

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!messages[0].message) return
        const msg = messages[0]
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text

        // Check if the message starts with "!ask "
        if (text && text.startsWith("!ask ")) {
            const query = text.slice(5) // Extract query after "!ask "
            const response = await queryHuggingFace(query) // Get response from Hugging Face API
            await sock.sendMessage(msg.key.remoteJid, { text: response }) // Send response back
        }
    })
}

// Query Hugging Face API
async function queryHuggingFace(prompt) {
    try {
        const response = await axios.post(
            'https://api-inference.huggingface.co/models/gpt2',
            { inputs: prompt },
            {
                headers: {
                    Authorization: `Bearer hf_your_huggingface_api_key_here`
                }
            }
        )

        // Return the generated text
        return response.data[0]?.generated_text || "No response from Hugging Face API."
    } catch (error) {
        console.error('Error querying Hugging Face API:', error)
        return "Error querying Hugging Face API."
    }
}

// Start the bot
connectBot()