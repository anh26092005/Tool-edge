import { resolveSessionOptions } from '../session/SessionGeneration.js'

export function dashboardSessionGaps(accounts, sessions, platforms = ['desktop', 'mobile']) {
    return accounts.flatMap(account => {
        const missing = platforms.filter(
            platform =>
                !sessions.some(
                    session =>
                        session.email.toLowerCase() === account.email.toLowerCase() &&
                        session.platform === platform &&
                        session.hasStorageState &&
                        session.hasFingerprint &&
                        session.cookieCount !== 0
                )
        )
        return missing.length ? [{ index: account.index, email: account.email, platforms: missing }] : []
    })
}

export function requiredDashboardPlatforms(workers) {
    const mobile = ['doMobileSearch', 'doBonusSearches', 'doAppPromotions', 'doDailyCheckIn', 'doReadToEarn'].some(
        key => workers[key]
    )
    return mobile ? ['desktop', 'mobile'] : ['desktop']
}

export function resolveDashboardLogin(account, sessions, body) {
    const missing = dashboardSessionGaps([account], sessions)[0]?.platforms ?? []
    return resolveSessionOptions({
        platform: body.platform ?? (missing.length === 1 ? missing[0] : 'both'),
        fresh: body.fresh ?? missing.length === 0
    })
}
