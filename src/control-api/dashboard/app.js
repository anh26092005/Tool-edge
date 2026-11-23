/* global attachDashboardTaskResults */
const $ = id => document.getElementById(id)
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}" /></svg>`
const escape = value =>
    String(value ?? '').replace(
        /[&<>"']/g,
        character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
    )
const number = value => (Number.isFinite(value) ? new Intl.NumberFormat('vi-VN').format(value) : '—')
const dateTime = value =>
    value ? new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : 'Chưa có dữ liệu'
const labels = {
    pending: ['Đang chờ', 'neutral'],
    starting: ['Đang khởi động', 'running'],
    running: ['Đang thực hiện', 'running'],
    stopping: ['Đang dừng', 'warning'],
    completed: ['Hoàn tất', 'success'],
    partial: ['Chưa hoàn tất', 'warning'],
    failed: ['Có lỗi', 'error'],
    interrupted: ['Bị gián đoạn', 'error'],
    cancelled: ['Đã dừng', 'neutral'],
    skipped: ['Bỏ qua', 'neutral'],
    ready: ['Sẵn sàng', 'success'],
    missing: ['Cần đăng nhập', 'warning'],
    needsDesktop: ['Thiếu phiên desktop', 'warning'],
    needsMobile: ['Thiếu phiên mobile', 'warning'],
    signingIn: ['Đang đăng nhập', 'running'],
    queued: ['Đang chờ khởi động', 'neutral'],
    done: ['DONE — Hết nhiệm vụ', 'success'],
    unverified: ['Chưa xác nhận hết nhiệm vụ', 'warning']
}
const badge = (status, customLabel) => {
    const [label, style] = labels[status] ?? [status || 'Chưa chạy', 'neutral']
    return `<span class="status-badge ${style}">${escape(customLabel || label)}</span>`
}
let saved = {}
try {
    saved = JSON.parse(localStorage.getItem('rewards-dashboard-options') || '{}') ?? {}
} catch {
    /* Use initial settings when local storage is unavailable. */
}
const state = {
    snapshot: null,
    selected: new Set(),
    workers: {},
    initialized: false,
    busy: false,
    connected: false,
    token: sessionStorage.getItem('rewards-api-token') || '',
    accountKey: '',
    logKey: '',
    historyKey: '',
    detailIndex: null,
    taskResultKey: null,
    taskHistoryKey: null,
    taskHistory: []
}

async function api(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
            ...options.headers
        },
        signal: AbortSignal.timeout(12000)
    })
    let data
    try {
        data = await response.json()
    } catch {
        throw new Error('Máy chủ trả về dữ liệu không hợp lệ.')
    }
    if (!response.ok) {
        const error = Object.assign(new Error(data.error || `Yêu cầu thất bại (${response.status}).`), {
            status: response.status,
            code: data.code
        })
        if (response.status === 401 && !$('auth-dialog').open) $('auth-dialog').showModal()
        throw error
    }
    return data
}

function toast(message, error = false) {
    const element = document.createElement('div')
    element.className = `toast${error ? ' error' : ''}`
    element.textContent = message
    $('toasts').append(element)
    setTimeout(() => element.remove(), error ? 9000 : 6000)
}

function setConnection(connected, message) {
    state.connected = connected
    $('connection-dot').classList.toggle('online', connected)
    $('connection-label').textContent = connected ? 'Đã kết nối cục bộ' : 'Mất kết nối'
    $('connection-banner').hidden = connected
    $('connection-banner').textContent =
        message || 'Không kết nối được máy chủ. Dashboard sẽ tự thử lại. Khởi động lại bằng npm run dashboard nếu cần.'
    updateControls()
}

function runOptions() {
    return {
        concurrency: Number($('concurrency').value),
        mode: $('run-mode').value,
        headless: $('headless').checked,
        parallelSearching: $('parallel-searching').checked,
        workers: { ...state.workers }
    }
}

