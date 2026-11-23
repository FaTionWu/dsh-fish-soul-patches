#!/usr/bin/env node
/** Content Exists Risk 识别与会话自愈通知。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const profile = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const file = path.join(profile, 'node_modules', 'dsh-fish-soul', 'lib', 'content-risk.js')
if (!fs.existsSync(file)) { console.log(`SKIP  not found: ${file}`); process.exit(0) }
const { isContentRiskReason, CONTENT_RISK_SESSION_KEY, CONTENT_RISK_NOTICE } = await import(pathToFileURL(file).href)

assert.equal(isContentRiskReason({ kind: 'error', error: new Error('Content Exists Risk (request_id: x)') }), true)
assert.equal(isContentRiskReason({ kind: 'error', error: { code: 'INVALID_REQUEST', message: 'Content Exists Risk' } }), true)
assert.equal(isContentRiskReason({ kind: 'error', error: { code: 'INVALID_REQUEST', message: 'Content Exists Risk (request_id: af58)' } }), true)
assert.equal(isContentRiskReason({ kind: 'error', error: new Error('context window exceeded') }), false)
assert.equal(isContentRiskReason({ kind: 'error', error: new Error('rate limited') }), false)
assert.equal(isContentRiskReason({ kind: 'completed' }), false)
assert.equal(isContentRiskReason(null), false)
assert.equal(CONTENT_RISK_SESSION_KEY, 'session.contentRisk')
assert.ok(CONTENT_RISK_NOTICE.includes('内容风控'))
console.log('PASS  content-risk classifier')
