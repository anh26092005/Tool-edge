import logging from '../lib/logging.cjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
for (const folder of ['data', 'control-api']) {
    const source = path.join(root, 'src', folder)
    if (!fs.existsSync(source)) throw new Error(`Required build assets are missing: ${source}`)
    fs.cpSync(source, path.join(root, 'dist', folder), { recursive: true })
    logging.logMessage('BUILD', 'info', `Copied ${folder} -> dist/${folder}/`)
}

// Share the result rules with the native browser UI without another runtime request.
const completion = fs.readFileSync(path.join(root, 'src/control-api/dashboardCompletion.js'), 'utf8')
const dashboard = fs.readFileSync(path.join(root, 'src/control-api/dashboard/app.js'), 'utf8')
fs.writeFileSync(
    path.join(root, 'dist/control-api/dashboard/app.js'),
    `(() => {\n${completion.replace(/^export /gm, '')}\n${dashboard}\n})();\n`
)