function saveOptions() {
    try {
        localStorage.setItem('rewards-dashboard-options', JSON.stringify(runOptions()))
    } catch {
        /* Controls still work without persistent browser storage. */
    }
    updateControls()
}

function initialize(snapshot) {
    if (state.initialized) return
    state.initialized = true
    state.selected = new Set(snapshot.accounts.map(account => account.index))
    $('concurrency').value =
        Number.isSafeInteger(saved.concurrency) && saved.concurrency >= 1 && saved.concurrency <= 16
            ? saved.concurrency
            : 2
    $('run-mode').value = ['api', 'browser'].includes(saved.mode) ? saved.mode : 'browser'
    $('headless').checked = typeof saved.headless === 'boolean' ? saved.headless : true
    $('parallel-searching').checked = typeof saved.parallelSearching === 'boolean' ? saved.parallelSearching : true
    for (const worker of snapshot.workers)
        state.workers[worker.key] = typeof saved.workers?.[worker.key] === 'boolean' ? saved.workers[worker.key] : true
    $('worker-options').innerHTML = snapshot.workers
        .map(
            worker => `
        <label class="task-option">
            <span class="task-symbol">${icon(worker.icon)}</span>
            <span class="task-copy"><strong>${escape(worker.label)}</strong><small>${escape(worker.hint)}</small></span>
            <input class="checkbox" type="checkbox" data-worker="${escape(worker.key)}" ${state.workers[worker.key] ? 'checked' : ''} aria-label="${escape(worker.label)}" />
        </label>`
        )
        .join('')
}

function updateControls() {
    const snapshot = state.snapshot
    const idle = snapshot?.status.state === 'idle'
    const active = snapshot && !idle
    const checkedWorkers = Object.values(state.workers).filter(Boolean).length
    const workerTotal = snapshot?.workers.length || 12
    const concurrency = Number($('concurrency').value)
    const validConcurrency = Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 16
    const effective = Math.min(concurrency, state.selected.size)
    const missing = selectedSessionGaps()
    $('session-warning').hidden = !missing.length
    if (missing.length) {
        $('session-warning-title').textContent = `Cần hoàn tất đăng nhập (${missing.length} tài khoản)`
        $('session-warning-copy').textContent =
            `${missing[0].email}: thiếu phiên ${missing[0].platforms.join(' và ')}. Phiên đã lưu sẽ được giữ lại khi tiếp tục.`
    }
    $('complete-login-button').disabled = !state.connected || state.busy || !idle || !snapshot?.capabilities.addAccounts
    const delay = snapshot?.status.run.pendingDelay
    const remaining = delay
        ? Math.max(0, Math.ceil(delay.seconds - (Date.now() - new Date(delay.sinceTs).getTime()) / 1000))
        : 0
    $('run-wait-message').hidden = !active || snapshot?.status.operation !== 'rewards' || !delay
    $('run-wait-message').textContent = delay
        ? remaining > 0
            ? `Đang chờ ${remaining} giây trước khi khởi động ${delay.nextEmail || 'tài khoản tiếp theo'}. Các tài khoản đã mở vẫn tiếp tục làm nhiệm vụ.`
            : `Đang khởi động ${delay.nextEmail || 'tài khoản tiếp theo'}…`
        : ''
    $('concurrency-help').textContent = !validConcurrency
        ? 'Nhập số luồng từ 1 đến 16.'
        : state.selected.size
          ? `${effective} tài khoản chạy cùng lúc trong ${state.selected.size} tài khoản đã chọn.`
          : `Tối đa ${concurrency} tài khoản chạy cùng lúc.`
    $('run-selected-count').textContent = state.selected.size
    $('selection-summary').textContent = `Đã chọn ${state.selected.size} / ${snapshot?.accounts.length || 0} tài khoản`
    $('worker-count').textContent = `${checkedWorkers} / ${workerTotal}`
    $('run-worker-count').textContent = checkedWorkers
    $('toggle-all-workers').textContent = checkedWorkers === workerTotal ? 'Bỏ chọn tất cả' : 'Bật tất cả nhiệm vụ'
    $('start-button').disabled =
        !state.connected ||
        state.busy ||
        !idle ||
        !state.selected.size ||
        !checkedWorkers ||
        missing.length > 0 ||
        !validConcurrency ||
        !snapshot?.capabilities.runOptions
    $('start-button').innerHTML =
        `${icon('play')}${active ? (snapshot.status.operation === 'session-regeneration' ? 'Đang đăng nhập tài khoản…' : 'Đang thực hiện nhiệm vụ…') : 'Chạy tài khoản đã chọn'}`
    $('stop-button').disabled = !state.connected || state.busy || !active
    $('stop-button').innerHTML =
        `${icon('stop')}${snapshot?.status.state === 'stopping' ? 'Buộc dừng lượt hiện tại' : 'Dừng lượt hiện tại'}`
    $('add-account-button').disabled = !state.connected || state.busy || !idle || !snapshot?.capabilities.addAccounts
    $('refresh-button').disabled = state.busy
    document.querySelectorAll('[data-login]').forEach(button => {
        button.disabled = !state.connected || state.busy || !idle || !snapshot?.capabilities.addAccounts
    })
    const visible = filteredAccounts()
    $('select-all-accounts').checked = visible.length > 0 && visible.every(account => state.selected.has(account.index))
    $('select-all-accounts').indeterminate =
        visible.some(account => state.selected.has(account.index)) && !$('select-all-accounts').checked
    $('select-all-accounts').disabled = !visible.length
}

