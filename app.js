import 'dotenv/config'
import express from 'express'
import nodeCleanup from 'node-cleanup'
import routes from './routes.js'
import { init, cleanup } from './whatsapp.js'
import cors from 'cors'
import morgan from 'morgan'
import chalk from 'chalk'

const app = express()

const host = process.env.WA_SERVER_HOST || undefined
const port = parseInt(process.env.WA_SERVER_PORT ?? 3300)

app.use(cors())
app.use(
    morgan((tokens, req, res) => {
        return [
            chalk.cyan(tokens.date(req, res, 'iso')),
            chalk.green.bold(tokens.method(req, res) + ':'),
            chalk.gray(tokens.url(req, res)),
            chalk.red.green(tokens.status(req, res)),
            chalk.blue(tokens.res(req, res, 'content-length')),
            chalk.yellow(tokens['response-time'](req, res) + ' ms'),
        ].join(' ')
    })
)
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use('/', routes)

const listenerCallback = () => {
    init()
    console.log(`Server is listening on http://${host ? host : '127.0.0.1'}:${port}`)
}

if (host) {
    app.listen(port, host, listenerCallback)
} else {
    app.listen(port, listenerCallback)
}

nodeCleanup(cleanup)

export default app
