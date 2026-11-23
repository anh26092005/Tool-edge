import { buildExcludedAccountsEnv, loadAccounts } from './accounts.js'
import { rejectUnknownFields, requestError } from './http.js'

export const DASHBOARD_WORKERS = [
    {
        key: 'doDailySet',
        env: 'CONFIG_WORKER_DAILY_SET',
        label: 'Bộ nhiệm vụ hằng ngày',
        hint: 'Daily Set và chuỗi ngày liên tiếp',
        icon: 'calendar'
    },
    {
        key: 'doClaimBonusPoints',
        env: 'CONFIG_WORKER_CLAIM_BONUS_POINTS',
        label: 'Nhận điểm thưởng',
        hint: 'Nhận các khoản thưởng khả dụng',
        icon: 'gift'
    },
    {
        key: 'doMorePromotions',
        env: 'CONFIG_WORKER_MORE_PROMOTIONS',
        label: 'Ưu đãi và hoạt động',
        hint: 'Các thẻ nhiệm vụ trên Rewards',
        icon: 'sparkles'
    },
    {
        key: 'doPunchCards',
        env: 'CONFIG_WORKER_PUNCH_CARDS',
        label: 'Thẻ nhiệm vụ',
        hint: 'Punchcard theo tuần và tháng',
        icon: 'grid'
    },
    {
        key: 'doAppPromotions',
        env: 'CONFIG_WORKER_APP_PROMOTIONS',
        label: 'Nhiệm vụ ứng dụng',
        hint: 'Các ưu đãi trong Bing / Start',
        icon: 'phone'
    },
    {
        key: 'doDesktopSearch',
        env: 'CONFIG_WORKER_DESKTOP_SEARCH',
        label: 'Tìm kiếm trên máy tính',
        hint: 'Thực hiện hạn mức desktop',
        icon: 'monitor'
    },
    {
        key: 'doMobileSearch',
        env: 'CONFIG_WORKER_MOBILE_SEARCH',
        label: 'Tìm kiếm trên điện thoại',
        hint: 'Thực hiện hạn mức mobile',
        icon: 'search'
    },
    {
        key: 'doDailyCheckIn',
        env: 'CONFIG_WORKER_DAILY_CHECKIN',
        label: 'Điểm danh mỗi ngày',
        hint: 'Daily Check-In của ứng dụng',
        icon: 'check'
    },
    {
        key: 'doReadToEarn',
        env: 'CONFIG_WORKER_READ_TO_EARN',
        label: 'Đọc bài kiếm điểm',
        hint: 'Read to Earn khi được cung cấp',
        icon: 'book'
    },
    {
        key: 'doActivateSearchPerk',
        env: 'CONFIG_WORKER_ACTIVATE_SEARCH_PERK',
        label: 'Kích hoạt ưu đãi tìm kiếm',
        hint: 'Nhận hệ số thưởng nếu khả dụng',
        icon: 'bolt'
    },
    {
        key: 'doVisualSearch',
        env: 'CONFIG_WORKER_VISUAL_SEARCH',
        label: 'Tìm kiếm bằng hình ảnh',
        hint: 'Visual Search và tiến độ chuỗi',
        icon: 'image'
    },
    {
        key: 'doBonusSearches',
        env: 'CONFIG_WORKER_BONUS_SEARCHES',
        label: 'Tìm kiếm bổ sung',
        hint: 'Tìm thêm sau hạn mức, có thể không có điểm',
        icon: 'plus'
    }
]

/** Validate GUI controls and translate them into the bot's real cluster/worker overrides. */
export function resolveDashboardRun(body, sourceEnv = process.env) {
    rejectUnknownFields(body, ['accountIndexes', 'concurrency', 'mode', 'headless', 'parallelSearching', 'workers'])
    const accounts = loadAccounts(sourceEnv)
    const indexes = body.accountIndexes
    if (
        !Array.isArray(indexes) ||
        !indexes.length ||
        indexes.some(index => !Number.isSafeInteger(index) || index < 1)
    ) {
        throw requestError('Hãy chọn ít nhất một tài khoản.', 'INVALID_SELECTION')
    }
    if (
        new Set(indexes).size !== indexes.length ||
        indexes.some(index => !accounts.some(account => account.index === index))
    ) {
        throw requestError('Danh sách tài khoản đã thay đổi. Vui lòng tải lại.', 'INVALID_SELECTION')
    }
    if (!Number.isSafeInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 16) {
        throw requestError('Số luồng phải là số nguyên từ 1 đến 16.')
    }
    if (!['browser', 'api'].includes(body.mode)) throw requestError('Chế độ chạy không hợp lệ.')
    for (const key of ['headless', 'parallelSearching']) {
        if (typeof body[key] !== 'boolean') throw requestError(`${key} phải là true hoặc false.`)
    }
    if (!body.workers || typeof body.workers !== 'object' || Array.isArray(body.workers)) {
        throw requestError('Cần chọn các nhiệm vụ sẽ chạy.')
    }
    rejectUnknownFields(
        body.workers,
        DASHBOARD_WORKERS.map(worker => worker.key)
    )
    if (DASHBOARD_WORKERS.some(worker => typeof body.workers[worker.key] !== 'boolean')) {
        throw requestError('Cấu hình nhiệm vụ không đầy đủ hoặc không hợp lệ.')
    }
    if (!Object.values(body.workers).some(Boolean)) throw requestError('Hãy bật ít nhất một nhiệm vụ.')
    const selection = buildExcludedAccountsEnv(
        accounts.filter(account => !indexes.includes(account.index)).map(account => account.index),
        sourceEnv
    )
    if (new Set(selection.includedAccounts.map(account => account.email.toLowerCase())).size !== indexes.length) {
        throw requestError('Không thể chạy đồng thời các mục trùng địa chỉ email.')
    }
    const concurrency = Math.min(body.concurrency, indexes.length)
    const env = {
        ...selection.env,
        CONFIG_CLUSTERS: String(concurrency),
        CONFIG_REWARDS_MODE: body.mode,
        CONFIG_HEADLESS: String(body.headless),
        CONFIG_SEARCH_PARALLEL: String(body.parallelSearching),
        CONFIG_SEARCH_CLUSTER: 'true',
        CONFIG_ACTIVITY_URL_REWARD: 'true',
        CONFIG_ACTIVITY_SEARCH_ON_BING: 'true',
        CONFIG_SKIP_NON_POINT_TASKS: 'false',
        CONFIG_AUTO_CLAIM_PUNCHCARD_REWARDS: String(body.workers.doPunchCards)
    }
    for (const worker of DASHBOARD_WORKERS) env[worker.env] = String(body.workers[worker.key])
    return { env, concurrency, accounts: selection.includedAccounts }
}