function missingPlatforms(account) {
    return (
        account.missingPlatforms ??
        ['desktop', 'mobile'].filter(
            platform =>
                !account.sessions.some(
                    session =>
                        session.platform === platform &&
                        session.hasStorageState &&
                        session.hasFingerprint &&
                        session.cookieCount !== 0
                )
        )
    )
}

function selectedSessionGaps() {
    const mobile = ['doMobileSearch', 'doBonusSearches', 'doAppPromotions', 'doDailyCheckIn', 'doReadToEarn'].some(
        key => state.workers[key]
    )
    return (state.snapshot?.accounts || [])
        .filter(account => state.selected.has(account.index))
        .flatMap(account => {
            const platforms = missingPlatforms(account).filter(platform => platform === 'desktop' || mobile)
            return platforms.length ? [{ index: account.index, email: account.email, platforms }] : []
        })
}

function filteredAccounts() {
    const query = $('account-search').value.trim().toLowerCase()
    return (state.snapshot?.accounts || []).filter(account => account.email.toLowerCase().includes(query))
}

function accountStatus(account) {
    const login = state.snapshot.status.run.sessionGeneration
    if (state.snapshot.status.state !== 'idle' && login?.accounts.some(item => item.index === account.index))
        return 'signingIn'
    if (account.taskResult) return account.taskResult.code
    if (account.live) return account.live.status
    const missing = missingPlatforms(account)
    if (missing.length === 1) return missing[0] === 'desktop' ? 'needsDesktop' : 'needsMobile'
    const delay = state.snapshot.status.run.pendingDelay
    if (state.snapshot.status.state !== 'idle' && delay?.nextEmail?.toLowerCase() === account.email.toLowerCase())
        return 'queued'
    if (account.sessions.filter(session => session.hasStorageState && session.cookieCount !== 0).length >= 2)
        return 'ready'
    return 'missing'
}

function accountBadge(account) {
    const status = accountStatus(account)
    return badge(status, status === account.taskResult?.code ? account.taskResult.label : undefined)
}

