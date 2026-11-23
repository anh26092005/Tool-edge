import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addDashboardAccount, enableDashboardSessionReuse } from '../dashboardAccounts.js'
import { DASHBOARD_WORKERS, resolveDashboardRun } from '../dashboardOptions.js'
import { loadAccounts, mergeAccountStats } from '../accounts.js'
import { toHistoryRecord } from '../history.js'
import { loadConfigSafe } from '../lib.js'
import { listStoredSessions } from '../sessionStore.js'
import { readJsonObject, rejectUnknownFields, requestError, sendJson } from '../http.js'
import { dashboardSessionGaps, requiredDashboardPlatforms, resolveDashboardLogin } from '../dashboardSessions.js'
import { attachDashboardTaskResults } from '../dashboardCompletion.js'

const assetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dashboard')
/** @type {Map<string, [string, string]>} */
const assets = new Map([
    ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
    ['/dashboard/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/dashboard/styles.css', ['styles.css', 'text/css; charset=utf-8']]
])

export function serveDashboard(req, res, pathname) {
    const asset = assets.get(pathname)
    if (!asset || !['GET', 'HEAD'].includes(req.method)) return false
    res.writeHead(200, {
        'Content-Type': asset[1],
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    })
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(assetRoot, asset[0])))
    return true
}

export function createDashboardRoutes({
    projectRoot,
    pm,
    allowConfigWrite,
    allowEnvOverrides,
    sessionReader = listStoredSessions
}) {
    const assertIdle = () => {
        if (pm.getStatus().shuttingDown) throw requestError('Máy chủ đang dừng.', 'SHUTTING_DOWN', 503)
        if (pm.getStatus().state !== 'idle')
            throw requestError(
                'Đang có một lượt chạy hoặc đăng nhập. Hãy đợi hoàn tất hoặc bấm Dừng.',
                'ALREADY_RUNNING',
                409
            )
    }
    return async (req, res, url, method, pathname) => {
        if (method === 'GET' && pathname === '/dashboard-api/state') {
            const status = pm.getStatus()
            const points = pm.getPoints()
            const history = pm.getHistory().slice(0, 8).map(toHistoryRecord)
            const config = loadConfigSafe(projectRoot)?.data
            if (!config) throw requestError('Không đọc được config.json.', 'CONFIG_NOT_FOUND', 404)
            const stored = sessionReader(projectRoot, config.sessionPath ?? 'sessions')
            const accounts = mergeAccountStats(loadAccounts(), history, points.accounts).map(account => {
                const live = points.accounts.find(item => item.email.toLowerCase() === account.email.toLowerCase())
                const previous = history
                    .filter(run => run.operation === 'rewards')
                    .flatMap(run => run.accounts)
                    .find(item => item.email.toLowerCase() === account.email.toLowerCase())
                return {
                    ...account,
                    balance: live?.balance ?? previous?.currentBalance ?? null,
                    balanceAt: live ? points.updatedAt : account.accountUpdatedAt,
                    live: live ?? null,
                    missingPlatforms: dashboardSessionGaps([account], stored.sessions)[0]?.platforms ?? [],
                    sessions: stored.sessions.filter(
                        session => session.email.toLowerCase() === account.email.toLowerCase()
                    )
                }
            })
            return sendJson(
                res,
                200,
                attachDashboardTaskResults(
                    {
                        status,
                        points,
                        accounts,
                        workers: DASHBOARD_WORKERS.map(({ env, ...worker }) => {
                            void env
                            return worker
                        }),
                        capabilities: { addAccounts: allowConfigWrite, runOptions: allowEnvOverrides },
                        history: history.map(run => ({
                            runId: run.runId,
                            operation: run.operation,
                            startedAt: run.startedAt,
                            endedAt: run.endedAt,
                            status: run.status,
                            collected: run.collected,
                            pointsKnown: run.pointsKnown,
                            accounts: run.accounts.map(account => ({
                                email: account.email,
                                status: account.status,
                                error: account.error
                            }))
                        })),
                        logs: pm.getLogs({ limit: 200, minLevel: 'info' }).logs
                    },
                    history
                )
            )
        }
        if (method === 'POST' && pathname === '/dashboard-api/accounts') {
            if (!allowConfigWrite)
                throw requestError('Khởi động bằng npm run dashboard để thêm tài khoản.', 'WRITE_DISABLED', 403)
            const body = await readJsonObject(req)
            rejectUnknownFields(body, ['email'])
            assertIdle()
            const account = addDashboardAccount(projectRoot, body.email)
            pm.note('info', `Added ACCOUNT_${account.index}: ${account.email} from dashboard.`)
            return sendJson(res, 201, { added: true, account })
        }
        if (method === 'POST' && pathname === '/dashboard-api/login') {
            if (!allowConfigWrite)
                throw requestError('Khởi động bằng npm run dashboard để đăng nhập và lưu phiên.', 'WRITE_DISABLED', 403)
            const body = await readJsonObject(req)
            rejectUnknownFields(body, ['accountIndex', 'platform', 'fresh'])
            assertIdle()
            const account = loadAccounts().find(account => account.index === body.accountIndex)
            if (!account) throw requestError('Không tìm thấy tài khoản đã chọn.', 'INVALID_SELECTION')
            const config = loadConfigSafe(projectRoot)?.data
            if (!config) throw requestError('Không đọc được config.json.', 'CONFIG_NOT_FOUND', 404)
            const stored = sessionReader(projectRoot, config.sessionPath ?? 'sessions')
            const options = resolveDashboardLogin(account, stored.sessions, body)
            enableDashboardSessionReuse(projectRoot, account.index)
            const info = pm.startManualSession({
                account: { index: account.index, email: account.email },
                ...options
            })
            return sendJson(res, 202, { ...info, account: { index: account.index, email: account.email } })
        }
        if (method === 'POST' && pathname === '/dashboard-api/run') {
            if (!allowEnvOverrides)
                throw requestError(
                    'Khởi động bằng npm run dashboard để chọn luồng và nhiệm vụ.',
                    'OVERRIDES_DISABLED',
                    403
                )
            const body = await readJsonObject(req)
            assertIdle()
            const options = resolveDashboardRun(body)
            const config = loadConfigSafe(projectRoot)?.data
            if (!config) throw requestError('Không đọc được config.json.', 'CONFIG_NOT_FOUND', 404)
            const stored = sessionReader(projectRoot, config.sessionPath ?? 'sessions')
            const missing = dashboardSessionGaps(
                options.accounts,
                stored.sessions,
                requiredDashboardPlatforms(body.workers)
            )
            if (missing.length) {
                const account = missing[0]
                throw requestError(
                    `Tài khoản ${account.email} còn thiếu phiên ${account.platforms.join(' và ')}. Bấm Hoàn tất đăng nhập trước khi chạy.`,
                    'LOGIN_REQUIRED',
                    409
                )
            }
            const info = pm.start({ env: options.env })
            return sendJson(res, 202, { ...info, concurrency: options.concurrency, accounts: options.accounts })
        }
        return sendJson(res, 404, { error: 'Not found', path: pathname })
    }
}
