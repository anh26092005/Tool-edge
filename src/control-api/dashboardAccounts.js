import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadAccounts } from './accounts.js'
import { requestError } from './http.js'

function writeEnvAtomic(target, text) {
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
        if (fs.existsSync(target)) {
            fs.copyFileSync(target, `${target}.bak`)
            fs.chmodSync(`${target}.bak`, 0o600)
        }
        fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
        fs.renameSync(temporary, target)
    } finally {
        fs.rmSync(temporary, { force: true })
    }
}

export function enableDashboardSessionReuse(projectRoot, index, sourceEnv = process.env) {
    const target = path.join(projectRoot, '.env')
    let current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    const newline = current.includes('\r\n') ? '\r\n' : '\n'
    const values = {}
    for (const platform of ['MOBILE', 'DESKTOP']) {
        const key = `ACCOUNT_${index}_SAVE_FINGERPRINT_${platform}`
        const pattern = new RegExp(`^[\\t ]*${key}[\\t ]*=[^\\r\\n]*`, 'gm')
        current = pattern.test(current)
            ? current.replace(pattern, `${key}=true`)
            : `${current}${current.endsWith('\n') ? '' : newline}${key}=true${newline}`
        values[key] = 'true'
    }
    writeEnvAtomic(target, current)
    Object.assign(sourceEnv, values)
}

/** Append an account without replacing existing credentials, comments or account slots. */
export function addDashboardAccount(projectRoot, email, sourceEnv = process.env) {
    if (
        typeof email !== 'string' ||
        email.length > 320 ||
        !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(email.trim())
    ) {
        throw requestError('Vui lòng nhập địa chỉ email Microsoft hợp lệ.', 'INVALID_EMAIL')
    }
    email = email.trim()
    if (loadAccounts(sourceEnv).some(account => account.email.toLowerCase() === email.toLowerCase())) {
        throw requestError('Tài khoản này đã có trong danh sách.', 'ACCOUNT_EXISTS', 409)
    }
    const target = path.join(projectRoot, '.env')
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    const used = new Set([
        ...Object.keys(sourceEnv).map(key => /^ACCOUNT_([1-9]\d*)_/.exec(key)?.[1]),
        ...[...current.matchAll(/^\s*ACCOUNT_([1-9]\d*)_\w+\s*=/gm)].map(match => match[1])
    ])
    let index = 1
    while (used.has(String(index))) index++
    const values = {
        [`ACCOUNT_${index}_EMAIL`]: email,
        [`ACCOUNT_${index}_GEO_LOCALE`]: 'auto',
        [`ACCOUNT_${index}_LANG_CODE`]: 'vi',
        [`ACCOUNT_${index}_SAVE_FINGERPRINT_MOBILE`]: 'true',
        [`ACCOUNT_${index}_SAVE_FINGERPRINT_DESKTOP`]: 'true'
    }
    const newline = current.includes('\r\n') ? '\r\n' : '\n'
    const block = Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join(newline)
    writeEnvAtomic(
        target,
        `${current}${current.endsWith('\n') ? '' : newline}${newline}# Account ${index}${newline}${block}${newline}`
    )
    Object.assign(sourceEnv, values)
    return { index, email }
}