function renderTaskResult(snapshot) {
    const result = snapshot.taskResult
    $('task-result').hidden = !result
    if (!result) return
    $('task-result').className = `task-result ${result.tone}`
    $('task-result-title').textContent = result.label
    $('task-result-copy').textContent = result.summary
    $('task-result-symbol').innerHTML = icon(
        result.code === 'done' ? 'check' : result.code === 'running' ? 'bolt' : 'info'
    )
    $('task-result-time').textContent = result.endedAt
        ? `Kết quả lúc ${dateTime(result.endedAt)} · Phạm vi: các nhiệm vụ đã bật trong lượt này.`
        : 'Kết quả cập nhật theo từng tài khoản.'
    const key = `${result.runId}:${result.code}`
    if (state.taskResultKey && state.taskResultKey !== key && result.code === 'done') toast(result.label)
    state.taskResultKey = key
}

function renderAccounts() {
    const accounts = filteredAccounts()
    const key = JSON.stringify([accounts, [...state.selected], state.snapshot?.status.state])
    if (key === state.accountKey) return
    state.accountKey = key
    if (!accounts.length) {
        $('account-rows').innerHTML =
            `<tr><td class="table-empty" colspan="5">${icon('users')}<strong>${state.snapshot.accounts.length ? 'Không tìm thấy tài khoản' : 'Bắt đầu với tài khoản đầu tiên'}</strong>${state.snapshot.accounts.length ? 'Thử một địa chỉ email khác.' : 'Bấm “Thêm tài khoản” để mở cửa sổ đăng nhập Microsoft.'}</td></tr>`
        updateControls()
        return
    }
    $('account-rows').innerHTML = accounts
        .map(account => {
            const platforms = ['desktop', 'mobile']
                .map(platform => {
                    const ready = account.sessions.some(
                        session => session.platform === platform && session.hasStorageState && session.cookieCount !== 0
                    )
                    return `<span class="session-chip${ready ? ' ready' : ''}" title="${ready ? 'Đã có phiên lưu; có thể cần đăng nhập lại khi hết hạn' : 'Chưa có phiên đã lưu'}">${icon(platform === 'desktop' ? 'monitor' : 'phone')}${platform === 'desktop' ? 'Desktop' : 'Mobile'} ${ready ? '✓' : '—'}</span>`
                })
                .join('')
            const missing = missingPlatforms(account)
            return `<tr class="${state.selected.has(account.index) ? 'selected' : ''}">
            <td class="checkbox-cell"><input class="checkbox" type="checkbox" data-account="${account.index}" ${state.selected.has(account.index) ? 'checked' : ''} aria-label="Chọn ${escape(account.email)}" /></td>
            <td><div class="account-identity"><span class="avatar">${escape(account.email[0].toUpperCase())}</span><div><div class="account-email">${escape(account.email)}</div><div class="account-subline">#${account.index} · ${account.level ? `Cấp ${account.level}` : 'Microsoft'} ${accountBadge(account)}</div></div></div></td>
            <td><div class="session-chips">${platforms}</div></td>
            <td title="Quan sát gần nhất: ${escape(dateTime(account.balanceAt))}"><span class="balance-number">${number(account.balance)}</span><span class="balance-label">điểm Rewards</span></td>
            <td><div class="account-actions"><button class="button" data-login="${account.index}">${icon('login')}${missing.length === 1 ? `Tiếp tục ${missing[0]}` : missing.length ? 'Đăng nhập' : 'Đăng nhập lại'}</button><button class="text-button" data-detail="${account.index}">Chi tiết</button></div></td>
        </tr>`
        })
        .join('')
    updateControls()
}

