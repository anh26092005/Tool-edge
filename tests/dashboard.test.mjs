import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { addDashboardAccount, enableDashboardSessionReuse } from '../dist/control-api/dashboardAccounts.js'
import { DASHBOARD_WORKERS, resolveDashboardRun } from '../dist/control-api/dashboardOptions.js'
import { ProcessManager } from '../dist/control-api/processManager.js'
import { createDashboardRoutes, serveDashboard } from '../dist/control-api/routes/dashboard.js'
import { createAccessControl } from '../dist/control-api/access.js'
import { sendRequestError } from '../dist/control-api/http.js'
import {
    dashboardSessionGaps,
    requiredDashboardPlatforms,
    resolveDashboardLogin
} from '../dist/control-api/dashboardSessions.js'
import { createRunState } from '../dist/control-api/logs/state.js'
import { applyLogToRunState } from '../dist/control-api/logs/apply.js'
import { describeAccountTaskResult, describeRunTaskResult } from '../dist/control-api/dashboardCompletion.js'

function temporaryProject(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-dashboard-test-'))
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ sessionPath: 'sessions' }))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    return directory
}

const accounts = {
    ACCOUNT_1_EMAIL: 'first@example.com',
    ACCOUNT_1_PASSWORD: 'keep-this-private',
    ACCOUNT_3_EMAIL: 'third@example.com',
    ACCOUNT_3_SAVE_FINGERPRINT_MOBILE: 'true'
}
const controls = () => ({
    accountIndexes: [1, 3],
    concurrency: 2,
    mode: 'browser',
    headless: true,
    parallelSearching: true,
    workers: Object.fromEntries(DASHBOARD_WORKERS.map(worker => [worker.key, true]))
})

function isolatedAccountEnv(t) {
    const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^ACCOUNT_\d+_/.test(key)))
    for (const key of Object.keys(previous)) delete process.env[key]
    Object.assign(process.env, accounts)
    t.after(() => {
        for (const key of Object.keys(process.env)) if (/^ACCOUNT_\d+_/.test(key)) delete process.env[key]
        Object.assign(process.env, previous)
    })
}

test('adding accounts preserves credentials, comments and numbered gaps; duplicates cannot overwrite them', t => {
    const directory = temporaryProject(t)
    const original =
        '# Keep this comment\r\nACCOUNT_1_EMAIL=first@example.com\r\nACCOUNT_1_PASSWORD=unchanged\r\nACCOUNT_3_EMAIL=third@example.com\r\n'
    fs.writeFileSync(path.join(directory, '.env'), original)
    const environment = { ...accounts }
    const added = addDashboardAccount(directory, 'second+rewards@outlook.com', environment)
    assert.equal(added.index, 2)
    assert.equal(environment.ACCOUNT_2_EMAIL, 'second+rewards@outlook.com')
    assert.equal(environment.ACCOUNT_2_SAVE_FINGERPRINT_DESKTOP, 'true')
    assert.ok(fs.readFileSync(path.join(directory, '.env'), 'utf8').startsWith(original))
    assert.equal(fs.readFileSync(path.join(directory, '.env.bak'), 'utf8'), original)
    assert.throws(() => addDashboardAccount(directory, 'FIRST@example.com', environment), { code: 'ACCOUNT_EXISTS' })
    const current = fs.readFileSync(path.join(directory, '.env'), 'utf8')
    for (const invalid of [
        'bad@example.com\nAPI_TOKEN=other',
        'bad#name@example.com',
        'invalid',
        'a@b.com\rACCOUNT_1_PASSWORD=x'
    ]) {
        assert.throws(() => addDashboardAccount(directory, invalid, environment), { code: 'INVALID_EMAIL' })
    }
    assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), current)
})

