import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import projectFiles from '../lib/projectFiles.cjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
projectFiles.loadEnvFile(root)
const server = path.join(root, 'dist/control-api/server.js')
if (!fs.existsSync(server)) throw new Error('Run npm run build before starting the dashboard.')

process.env.API_ALLOW_CONFIG_WRITE ??= 'true'
process.env.API_ALLOW_ENV_OVERRIDES ??= 'true'
console.log(`Rewards Dashboard: http://127.0.0.1:${process.env.API_PORT || '3010'}/dashboard/`)
await import(pathToFileURL(server).href)
