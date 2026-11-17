#!/usr/bin/env node
/** 内部标记剥离测试：system-reminder / DSML / 工具调用 XML 不能出现在出站正文。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const profile = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const file = path.join(profile, 'node_modules', 'dsh-fish-soul', 'lib', 'internal-markup.js')
if (!fs.existsSync(file)) { console.log(`SKIP  not found: ${file}`); process.exit(0) }
const { stripInternalMarkup } = await import(pathToFileURL(file).href)

const sample = `一个多小时没声了。

忙什么呢。

别又熬到头。

<system-reminder>
The following information describes a previous assistant turn that may have been interrupted before any reply was delivered. Do not repeat work that is already done. Continue from the last confirmed state.
The user has not sent anything new. Continue any in-progress work and provide the user's requested response if it has not been delivered.</system-reminder>
</||DSML|| parameter>
</||DSML|| invoke>
</||DSML|| calls>`
assert.equal(stripInternalMarkup(sample), '一个多小时没声了。\n\n忙什么呢。\n\n别又熬到头。')

assert.equal(stripInternalMarkup('好。\n<system-reminder>内部</system-reminder>\n</｜｜DSML｜｜ parameter>\n收尾'), '好。\n\n收尾')
assert.equal(stripInternalMarkup('只有内部\n<system-reminder>不要发</system-reminder>'), '只有内部')
assert.equal(stripInternalMarkup('<system-reminder>No closing tag'), '')
assert.equal(stripInternalMarkup('正常一句话，没有标记。'), '正常一句话，没有标记。')
console.log('PASS  internal markup stripping')