test('manual session reuse updates both fingerprint flags without altering passwords or line endings', t => {
    const directory = temporaryProject(t)
    const original =
        '# comment\r\n\r\nACCOUNT_1_EMAIL=first@example.com\r\nACCOUNT_1_PASSWORD="with # spaces"\r\nACCOUNT_1_SAVE_FINGERPRINT_MOBILE=false\r\n'
    fs.writeFileSync(path.join(directory, '.env'), original)
    const environment = { ...accounts }
    enableDashboardSessionReuse(directory, 1, environment)
    const result = fs.readFileSync(path.join(directory, '.env'), 'utf8')
    assert.ok(result.startsWith('# comment\r\n\r\n'))
    assert.ok(result.includes('ACCOUNT_1_PASSWORD="with # spaces"\r\n'))
    assert.ok(result.includes('ACCOUNT_1_SAVE_FINGERPRINT_MOBILE=true\r\n'))
    assert.ok(result.includes('ACCOUNT_1_SAVE_FINGERPRINT_DESKTOP=true\r\n'))
    assert.equal(environment.ACCOUNT_1_SAVE_FINGERPRINT_MOBILE, 'true')
    assert.equal(environment.ACCOUNT_1_SAVE_FINGERPRINT_DESKTOP, 'true')
})

test('selected accounts become real bot worker overrides, including all twelve task groups', () => {
    const options = resolveDashboardRun(controls(), accounts)
    assert.equal(options.concurrency, 2)
    assert.equal(options.env.CONFIG_CLUSTERS, '2')
    assert.equal(options.env.CONFIG_HEADLESS, 'true')
    assert.equal(options.env.CONFIG_SEARCH_PARALLEL, 'true')
    assert.equal(options.env.ACCOUNT_1_EMAIL, accounts.ACCOUNT_1_EMAIL)
    assert.equal(options.env.ACCOUNT_2_EMAIL, accounts.ACCOUNT_3_EMAIL)
    assert.equal(options.env.ACCOUNT_3_EMAIL, '')
    assert.equal(options.env.CONFIG_AUTO_CLAIM_PUNCHCARD_REWARDS, 'true')
    for (const worker of DASHBOARD_WORKERS) assert.equal(options.env[worker.env], 'true')
    assert.equal(DASHBOARD_WORKERS.length, 12)
})

test('concurrency is limited to the selected accounts, and excluded credentials are cleared', () => {
    const options = resolveDashboardRun({ ...controls(), accountIndexes: [3], concurrency: 16 }, accounts)
    assert.equal(options.concurrency, 1)
    assert.equal(options.env.CONFIG_CLUSTERS, '1')
    assert.equal(options.env.ACCOUNT_1_EMAIL, accounts.ACCOUNT_3_EMAIL)
    assert.equal(options.env.ACCOUNT_1_PASSWORD, '')
    assert.equal(options.accounts[0].index, 3)
})

test('invalid selection, task switches, arbitrary overrides and duplicate identities are rejected', () => {
    for (const changes of [
        { accountIndexes: [] },
        { accountIndexes: [2] },
        { accountIndexes: [1, 1] },
        { concurrency: 0 },
        { concurrency: 17 },
        { concurrency: 1.5 },
        { concurrency: '2' },
        { headless: 'true' },
        { mode: 'other' },
        { env: { NODE_OPTIONS: '--inspect' } },
        { workers: {} },
        { workers: { ...controls().workers, unexpected: true } },
        { workers: Object.fromEntries(DASHBOARD_WORKERS.map(worker => [worker.key, false])) }
    ])
        assert.throws(() => resolveDashboardRun({ ...controls(), ...changes }, accounts))
    assert.throws(() => resolveDashboardRun(controls(), { ...accounts, ACCOUNT_3_EMAIL: 'FIRST@example.com' }))
})

test('a partially saved login resumes the missing desktop without repeating or clearing mobile', () => {
    const account = { index: 3, email: 'third@example.com' }
    const mobile = {
        email: account.email,
        platform: 'mobile',
        hasStorageState: true,
        hasFingerprint: true,
        cookieCount: 10
    }
    assert.deepEqual(resolveDashboardLogin(account, [mobile], {}), { platform: 'desktop', fresh: false })
    assert.deepEqual(dashboardSessionGaps([account], [mobile]), [{ ...account, platforms: ['desktop'] }])
    const desktop = { ...mobile, platform: 'desktop' }
    assert.deepEqual(resolveDashboardLogin(account, [mobile, desktop], {}), { platform: 'both', fresh: true })
    assert.deepEqual(resolveDashboardLogin(account, [mobile], { platform: 'mobile', fresh: true }), {
        platform: 'mobile',
        fresh: true
    })
    assert.deepEqual(requiredDashboardPlatforms({ doDesktopSearch: true }), ['desktop'])
    assert.deepEqual(requiredDashboardPlatforms({ doReadToEarn: true }), ['desktop', 'mobile'])
})