function renderStats(snapshot) {
    $('stat-accounts').textContent = snapshot.accounts.length
    const signedIn = snapshot.accounts.filter(
        account =>
            accountStatus(account) !== 'missing' &&
            account.sessions.filter(session => session.hasStorageState && session.cookieCount !== 0).length >= 2
    ).length
    $('stat-sessions').textContent = `${signedIn} tài khoản có cả phiên desktop & mobile`
    $('nav-account-count').textContent = snapshot.accounts.length
    $('account-count').textContent = snapshot.accounts.length
    const active = snapshot.status.state !== 'idle' && snapshot.status.operation === 'rewards'
    const running = active
        ? snapshot.points.accounts.filter(account => !account.done && account.status === 'running').length
        : 0
    const limit = active
        ? snapshot.status.run.clusters || Math.min(Number($('concurrency').value) || 1, state.selected.size || 1)
        : Math.min(Number($('concurrency').value) || 1, state.selected.size || 1)
    $('stat-threads').textContent = `${running} / ${limit}`
    $('stat-thread-caption').textContent =
        snapshot.status.operation === 'session-regeneration' && snapshot.status.state !== 'idle'
            ? 'Đang tạo phiên đăng nhập'
            : active
              ? 'Tài khoản đang thực hiện nhiệm vụ'
              : 'Sẵn sàng cho lượt chạy tiếp theo'
    const known = snapshot.points.pointsKnown === true && Number.isFinite(snapshot.points.collected)
    $('stat-points').textContent = known ? `+${number(snapshot.points.collected)}` : '—'
    $('stat-points-caption').textContent = known
        ? 'Điểm nhận đã được xác nhận'
        : snapshot.status.run.runId
          ? 'Đang chờ số điểm được xác nhận'
          : 'Chỉ hiển thị điểm được xác nhận'
    const counts = snapshot.points.completion?.activities
    $('stat-tasks').textContent = counts ? number(counts.completed) : '—'
    $('stat-tasks-caption').textContent = counts
        ? `${counts.incomplete || 0} chưa hoàn tất · ${counts.unavailable || 0} không khả dụng`
        : 'Kết quả của lượt chạy hiện tại'
    const status = snapshot.status.state === 'idle' ? snapshot.taskResult?.code || 'ready' : snapshot.status.state
    $('global-status').className = `status-badge ${labels[status]?.[1] || 'neutral'}`
    $('global-status').textContent =
        snapshot.status.state === 'idle'
            ? status === 'done'
                ? 'DONE — Hết nhiệm vụ'
                : labels[status]?.[0] || 'Sẵn sàng'
            : snapshot.status.operation === 'session-regeneration'
              ? 'Đang đăng nhập'
              : labels[status]?.[0] || status
}

function renderLogin(snapshot) {
    const progress = snapshot.status.run.sessionGeneration
    $('login-progress').hidden = !progress
    if (!progress) return
    const active = snapshot.status.state !== 'idle'
    const complete = progress.steps.every(step => step.status === 'completed')
    const current = progress.steps.find(step => step.status === 'running')
    const instruction =
        current?.platform === 'desktop'
            ? 'Cửa sổ DESKTOP đang mở. Hoàn tất đăng nhập Microsoft ở cửa sổ máy tính này; các phiên đã lưu được giữ lại.'
            : 'Hoàn tất đăng nhập trong cửa sổ MOBILE đang mở. Khi xong, hệ thống sẽ mở tiếp phiên còn thiếu và tự lưu sau khi xác minh.'
    $('login-progress').innerHTML =
        `<h3>${icon('login')} ${active ? `Đăng nhập ${current?.platform || ''} trên máy` : complete ? 'Đã lưu phiên đăng nhập' : 'Đăng nhập chưa hoàn tất'}</h3><p>${escape(progress.accounts.map(account => account.email).join(', '))}</p><p>${active ? instruction : complete ? 'Chọn tài khoản và bấm Chạy để bắt đầu các nhiệm vụ.' : 'Bấm Tiếp tục ở tài khoản để hoàn tất đúng phiên còn thiếu.'}</p>${progress.steps.map(step => `<div class="login-step"><span>${step.platform === 'mobile' ? 'Phiên mobile' : 'Phiên desktop'}</span>${badge(step.status)}</div>`).join('')}`
}

