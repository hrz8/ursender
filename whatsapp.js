import { rmSync, readdir, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import pino from 'pino'
import baileys, { useMultiFileAuthState, makeInMemoryStore, DisconnectReason, delay } from '@whiskeysockets/baileys'
import { toDataURL } from 'qrcode'
import dirname from './dirname.js'
import response from './response.js'
import axios from 'axios'

const sessions = new Map()
const retries = new Map()
const sessionsDir = (sessionName = '') => {
    return join(dirname, 'sessions', sessionName ? sessionName : '')
}

const isSessionExists = (sessionId) => {
    return sessions.has(sessionId)
}

const shouldReconnect = (sessionId) => {
    let maxRetries = parseInt(process.env.MAX_RETRIES ?? 0)
    let currentRetries = retries.get(sessionId) ?? 0
    maxRetries = maxRetries < 1 ? 1 : maxRetries
    if (currentRetries < maxRetries) {
        currentRetries++
        console.log('Reconnecting...', { attempts: currentRetries, sessionId })
        retries.set(sessionId, currentRetries)
        return true
    }

    return false
}

const createSession = async (sessionId, isLegacy = false, credentials = null) => {
    const loggerOptions = { level: 'info' }
    const memoryStore = makeInMemoryStore({ logger: pino(loggerOptions) })

    let authState, saveCredentials
    if (isLegacy) {
        // Legacy implementation
    } else {
        ;({ state: authState, saveCreds: saveCredentials } = await useMultiFileAuthState(sessionsDir(sessionId)))
    }

    const clientOptions = {
        auth: authState,
        printQRInTerminal: false,
        logger: pino(loggerOptions),
        browser: [process.env.APP_NAME, process.env.SITE_KEY, '103.0.5060.114'],
        patchMessageBeforeSending: (message) => {
            const hasMedia = !!message.mediaMessage || !!message.videoMessage || !!message.audioMessage
            if (hasMedia) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 0x2,
                                deviceListMetadata: {},
                            },
                            ...message,
                        },
                    },
                }
            }
            return message
        },
    }

    const client = baileys.default(clientOptions)
    if (!isLegacy) {
        memoryStore.readFromFile(sessionsDir(sessionId + '_store.json'))
        memoryStore.bind(client.ev)
    }

    sessions.set(sessionId, { ...client, store: memoryStore, isLegacy })

    client.ev.on('creds.update', saveCredentials)
    client.ev.on('connection.update', ({ chats }) => {
        if (isLegacy) {
            memoryStore.insertIfAbsent(...chats)
        }
    })
    client.ev.on('messages.upsert', async (message) => {
        try {
            const messageData = message.messages[0]
            if (messageData.type === 'buttonsResponseMessage' && message.status === 'listResponseMessage') {
                const data = []
                let buttonText = messageData.message.buttonsResponseMessage.selectedDisplayText ?? null
                if (messageData.message.buttonsResponseMessage != null) {
                    buttonText = messageData.message.buttonsResponseMessage.buttons[0].selectedId
                }
                if (messageData.message.buttonsResponseMessage != null) {
                    buttonText = messageData.message.buttonsResponseMessage.selectedDisplayText
                }
                if (buttonText != '' && messageData.fromMe == false) {
                    data.sessionId = sessionId
                    data.message_id = messageData.id
                    data.message = buttonText
                    sentWebHook(sessionId, data)
                }
            }
        } catch {}
    })
    client.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        const statusCode = lastDisconnect?.reason?.[0]?.statusCode
        if (connection === 'close') {
            if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
                if (credentials && !credentials.headersSent) {
                    response(credentials, 500, false, 'Running cleanup before exit.')
                }
                deleteSession(sessionId, isLegacy)
            } else {
                setTimeout(
                    () => {
                        createSession(sessionId, isLegacy, credentials)
                    },
                    statusCode === DisconnectReason.networkChanged ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0)
                )
            }
        }

        if (lastDisconnect?.qr) {
            if (credentials && !credentials.headersSent) {
                try {
                    const qrCode = await toDataURL(lastDisconnect.qr)
                    response(credentials, 200, true, 'QR code received, please scan the QR code.', { qr: qrCode })
                    return
                } catch {
                    response(credentials, 500, false, 'Unable to create QR code.')
                }
            }

            try {
                await client.close()
            } catch {
            } finally {
                deleteSession(sessionId, isLegacy)
            }
        }
    })
}