test('a worker starting earlier does not erase the delayed-account countdown', () => {
    const state = createRunState('countdown-regression')
    const entry = (title, message, at) => ({ parsed: true, title, message, ts: at, level: 'info' })
    applyLogToRunState(
        state,
        entry(
            'ACCOUNT-DELAY',
            'Waiting 107.1 seconds before starting the next account (third@example.com) | waitMs=107117',
            '2026-11-20T17:00:00.000Z'
        )
    )
    applyLogToRunState(
        state,
        entry(
            'ACCOUNT-START',
            'Starting account: first@example.com | geoLocale: auto | locale: vi-VN | cachedRegion: VN',
            '2026-11-20T17:00:00.500Z'
        )
    )
    assert.equal(state.pendingDelay.nextEmail, 'third@example.com')
    assert.equal(state.pendingDelay.seconds, 107.117)
    applyLogToRunState(
        state,
        entry(
            'ACCOUNT-START',
            'Starting account: third@example.com | geoLocale: auto | locale: vi-VN | cachedRegion: VN',
            '2026-11-20T17:01:48.000Z'
        )
    )
    assert.equal(state.pendingDelay, null)
})

function completedAccount(email = 'first@example.com') {
    return {
        email,
        status: 'completed',
        success: true,
        done: true,
        completion: {
            counts: { completed: 0, incomplete: 0, unavailable: 2, notApplicable: 1 },
            accountReason: null
        }
    }
}

function completedRun() {
    return {
        runId: 'verified-completion',
        operation: 'rewards',
        status: 'completed',
        executionComplete: true,
        accountsTotal: 2,
        accounts: [completedAccount(), completedAccount('third@example.com')],
        completion: {
            detailsKnown: true,
            activities: { completed: 0, incomplete: 0, unavailable: 4, notApplicable: 2 }
        }
    }
}

test('DONE includes already-finished or unavailable tasks without requiring new points', () => {
    const account = completedAccount()
    const result = describeAccountTaskResult(account)
    assert.equal(result.code, 'done')
    assert.match(result.label, /DONE/)
    assert.match(result.summary, /2 không khả dụng/)
    assert.equal(describeAccountTaskResult({ ...account, done: false }).code, 'running')
    assert.equal(describeAccountTaskResult({ ...account, completion: null }).code, 'unverified')
    assert.equal(describeAccountTaskResult({ ...account, error: 'Claim still unconfirmed' }).code, 'partial')
})

test('a stopped or failed account is never DONE just because its process ended', () => {
    for (const status of ['partial', 'failed', 'cancelled', 'interrupted', 'skipped']) {
        assert.notEqual(describeAccountTaskResult({ ...completedAccount(), status, success: false }).code, 'done')
    }
    assert.equal(describeAccountTaskResult({ ...completedAccount(), status: 'running' }).code, 'running')
    const account = completedAccount()
    account.completion.counts.incomplete = 1
    assert.equal(describeAccountTaskResult(account).code, 'partial')
})

test('multi-account DONE requires every expected account and a verified, complete run', () => {
    const run = completedRun()
    const result = describeRunTaskResult(run)
    assert.equal(result.code, 'done')
    assert.equal(result.completedAccounts, 2)
    assert.equal(result.totalAccounts, 2)
    assert.equal(describeRunTaskResult({ ...run, active: true }).code, 'running')
    assert.equal(describeRunTaskResult({ ...run, executionComplete: false }).code, 'unverified')
    assert.equal(describeRunTaskResult({ ...run, accounts: run.accounts.slice(0, 1) }).code, 'unverified')
    assert.equal(
        describeRunTaskResult({ ...run, completion: { ...run.completion, detailsKnown: false } }).code,
        'unverified'
    )
    assert.equal(describeRunTaskResult({ ...run, operation: 'session-regeneration' }), null)
    run.accounts[1].status = 'partial'
    run.accounts[1].success = false
    run.status = 'partial'
    assert.equal(describeRunTaskResult(run).code, 'partial')
    assert.equal(describeRunTaskResult(run).completedAccounts, 1)
    for (const status of ['cancelled', 'failed', 'interrupted']) {
        assert.equal(describeRunTaskResult({ ...run, status }).code, status)
    }
})

