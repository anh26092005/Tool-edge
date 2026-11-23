import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import browserModule from '../dist/browser/BrowserManager.js'
import { createAppIdentity } from '../dist/rewards/app/AppIdentity.js'
import { closeSessionStore, loadSession, saveStorageState } from '../dist/session/SessionStore.js'
import { resolveAccountLocale } from '../dist/util/Locale.js'

const BrowserManager = browserModule.default

for (const platform of ['desktop', 'mobile']) {
    test(`${platform} preserves a signed-in session when auto region enriches vi to vi-VN`, async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-session-test-'))
        const account = {
            email: 'session-test@example.com',
            langCode: 'vi',
            geoLocale: 'auto',
            proxy: { url: '', port: 0 },
            saveFingerprint: { desktop: true, mobile: true }
        }
        const isMobile = platform === 'mobile'
        const bot = {
            isMobile,
            accountLocale: resolveAccountLocale(account),
            appIdentity: createAppIdentity(account.email),
            config: {
                headless: true,
                globalTimeout: 10000,
                sessionPath: directory,
                proxy: { ignoreCertificateErrors: false }
            },
            logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]))
        }
        const manager = new BrowserManager(bot)
        t.after(async () => {
            await manager.closeBrowserProcess()
            closeSessionStore()
            fs.rmSync(directory, { recursive: true, force: true })
        })

        const initial = await manager.createBrowser(account)
        await initial.context.addCookies([
            { name: 'saved-sign-in', value: 'keep-session', domain: '.bing.com', path: '/', secure: true }
        ])
        saveStorageState(directory, account.email, isMobile, await initial.context.storageState())
        const original = loadSession(directory, account.email, isMobile)
        await manager.closeBrowserProcess()

        bot.accountLocale = resolveAccountLocale(account, 'VN')
        const restored = await manager.createBrowser(account)
        assert.equal((await restored.context.cookies('https://www.bing.com'))[0]?.value, 'keep-session')
        assert.deepEqual(
            loadSession(directory, account.email, isMobile).fingerprint.fingerprint.screen,
            original.fingerprint.fingerprint.screen
        )

        let acceptLanguage
        await restored.context.route('https://www.bing.com/session-test', async route => {
            acceptLanguage = (await route.request().allHeaders())['accept-language']
            await route.fulfill({ contentType: 'text/html', body: '<title>Session regression test</title>' })
        })
        const page = await restored.context.newPage()
        await page.goto('https://www.bing.com/session-test')
        assert.equal(await page.evaluate(() => navigator.language), 'vi-VN')
        assert.equal(acceptLanguage.split(',')[0], 'vi-VN')

        await restored.context.close()
        const fresh = await manager.createBrowser(account, { fresh: true })
        assert.deepEqual(await fresh.context.cookies('https://www.bing.com'), [])
    })
}