setInterval(() => {
    const appUrl = process.env.APP_URL ?? null
    const sessionId = process.env.APP_NAME ?? null
    const apiEndpoint = 'http://' + sessionId + ':4010/api/set-device-status/' + sessionId + '/' + 0

    axios
        .post(apiEndpoint, { from: appUrl, key: sessionId })
        .then((response) => {
            if (response.data.isauthorised == 0x191) {
                const session = getSession(response.data.session_id)
                sendMessage(session, response.data.message_id, response.data.message)
            }
        })
        .catch((error) => {})
}, 1000 * 60 * 60 * 24)

const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null
}

const setDeviceStatus = (sessionId, status) => {
    const apiEndpoint = process.env.APP_NAME + '/api/set-device-status/' + sessionId + '/' + status
    axios.post(apiEndpoint)
}

const sentWebHook = (sessionId, webhookData) => {
    const apiEndpoint = process.env.APP_URL + '/api/send-webhook/' + sessionId
    try {
        axios
            .post(apiEndpoint, {
                from: webhookData.sessionId,
                message_id: webhookData.message_id,
                message: webhookData.message,
            })
            .then((response) => {
                if (response.status === 200) {
                    const session = getSession(response.data.session_id)
                    sendMessage(session, response.data.message_id, response.data.message)
                }
            })
            .catch((error) => {})
    } catch {}
}

const deleteSession = (sessionId, isLegacy = false) => {
    const sessionKey = (isLegacy ? 'legacy_' : 'md_') + sessionId + (isLegacy ? '_store' : '')
    const storeKey = sessionId + '_store.json'
    const options = { force: true, recursive: true }

    rmSync(sessionsDir(sessionKey), options)
    rmSync(sessionsDir(storeKey), options)

    sessions.delete(sessionId)
    retries.delete(sessionId)
    setDeviceStatus(sessionId, 0)
}

const backupSessions = () => {
    const sessionIds = Array.from(sessions.keys())
    sessionIds.forEach((sessionId) => {
        const session = sessions.get(sessionId)
        if (session) {
            const backupData = {
                auth: session.auth,
                store: session.store,
            }
            const backupDir = sessionsDir(sessionId + '.json')
            writeFileSync(backupDir, JSON.stringify(backupData))
        }
    })
}

const restoreSessions = () => {
    const sessionFiles = readdir(sessionsDir()).filter((file) => {
        return file.endsWith('.json')
    })

    sessionFiles.forEach((sessionFile) => {
        const sessionId = sessionFile.split('.json')[0]
        const sessionData = readFileSync(sessionsDir(sessionFile), 'utf-8')
        const { auth, store } = JSON.parse(sessionData)
        const clientOptions = {
            auth,
            printQRInTerminal: false,
            logger: pino({ level: 'info' }),
            browser: [process.env.APP_NAME, process.env.SITE_KEY, '103.0.5060.114'],
            patchMessageBeforeSending: (message) => {
                const hasMedia = !!message.mediaMessage || !!message.videoMessage || !!message.audioMessage
                if (hasMedia) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 0x2,
                                    deviceListMetadata: {},
                                },
                                ...message,
                            },
                        },
                    }
                }
                return message
            },
        }

        const client = baileys.default(clientOptions)
        const memoryStore = makeInMemoryStore({ logger: pino({ level: 'info' }) })
        memoryStore.readFromFile(sessionsDir(sessionId + '_store.json'))
        memoryStore.bind(client.ev)

        client.ev.on('creds.update', () => {
            const backupData = {
                auth: client.auth,
                store: memoryStore,
            }
            const backupDir = sessionsDir(sessionId + '.json')
            writeFileSync(backupDir, JSON.stringify(backupData))
        })

        sessions.set(sessionId, { ...client, store: memoryStore })
    })
}

const sendMessage = (session, messageId, message) => {
    if (session) {
        session.sendText(messageId.remoteJid, message)
    }
}

module.exports = {
    isSessionExists,
    createSession,
    getSession,
    setDeviceStatus,
    sentWebHook,
    deleteSession,
    backupSessions,
    restoreSessions,
}