function createManager(t, directory, fixture) {
    const manager = new ProcessManager({
        command: process.execPath,
        args: [fixture],
        manualSessionCommand: { command: process.execPath, args: [fixture] },
        cwd: directory,
        stopTimeoutMs: 1000
    })
    t.after(async () => {
        if (manager.state !== 'idle') await manager.stop({ force: true })
    })
    return manager
}

test('manual login reports both saved platforms through the shared controller and prevents overlapping runs', async t => {
    const directory = temporaryProject(t)
    const fixture = path.join(directory, 'manual.cjs')
    fs.writeFileSync(
        fixture,
        `
        const email = process.argv[2]
        function event(platform, status) {
            console.log('__REWARDS_EVENT__ ' + JSON.stringify({version: 2, runId: process.env.REWARDS_RUN_ID,
                ts: new Date().toISOString(), user: email, platform: platform.toUpperCase(), level: 'info',
                title: 'SESSION-GENERATION', message: status, data: {kind: 'session', email, platform, status}}))
        }
        event('mobile', 'running')
        setTimeout(() => {
            event('mobile', 'completed'); event('desktop', 'running'); event('desktop', 'completed')
            if (process.connected) process.disconnect()
        }, 30)
    `
    )
    const manager = createManager(t, directory, fixture)
    const exited = once(manager, 'exit')
    const started = manager.startManualSession({
        account: { index: 1, email: 'first@example.com' },
        platform: 'both',
        fresh: true
    })
    assert.equal(started.operation, 'session-regeneration')
    assert.ok(started.args.includes('--fresh'))
    assert.throws(() => manager.start(), { code: 'ALREADY_RUNNING' })
    const [exit] = await exited
    assert.equal(exit.status, 'completed')
    assert.equal(exit.executionComplete, true)
    assert.deepEqual(
        manager.getStatus().run.sessionGeneration.steps.map(step => step.status),
        ['completed', 'completed']
    )
    assert.equal(manager.state, 'idle')
})

test('dashboard HTTP routes pass selected concurrency to the child, support same-origin POST and stop by run ID', async t => {
    isolatedAccountEnv(t)
    const directory = temporaryProject(t)
    fs.writeFileSync(path.join(directory, '.env'), 'ACCOUNT_1_EMAIL=first@example.com\n')
    const fixture = path.join(directory, 'run.cjs')
    fs.writeFileSync(
        fixture,
        `
        const fs = require('node:fs')
        fs.writeFileSync('observed.json', JSON.stringify({clusters: process.env.CONFIG_CLUSTERS,
            email1: process.env.ACCOUNT_1_EMAIL, email2: process.env.ACCOUNT_2_EMAIL,
            mobile: process.env.CONFIG_WORKER_MOBILE_SEARCH, read: process.env.CONFIG_WORKER_READ_TO_EARN}))
        console.log('fixture-ready')
        const timer = setInterval(() => {}, 1000)
        process.on('message', message => { if(message.__control === 'stop') { clearInterval(timer); process.exitCode = 143; process.disconnect() } })
    `
    )
    const manager = createManager(t, directory, fixture)
    const savedSessions = []
    const routes = createDashboardRoutes({
        projectRoot: directory,
        pm: manager,
        allowConfigWrite: true,
        allowEnvOverrides: true,
        sessionReader: () => ({ sessions: savedSessions })
    })
    const authorize = createAccessControl({ corsOrigin: 'http://localhost:3000' })
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`)
        if (serveDashboard(req, res, url.pathname)) return
        if (!authorize(req, res, url)) return
        void routes(req, res, url, req.method, url.pathname).catch(error => sendRequestError(res, error, () => {}))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const base = `http://127.0.0.1:${server.address().port}`
    const post = (url, body, origin = base) =>
        fetch(base + url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify(body)
        })
    const html = await fetch(base + '/dashboard')
    assert.equal(html.status, 200)
    assert.ok((await html.text()).includes('Trung tâm Rewards'))
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/)
    assert.equal((await post('/dashboard-api/run', controls(), 'https://untrusted.example')).status, 403)
    const missingLogin = await post('/dashboard-api/run', controls())
    assert.equal(missingLogin.status, 409)
    assert.equal((await missingLogin.json()).code, 'LOGIN_REQUIRED')
    assert.equal(manager.state, 'idle')
    for (const email of [accounts.ACCOUNT_1_EMAIL, accounts.ACCOUNT_3_EMAIL]) {
        for (const platform of ['desktop', 'mobile']) {
            savedSessions.push({ email, platform, hasStorageState: true, hasFingerprint: true, cookieCount: 10 })
        }
    }
    const ready = new Promise(resolve => {
        const listener = entry => {
            if (entry.message === 'fixture-ready') {
                manager.off('log', listener)
                resolve()
            }
        }
        manager.on('log', listener)
    })
    const response = await post('/dashboard-api/run', controls())
    assert.equal(response.status, 202)
    const started = await response.json()
    await ready
    assert.equal(started.concurrency, 2)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'observed.json'), 'utf8')), {
        clusters: '2',
        email1: accounts.ACCOUNT_1_EMAIL,
        email2: accounts.ACCOUNT_3_EMAIL,
        mobile: 'true',
        read: 'true'
    })
    assert.equal((await post('/dashboard-api/login', { accountIndex: 1 })).status, 409)
    const original = fs.readFileSync(path.join(directory, '.env'), 'utf8')
    assert.equal((await post('/dashboard-api/accounts', { email: 'next@example.com' })).status, 409)
    assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), original)
    assert.throws(() => manager.stop({ runId: 'stale-job' }), { code: 'RUN_CHANGED' })
    await manager.stop({ runId: started.runId })
    assert.equal(manager.lastExit.status, 'cancelled')
    const added = await post('/dashboard-api/accounts', { email: 'next@example.com' })
    assert.equal(added.status, 201)
    const snapshot = await (await fetch(base + '/dashboard-api/state')).json()
    assert.equal(snapshot.accounts.length, 3)
    assert.equal(snapshot.accounts.find(account => account.email === 'next@example.com').sessions.length, 0)
    assert.equal(snapshot.workers.length, 12)
    assert.ok(!JSON.stringify(snapshot).includes(accounts.ACCOUNT_1_PASSWORD))
})