function renderLogs(snapshot) {
    const level = $('log-level').value
    const logs = snapshot.logs.filter(log =>
        level === 'error' ? log.level === 'error' : level === 'warn' ? ['warn', 'error'].includes(log.level) : true
    )
    const key = JSON.stringify([level, logs])
    if (key === state.logKey) return
    state.logKey = key
    const output = $('log-output')
    const scrollTop = output.scrollTop
    output.innerHTML = logs.length
        ? logs
              .map(
                  log =>
                      `<div class="log-line ${escape(log.level)}"><time class="log-time">${escape(new Date(log.ts || log.receivedAt).toLocaleTimeString('vi-VN', { hour12: false }))}</time><span class="log-level">${escape(log.level.toUpperCase())}</span><span class="log-message">${log.user && !['MAIN', 'API'].includes(log.user) ? `<span class="log-user">[${escape(log.user)}]</span>` : ''}${escape(log.title ? `[${log.title}] ${log.message}` : log.message || log.raw)}</span></div>`
              )
              .join('')
        : '<div class="log-empty">Chưa có nhật ký phù hợp. Đăng nhập hoặc bắt đầu một lượt chạy để theo dõi.</div>'
    output.scrollTop = $('auto-scroll').checked ? output.scrollHeight : scrollTop
}

function renderHistory(snapshot) {
    const key = JSON.stringify(snapshot.history)
    if (key === state.historyKey) return
    state.historyKey = key
    $('history-rows').innerHTML = snapshot.history.length
        ? snapshot.history
              .map(
                  run =>
                      `<div class="history-item"><span class="history-icon">${icon(run.operation === 'session-regeneration' ? 'login' : 'play')}</span><div><div class="history-name">${run.operation === 'session-regeneration' ? 'Đăng nhập tài khoản' : 'Thực hiện nhiệm vụ'}${run.operation === 'rewards' ? ` · ${run.accounts.length} tài khoản` : ''}</div><div class="history-meta">${escape(dateTime(run.startedAt))}${run.endedAt ? ` · ${Math.max(0, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 60000))} phút` : ''}</div></div><span class="history-points">${run.pointsKnown && Number.isFinite(run.collected) ? `+${number(run.collected)} điểm` : 'Điểm chưa xác nhận'}</span>${badge(run.taskResult?.code || run.status, run.taskResult?.label)}</div>`
              )
              .join('')
        : '<p class="empty-copy">Chưa có lượt chạy nào được lưu. Lượt đầu tiên sẽ xuất hiện tại đây.</p>'
}

function renderDetails() {
    const account = state.snapshot?.accounts.find(account => account.index === state.detailIndex)
    if (!account || !$('detail-dialog').open) return
    $('detail-title').textContent = account.email
    const completion = account.live ? account.live.completion : account.lastCompletion
    const lastError = account.live ? account.live.error : account.lastError
    const sections = [
        ['completed', 'Đã hoàn tất'],
        ['incomplete', 'Chưa hoàn tất'],
        ['unavailable', 'Không khả dụng'],
        ['notApplicable', 'Không áp dụng']
    ]
    $('detail-content').innerHTML =
        `<div class="detail-summary">${accountBadge(account)}<span>Số dư quan sát: ${number(account.balance)} điểm</span><span>· Lượt gần nhất: ${escape(dateTime(account.lastRunAt))}</span></div>${account.taskResult ? `<div class="detail-row"><strong>${escape(account.taskResult.label)}</strong><p>${escape(account.taskResult.summary)}</p></div>` : ''}${lastError ? `<div class="detail-row detail-error"><strong>Lỗi của lượt gần nhất</strong><p>${escape(lastError)}</p></div>` : ''}${completion ? sections.map(([key, label]) => `<section class="detail-section"><h3>${label} (${completion.counts?.[key] ?? completion[key]?.length ?? 0})</h3>${completion[key]?.length ? completion[key].map(item => `<div class="detail-row${key === 'incomplete' ? ' detail-error' : ''}"><strong>${escape(item.title || item.label || item.activity)}</strong>${item.message || item.reason ? `<p>${escape(item.message || item.reason)}</p>` : ''}${item.pointsKnown && Number.isFinite(item.pointsGained) ? `<p>Điểm xác nhận: +${number(item.pointsGained)}</p>` : ''}</div>`).join('') : '<p class="empty-copy">Không có mục được ghi nhận.</p>'}</section>`).join('') : '<p class="empty-copy">Chi tiết nhiệm vụ sẽ xuất hiện sau khi tài khoản được chạy.</p>'}`
}

