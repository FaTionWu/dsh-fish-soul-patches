/**
 * 搜索重试：网络层失败（fetch failed）或服务端 5xx 时再试一次。
 *
 * 只用于 fish_search 这种“搜一下”的调用；4xx（key 错、参数错、被拒）不重试，
 * 外部 signal 已取消时也不重试，避免用户已经离开还继续等。
 */
export function isRetryableSearchError(error) {
	const msg = String(error?.message ?? error ?? '');
	return /fetch failed|返回\s*5\d\d|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg);
}

export async function withSearchRetry(run, { signal, attempts = 2, delayMs = 500 } = {}) {
	const total = Math.max(1, Math.floor(Number(attempts) || 1));
	let last;
	for (let i = 0; i < total; i += 1) {
		try {
			return await run();
		} catch (error) {
			last = error;
			if (i >= total - 1 || signal?.aborted === true || !isRetryableSearchError(error)) throw error;
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	throw last;
}
