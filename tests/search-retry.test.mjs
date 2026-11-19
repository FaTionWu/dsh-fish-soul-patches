#!/usr/bin/env node
/** fish_search 网络失败重试测试：fetch failed / 5xx 重试一次；4xx 和外部取消不重试。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const profile = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const file = path.join(profile, 'node_modules', 'dsh-fish-soul', 'lib', 'search-retry.js')
if (!fs.existsSync(file)) { console.log(`SKIP  not found: ${file}`); process.exit(0) }
const { withSearchRetry, isRetryableSearchError } = await import(pathToFileURL(file).href)

const err = (msg) => new Error(msg)

// 1) 第一次 fetch failed，第二次成功
{
	let calls = 0
	const value = await withSearchRetry(async () => {
		calls += 1
		if (calls === 1) throw err('fetch failed')
		return 'ok'
	}, { delayMs: 0 })
	assert.equal(value, 'ok')
	assert.equal(calls, 2)
}

// 2) 5xx 也重试；一直失败时抛最后一次
{
	let calls = 0
	await assert.rejects(
		withSearchRetry(async () => { calls += 1; throw err('Tavily 返回 502：bad gateway') }, { delayMs: 0 }),
		/502/
	)
	assert.equal(calls, 2)
}

// 3) 4xx 不重试
{
	let calls = 0
	await assert.rejects(
		withSearchRetry(async () => { calls += 1; throw err('Tavily 返回 401：unauthorized') }, { delayMs: 0 }),
		/401/
	)
	assert.equal(calls, 1)
}

// 4) 外部 signal 已取消：不重试
{
	let calls = 0
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		withSearchRetry(async () => { calls += 1; throw err('fetch failed') }, { signal: controller.signal, delayMs: 0 }),
		/fetch failed/
	)
	assert.equal(calls, 1)
}

// 5) 一次成功不重试
{
	let calls = 0
	const value = await withSearchRetry(async () => { calls += 1; return 42 }, { delayMs: 0 })
	assert.equal(value, 42)
	assert.equal(calls, 1)
}

// 6) 分类函数
assert.equal(isRetryableSearchError(err('fetch failed')), true)
assert.equal(isRetryableSearchError(err('Tavily 返回 503：x')), true)
assert.equal(isRetryableSearchError(err('ECONNRESET')), true)
assert.equal(isRetryableSearchError(err('Tavily 返回 400：bad request')), false)
assert.equal(isRetryableSearchError(err('博查：401')), false)
console.log('PASS  fish_search retry')