let refreshPromise
async function hydrateTaskResults(snapshot) {
    if ('taskResult' in snapshot) return snapshot
    const key = JSON.stringify(snapshot.history.map(run => [run.runId, run.status, run.endedAt]))
    if (key !== state.taskHistoryKey) {
        const history = await api('/history?limit=8')
        state.taskHistory = history.runs
        state.taskHistoryKey = key
    }
    return attachDashboardTaskResults(snapshot, state.taskHistory)
}

async function refresh() {
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
        try {
            const snapshot = await hydrateTaskResults(await api('/dashboard-api/state'))
            state.snapshot = snapshot
            initialize(snapshot)
            state.selected = new Set(
                [...state.selected].filter(index => snapshot.accounts.some(account => account.index === index))
            )
            setConnection(true)
            if (!snapshot.capabilities.addAccounts || !snapshot.capabilities.runOptions) {
                $('connection-banner').hidden = false
                $('connection-banner').textContent =
                    'Chạy npm run dashboard để bật thêm tài khoản và thiết lập đa luồng.'
            }
            renderStats(snapshot)
            renderTaskResult(snapshot)
            renderAccounts()
            renderLogin(snapshot)
            renderLogs(snapshot)
            renderHistory(snapshot)
            renderDetails()
            updateControls()
            $('last-updated').textContent = `Cập nhật ${new Date().toLocaleTimeString('vi-VN', { hour12: false })}`
            return true
        } catch (error) {
            setConnection(false, error.status === 401 ? 'Nhập API token để kết nối dashboard.' : undefined)
            $('global-status').className = 'status-badge warning'
            $('global-status').textContent = 'Chưa kết nối'
            return false
        } finally {
            refreshPromise = null
        }
    })()
    return refreshPromise
}

async function action(callback) {
    if (state.busy) return
    state.busy = true
    updateControls()
    try {
        await callback()
    } catch (error) {
        toast(error.message, true)
    } finally {
        state.busy = false
        await refresh()
        updateControls()
    }
}

async function login(index) {
    await api('/dashboard-api/login', {
        method: 'POST',
        body: JSON.stringify({ accountIndex: index })
    })
    toast('Đã mở đăng nhập. Hoàn tất xác minh trong các cửa sổ Microsoft trên máy này.')
}

$('complete-login-button').addEventListener('click', () =>
    action(async () => {
        const account = selectedSessionGaps()[0]
        if (account) await login(account.index)
    })
)

