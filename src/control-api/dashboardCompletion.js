const countKeys = ['completed', 'incomplete', 'unavailable', 'notApplicable']
const presentations = new Map([
    ['done', { label: 'DONE — Đã hết nhiệm vụ', tone: 'success' }],
    ['running', { label: 'Đang thực hiện nhiệm vụ', tone: 'running' }],
    ['partial', { label: 'Còn nhiệm vụ chưa hoàn tất', tone: 'warning' }],
    ['failed', { label: 'Có lỗi — Chưa hết nhiệm vụ', tone: 'error' }],
    ['cancelled', { label: 'Đã dừng — Chưa xác nhận hết nhiệm vụ', tone: 'neutral' }],
    ['interrupted', { label: 'Bị gián đoạn — Chưa hết nhiệm vụ', tone: 'warning' }],
    ['unverified', { label: 'Chưa xác nhận hết nhiệm vụ', tone: 'warning' }]
])

function knownCounts(counts) {
    return counts && countKeys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ? counts : null
}

function result(code, summary, counts) {
    return { code, ...presentations.get(code), summary, counts }
}

/** A finished process is not proof that its tasks completed successfully. */
export function describeAccountTaskResult(account) {
    if (!account?.status) return null
    const counts = knownCounts(account.completion?.counts)
    const reason = account.error || account.completion?.accountReason
    if (['running', 'starting', 'stopping', 'pending'].includes(account.status) || account.done === false) {
        return result('running', 'Đang kiểm tra và thực hiện các nhiệm vụ được bật.', counts)
    }
    if (['cancelled', 'interrupted', 'failed'].includes(account.status)) {
        return result(account.status, reason || 'Lượt chạy kết thúc trước khi xác nhận hết nhiệm vụ.', counts)
    }
    if (account.status === 'completed' && account.success !== false && counts && counts.incomplete === 0 && !reason) {
        return result(
            'done',
            `Đã xử lý xong các nhiệm vụ được bật trong lượt này. ${counts.completed} hoàn tất · ${counts.unavailable} không khả dụng · ${counts.notApplicable} không áp dụng.`,
            counts
        )
    }
    if (account.status === 'partial' || account.success === false || reason || counts?.incomplete > 0) {
        const pending =
            counts?.incomplete > 0
                ? `${counts.incomplete} nhiệm vụ chưa hoàn tất hoặc chưa xác minh.`
                : 'Lượt chạy còn lỗi hoặc thiếu dữ liệu xác nhận.'
        return result(
            'partial',
            `${pending}${reason ? ` ${String(reason).slice(0, 600)}` : ' Bấm Chi tiết để xem các mục còn lại.'}`,
            counts
        )
    }
    return result('unverified', 'Lượt chạy đã kết thúc nhưng chưa có đủ dữ liệu để xác nhận hết nhiệm vụ.', counts)
}

export function describeRunTaskResult(run) {
    if (!run || run.operation !== 'rewards') return null
    const accounts = run.accounts ?? []
    const results = accounts.map(describeAccountTaskResult)
    const totalAccounts = run.accountsTotal ?? accounts.length
    const completedAccounts = results.filter(item => item?.code === 'done').length
    const counts = knownCounts(run.completion?.activities)
    let outcome
    if (run.active || ['running', 'starting', 'stopping'].includes(run.status)) {
        outcome = result(
            'running',
            `${completedAccounts} / ${totalAccounts} tài khoản đã DONE. Các tài khoản còn lại đang tiếp tục xử lý.`,
            counts
        )
    } else if (['cancelled', 'interrupted', 'failed'].includes(run.status)) {
        outcome = result(run.status, 'Lượt chạy đã dừng. Xem Chi tiết từng tài khoản để biết nhiệm vụ còn lại.', counts)
    } else if (
        run.status === 'completed' &&
        run.executionComplete === true &&
        run.completion?.detailsKnown === true &&
        counts?.incomplete === 0 &&
        totalAccounts > 0 &&
        results.length === totalAccounts &&
        completedAccounts === totalAccounts
    ) {
        outcome = result(
            'done',
            `${completedAccounts} / ${totalAccounts} tài khoản đã hoàn tất các nhiệm vụ được bật trong lượt này. ${counts.completed} hoàn tất · ${counts.unavailable} không khả dụng · ${counts.notApplicable} không áp dụng.`,
            counts
        )
    } else if (
        run.status === 'partial' ||
        counts?.incomplete > 0 ||
        results.some(item => item && ['partial', 'failed', 'cancelled', 'interrupted'].includes(item.code))
    ) {
        outcome = result(
            'partial',
            `${completedAccounts} / ${totalAccounts} tài khoản đã DONE${counts?.incomplete > 0 ? ` · ${counts.incomplete} nhiệm vụ chưa hoàn tất hoặc chưa xác minh` : ''}. Bấm Chi tiết ở từng tài khoản để xem mục còn lại.`,
            counts
        )
    } else {
        outcome = result('unverified', 'Chưa đủ dữ liệu kết quả của tất cả tài khoản để xác nhận hết nhiệm vụ.', counts)
    }
    return { ...outcome, runId: run.runId ?? null, endedAt: run.endedAt ?? null, completedAccounts, totalAccounts }
}

/** Also lets updated dashboard assets display results from an already-running API. */
export function attachDashboardTaskResults(snapshot, history) {
    const { status } = snapshot
    const resultRun =
        status.operation === 'rewards' && status.run.runId
            ? {
                  ...status.run,
                  active: status.state !== 'idle',
                  status: status.state === 'idle' ? (status.lastExit?.status ?? status.run.status) : status.run.status,
                  executionComplete: status.state === 'idle' && status.lastExit?.executionComplete === true,
                  endedAt: status.state === 'idle' ? status.lastExit?.at : null
              }
            : status.state === 'idle'
              ? history.find(run => run.operation === 'rewards')
              : null
    const previousAccounts = history.filter(run => run.operation === 'rewards').flatMap(run => run.accounts)
    return {
        ...snapshot,
        taskResult: describeRunTaskResult(resultRun),
        accounts: snapshot.accounts.map(account => ({
            ...account,
            taskResult: describeAccountTaskResult(
                account.live ?? previousAccounts.find(item => item.email.toLowerCase() === account.email.toLowerCase())
            )
        })),
        history: snapshot.history.map(run => ({
            ...run,
            taskResult: describeRunTaskResult(history.find(item => item.runId === run.runId) ?? run)
        }))
    }
}