test('application endpoints retain token authentication while static dashboard assets can load', () => {
    const authorize = createAccessControl({ token: 'test-token', corsOrigin: '*' })
    function check(headers) {
        let status
        const res = {
            setHeader() {},
            writeHead(code) {
                status = code
            },
            end() {}
        }
        const allowed = authorize({ method: 'POST', headers }, res, new URL('http://localhost:3010/dashboard-api/run'))
        return { allowed, status }
    }
    assert.deepEqual(check({}), { allowed: false, status: 401 })
    assert.equal(check({ authorization: 'Bearer test-token' }).allowed, true)
})

test('dashboard restores DONE and unfinished task results from history after an API restart', async t => {
    isolatedAccountEnv(t)
    const directory = temporaryProject(t)
    const manager = createManager(t, directory, 'unused-fixture.cjs')
    const run = completedRun()
    run.status = 'partial'
    run.accounts[1].status = 'partial'
    run.accounts[1].success = false
    run.accounts[1].completion.counts.incomplete = 1
    run.completion.activities.incomplete = 1
    manager.history = [
        {
            runId: run.runId,
            startedAt: '2026-11-21T01:00:00.000Z',
            endedAt: '2026-11-21T01:10:00.000Z',
            exit: { status: 'partial', executionComplete: true },
            run
        }
    ]
    const routes = createDashboardRoutes({
        projectRoot: directory,
        pm: manager,
        allowConfigWrite: true,
        allowEnvOverrides: true,
        sessionReader: () => ({ sessions: [] })
    })
    let body
    const response = {
        writeHead(status) {
            assert.equal(status, 200)
        },
        end(value) {
            body = JSON.parse(value)
        }
    }
    await routes({}, response, new URL('http://localhost/dashboard-api/state'), 'GET', '/dashboard-api/state')
    assert.equal(body.taskResult.code, 'partial')
    assert.equal(body.taskResult.completedAccounts, 1)
    assert.equal(body.accounts.find(account => account.index === 1).taskResult.code, 'done')
    assert.equal(body.accounts.find(account => account.index === 3).taskResult.code, 'partial')
    assert.equal(body.history[0].taskResult.code, 'partial')
    assert.equal(body.taskResult.endedAt, '2026-11-21T01:10:00.000Z')
})