$('start-button').addEventListener('click', () =>
    action(async () => {
        const result = await api('/dashboard-api/run', {
            method: 'POST',
            body: JSON.stringify({ accountIndexes: [...state.selected], ...runOptions() })
        })
        saveOptions()
        toast(`Đã bắt đầu ${result.accounts.length} tài khoản, tối đa ${result.concurrency} luồng đồng thời.`)
    })
)
$('stop-button').addEventListener('click', () =>
    action(async () => {
        await api('/stop', {
            method: 'POST',
            body: JSON.stringify({
                runId: state.snapshot.status.runId,
                force: state.snapshot.status.state === 'stopping'
            })
        })
        toast('Đã gửi yêu cầu dừng lượt hiện tại.')
    })
)
$('refresh-button').addEventListener('click', () =>
    action(async () => {
        await refresh()
    })
)
$('add-account-button').addEventListener('click', () => {
    $('account-form-error').hidden = true
    $('account-dialog').showModal()
    $('account-email').focus()
})
$('account-form').addEventListener('submit', async event => {
    event.preventDefault()
    if (state.busy) return
    const shouldLogin = event.submitter?.value === 'login'
    const buttons = [...$('account-form').querySelectorAll('button[type="submit"]')]
    buttons.forEach(button => {
        button.disabled = true
    })
    $('account-form-error').hidden = true
    state.busy = true
    updateControls()
    try {
        const result = await api('/dashboard-api/accounts', {
            method: 'POST',
            body: JSON.stringify({ email: $('account-email').value.trim() })
        })
        state.selected.add(result.account.index)
        $('account-dialog').close()
        $('account-form').reset()
        if (shouldLogin) await login(result.account.index)
        else toast('Đã thêm tài khoản. Bấm Đăng nhập để lưu phiên trước khi chạy.')
    } catch (error) {
        if ($('account-dialog').open) {
            $('account-form-error').textContent = error.message
            $('account-form-error').hidden = false
        } else toast(error.message, true)
    } finally {
        state.busy = false
        buttons.forEach(button => {
            button.disabled = false
        })
        await refresh()
        updateControls()
    }
})
$('account-rows').addEventListener('change', event => {
    const input = event.target.closest('[data-account]')
    if (!input) return
    const index = Number(input.dataset.account)
    if (input.checked) state.selected.add(index)
    else state.selected.delete(index)
    renderAccounts()
    updateControls()
    renderStats(state.snapshot)
})
$('account-rows').addEventListener('click', event => {
    const loginButton = event.target.closest('[data-login]')
    if (loginButton) return void action(() => login(Number(loginButton.dataset.login)))
    const detailButton = event.target.closest('[data-detail]')
    if (detailButton) {
        state.detailIndex = Number(detailButton.dataset.detail)
        $('detail-dialog').showModal()
        renderDetails()
    }
})
$('account-search').addEventListener('input', renderAccounts)
$('select-all-accounts').addEventListener('change', event => {
    for (const account of filteredAccounts()) {
        if (event.target.checked) state.selected.add(account.index)
        else state.selected.delete(account.index)
    }
    renderAccounts()
    updateControls()
    renderStats(state.snapshot)
})
$('worker-options').addEventListener('change', event => {
    const input = event.target.closest('[data-worker]')
    if (!input) return
    state.workers[input.dataset.worker] = input.checked
    saveOptions()
})
$('toggle-all-workers').addEventListener('click', () => {
    const checked = !Object.values(state.workers).every(Boolean)
    for (const key of Object.keys(state.workers)) state.workers[key] = checked
    document.querySelectorAll('[data-worker]').forEach(input => {
        input.checked = checked
    })
    saveOptions()
})
for (const id of ['concurrency', 'run-mode', 'headless', 'parallel-searching'])
    $(id).addEventListener('change', () => {
        saveOptions()
        if (state.snapshot) renderStats(state.snapshot)
    })
for (const [id, increment] of [
    ['increase-concurrency', 1],
    ['decrease-concurrency', -1]
])
    $(id).addEventListener('click', () => {
        $('concurrency').value = Math.max(1, Math.min(16, (Number($('concurrency').value) || 1) + increment))
        saveOptions()
        if (state.snapshot) renderStats(state.snapshot)
    })
$('log-level').addEventListener('change', () => {
    if (state.snapshot) renderLogs(state.snapshot)
})
$('auto-scroll').addEventListener('change', () => {
    if ($('auto-scroll').checked) $('log-output').scrollTop = $('log-output').scrollHeight
})
document
    .querySelectorAll('[data-close]')
    .forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()))
document.querySelectorAll('.nav-item').forEach(link =>
    link.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === link))
    })
)
$('auth-form').addEventListener('submit', async event => {
    event.preventDefault()
    state.token = $('api-token').value.trim()
    $('auth-error').hidden = true
    if (await refresh()) {
        try {
            sessionStorage.setItem('rewards-api-token', state.token)
        } catch {
            /* The current connection can still use the in-memory token. */
        }
        $('auth-dialog').close()
        $('auth-form').reset()
    } else $('auth-error').hidden = false
})
$('auth-dialog').addEventListener('cancel', event => event.preventDefault())

async function poll() {
    await refresh()
    setTimeout(poll, document.hidden ? 7000 : 2500)
}
void poll()
