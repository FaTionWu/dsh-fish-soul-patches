// 给 profile 里的 dsh-fish-soul 重打本地补丁（插件升级后重跑一次：node patch-fish-soul.mjs）
//  1) lib/persona.js  —— 「话说完了就停」换成允许追问、没说完接着讲的版本（追问要贴着刚聊的事）
//  2) lib/gateway.js  —— 首条回复前按字数加 0.6~3s 真人延迟
//  3) lib/gateway.js  —— 私聊「对方没回音」：3~9 分钟随机追一次；第一次是追问不是收尾时，
//                        4 分钟后按 30% 再掷一次（二次追/收尾），最多两次
//  4) lib/gateway.js  —— 模型把回复全写进「思考」、正文留空时，从思考里把要说的话捞回来
//  5) lib/index.js    —— QQ 回复规则里补一句「正文里必须写出要发的话」
//  6) lib/safe-download.js —— 放行本地代理 fake-IP 段（198.18.0.0/15），否则 QQ 图片/CDN
//                              被代理映射到该段时会被当成保留地址拒绝下载（图进不了模型）
//  7) lib/x-topics.js + db/index/schema/websearch —— 「每天从 X / 权威新闻攒几条话题」：
//     不碰 X API，走已配好的联网搜索（x.com 帖子 + Tavily news），按预算节流
// 说明与参数见 fish-soul-patch/README.md；提示 PATTERN NOT FOUND / 锚点找不到：作者改过对应原文，需要人工确认（别硬覆盖）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applySearchMode } from './fish-soul-patch/search-mode-patch.mjs'
import { applyContentRisk } from './fish-soul-patch/content-risk-patch.mjs'
import { applyReplyPreserve } from './fish-soul-patch/reply-preserve-patch.mjs'

// 测试钩子：写入 N 个文件后 SIGKILL 自己，用来验证 wrapper 的崩溃恢复。
const crashAfterWrites = Number(process.env.FS_PATCH_CRASH_AFTER || 0)
if (crashAfterWrites > 0) {
  const originalWrite = fs.writeFileSync.bind(fs)
  let writes = 0
  fs.writeFileSync = (...args) => {
    const r = originalWrite(...args)
    writes += 1
    if (writes >= crashAfterWrites) process.kill(process.pid, 'SIGKILL')
    return r
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const patchDir = path.join(here, 'fish-soul-patch')
const profileDir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const lib = path.join(profileDir, 'node_modules', 'dsh-fish-soul', 'lib')
let failed = false
const out = (line) => console.log(line)

function patch(file, from, to, label) {
	if (!fs.existsSync(file)) { out(`[!!] ${label}: 文件不存在（插件没装？）`); failed = true; return }
	const text = fs.readFileSync(file, 'utf8')
	if (text.includes(to)) { out(`[ok] ${label}: 已经是补丁后的内容`); return }
	if (!text.includes(from)) { out(`[!!] ${label}: 找不到原句，插件可能改过这段，需要人工确认`); failed = true; return }
	fs.writeFileSync(file, text.replace(from, to), 'utf8')
	out(`[done] ${label}: 已打补丁`)
}

// ── 1) 追问/连续 ────────────────────────────────────────────────────────
const personaOld =
	"'被问心里怎么想，一次只说一点，剩下的以后再说。你只知道对方说过的和你看到的，可以猜错、会错意。话说完了就停，不用每条结尾都递个问题，也别用「对了」硬找话；词穷、说不清楚也正常。';"
const personaNew =
	"'被问心里怎么想，可以一次只说一点，但没说完的下一条接着讲，别把话掐断。你只知道对方说过的和你看到的，可以猜错、会错意。' +\n" +
	"\t'对方的话含含糊糊、明显没讲完、或者主动递了话头（比如「今天遇到点事」「你猜怎么着」）的时候，就顺着追问一句——问你真的想知道、又跟刚聊的那件具体事有关的细节（别泛泛问「在吗」「然后呢」），一轮最多问一次，别盘问、别查户口；对方已经说清楚、或者明显不想聊了，就收住，别硬找问题。想说的没说完，就在这一轮里空一行接着写完（会拆成几条连发），别写半截停住等对方回话，也别写成「我跟你说…」然后等他问。一个话题自然聊完时，顺着刚才聊的那件具体事反问一句（问他的看法、细节或打算），让话有下一句；没有可接的点就正常收住。词穷、说不清楚也正常。';"
patch(path.join(lib, 'persona.js'), personaOld, personaNew, 'persona.js（追问/连续）')

// ── 2) 首条延迟 ────────────────────────────────────────────────────────
patch(
	path.join(lib, 'gateway.js'),
	'await this.sleep(this.firstDelay(profile));',
	"await this.sleep(this.firstDelay(profile) + Math.min(3000, typingDelayMs(paragraphs[0] ?? '', this.random)));",
	'gateway.js（首条延迟）'
)

// ── 3) 没回音追问（随机 3~9 分钟 + 二次追问）───────────────────────────
const gwFile = path.join(lib, 'gateway.js')
if (!fs.existsSync(gwFile)) {
	out('[!!] gateway.js: 文件不存在（插件没装？）')
	failed = true
} else {
	let gw = fs.readFileSync(gwFile, 'utf8')
	if (gw.includes('this.secondFollowUps = new Map();')) {
		out('[ok] gateway.js（没回音追问）: 已经是补丁后的内容')
	} else {
		const methodsFile = path.join(patchDir, 'followup-methods.txt')
		const armFile = path.join(patchDir, 'sendreply-arm.txt')
		if (!fs.existsSync(methodsFile) || !fs.existsSync(armFile)) {
			out('[!!] gateway.js（没回音追问）: 缺少补丁数据文件 fish-soul-patch/*.txt')
			failed = true
		} else {
			let ok = true
			const ins = (re, add, label) => { if (!re.test(gw)) { ok = false; out(`[!!] gateway.js（没回音追问）: 找不到锚点 ${label}`); return } gw = gw.replace(re, (m) => m + add) }
			const before = (re, add, label) => { if (!re.test(gw)) { ok = false; out(`[!!] gateway.js（没回音追问）: 找不到锚点 ${label}`); return } gw = gw.replace(re, (m) => add + m) }

			ins(
				/\n[ \t]*this\.follow = new Map\(\);\n/,
				'\t\t/** channelId → {epoch, timer}（私聊发完回复后等对方回话；到点没动静就追问/收尾一次） */\n\t\tthis.followUps = new Map();\n\t\t/** channelId → {epoch, timer}（第一次是「追问」不是「收尾」时，secondMinutes 后按 secondChance 再掷一次） */\n\t\tthis.secondFollowUps = new Map();\n\t\t/** channelId → {stage}（刚发出去的 proactive 是第几次追问，用于决定要不要挂二次） */\n\t\tthis.followupSends = new Map();\n\t\t/** channelId → {epoch, timer}（说完就停时，隔几秒自动接一句） */\n\t\tthis.autoContinues = new Map();\n\t\t/** channelId → 上次自动接话的物理时间（冷却用） */\n\t\tthis.lastAutoContinue = new Map();\n',
				'构造函数 followUps'
			)
			ins(
				/for \(const b of this\.batches\.values\(\)\) clearTimeout\(b\.timer\);\n[ \t]*this\.batches\.clear\(\);\n/,
				'\t\tfor (const cur of this.followUps?.values() ?? []) clearTimeout(cur.timer);\n\t\tthis.followUps?.clear();\n\t\tfor (const cur of this.secondFollowUps?.values() ?? []) clearTimeout(cur.timer);\n\t\tthis.secondFollowUps?.clear();\n\t\tthis.followupSends?.clear();\n\t\tfor (const cur of this.autoContinues?.values() ?? []) clearTimeout(cur.timer);\n\t\tthis.autoContinues?.clear();\n\t\tthis.lastAutoContinue?.clear();\n',
				'stop() 清理'
			)
			ins(
				/async dispatch\(channelId, items(?:, opts = \{\})?\) \{\n[ \t]*if \(this\.stopped \|\| items\.length === 0\) return;\n/,
				'\t\t// 对方开口了：撤掉还没到点的「没回音」追问/收尾\n\t\tthis.cancelFollowUp(channelId);\n',
				'dispatch 撤销'
			)
			before(
				/\n[ \t]*if \(isGroup\) \{\n[ \t]*this\.lastSpoke\.set\(row\.channel_id, Date\.now\(\)\);\n/,
				fs.readFileSync(armFile, 'utf8'),
				'sendReply 挂计时器'
			)
			before(
				/\n[ \t]*\/\*\* 把一轮的最终回复发回 QQ：[^\n]*\*\/\n[ \t]*async sendReply/,
				'\n' + fs.readFileSync(methodsFile, 'utf8'),
				'追问方法'
			)
			// 自动接话需要 triggerProactive 支持自定义提示（meta.prompt）
			if (ok) {
				const promptRe = /text: `【主动开口】\$\{this\.soul\.nowLabel\(\)\}，你想主动找\$\{kind === 'group' \? '群里的大家' : '对方'\}说话。` \+\n[ \t]*`理由：\$\{sanitizeUserText\(reason\)\}。直接写要发出去的那条消息，像平时聊天一样自然，` \+\n[ \t]*'别提"系统""提醒任务""主动开口"这些字眼。'/
				if (!promptRe.test(gw)) { ok = false; out('[!!] gateway.js（没回音追问）: 找不到接话自定义提示锚点') }
				else {
					gw = gw.replace(promptRe, () => [
						"text: typeof meta.prompt === 'string' && meta.prompt.trim() !== ''",
						"\t\t\t\t\t\t? meta.prompt",
						"\t\t\t\t\t\t: `【主动开口】${this.soul.nowLabel()}，你想主动找${kind === 'group' ? '群里的大家' : '对方'}说话。` +",
						"\t\t\t\t\t\t\t`理由：${sanitizeUserText(reason)}。直接写要发出去的那条消息，像平时聊天一样自然，` +",
						"\t\t\t\t\t\t\t'别提\"系统\"\"提醒任务\"\"主动开口\"这些字眼。'"
					].join('\n'))
				}
			}
			if (ok) { fs.writeFileSync(gwFile, gw, 'utf8'); out('[done] gateway.js（没回音追问）: 已打补丁') }
			else { out('[!!] gateway.js（没回音追问）: 有锚点没找到，未写入'); failed = true }
		}
	}
}

// ── 4) 思考兜底：模型把回复写进 reasoning、正文留空 ─────────────────────
if (fs.existsSync(gwFile)) {
	let gw = fs.readFileSync(gwFile, 'utf8')
	if (gw.includes('salvageReasoningOutput')) {
		out('[ok] gateway.js（思考兜底）: 已经是补丁后的内容')
	} else {
		let ok = true
		const rep = (re, fn, label) => { if (!re.test(gw)) { ok = false; out(`[!!] gateway.js（思考兜底）: 找不到锚点 ${label}`); return } gw = gw.replace(re, fn) }
		rep(
			/st = \{ text: '', images: \[\], fromUs: false, messageIds: \[\], replyTo: null, proactive: false, channelId: null, convId: '' \};/,
			(m) => m.replace("convId: '' };", "convId: '', reasoning: '' };"),
			'turnState 默认值'
		)
		rep(
			/const text = 提取正文\(d\.message\);\n[ \t]*const images = 提取图块\(d\.message\);\n[ \t]*if \(text !== ''\) \{ st\.text = text; st\.images = images; \} else if \(images\.length > 0\) st\.images = st\.images\.concat\(images\)\.slice\(0, 10\);\n/,
			() =>
				'const text = 提取正文(d.message);\n' +
				"\t\t\tconst images = 提取图块(d.message);\n" +
				"\t\t\t// 这模型偶尔把整条回复写进「思考」、正文留空（QQ 上表现成已读不回）：\n" +
				"\t\t\t// 思考也留着，出站时兜底用（见 sendReply / salvageReasoningOutput）。\n" +
				"\t\t\tconst reasoning = Array.isArray(d.message?.content)\n" +
				"\t\t\t\t? d.message.content.filter((p) => p?.type === 'reasoning' && typeof p.text === 'string').map((p) => p.text).join('\\n')\n" +
				"\t\t\t\t: '';\n" +
				"\t\t\tif (reasoning !== '') st.reasoning = reasoning;\n" +
				"\t\t\tif (text !== '') { st.text = text; st.images = images; } else if (images.length > 0) st.images = st.images.concat(images).slice(0, 10);\n",
			'assistant/message 处理器'
		)
		rep(
			/\t\tconst parsed = parseClosing\(collected\.text\);\n\t\tconst raw = parsed\.text;\n/,
			() =>
				'\t\tconst parsed = parseClosing(collected.text);\n' +
				"\t\tlet raw = parsed.text;\n" +
				"\t\t// 正文是空的、也没有图：这轮多半把话全写进思考了（deepseek-flash 在 QQ 上出现过），\n" +
				"\t\t// 从思考里的最后一次「输出」把那段话捞回来，别让用户看到已读不回。\n" +
				"\t\tif (raw.trim() === '' && (st.images ?? []).length === 0 && st?.reasoning) {\n" +
				"\t\t\tconst salvaged = salvageReasoningOutput(st.reasoning);\n" +
				"\t\t\tif (salvaged !== '') {\n" +
				"\t\t\t\tthis.note('reasoning-fallback', { channelId: row.channel_id, title: row.title, text: salvaged.slice(0, 80), reason: '正文为空，按思考里的最后输出兜底' });\n" +
				"\t\t\t\traw = salvaged;\n" +
				"\t\t\t}\n" +
				"\t\t}\n",
			'sendReply 正文兜底'
		)
		rep(
			/\t\tconst closing = parsed\.closing;\n/,
			() =>
				'\t\t// 收尾标记：兜底捞回来的正文也可能带着（模型把整条写进思考时会连标记一起写），\n' +
				"\t\t// 标准标记和全角/半角/〔〕等括号、带空格的写法都剥掉；有标记就算收尾。\n" +
				'\t\tconst closingScan = parseClosing(raw);\n' +
				'\t\tconst closing = parsed.closing || closingScan.closing || hasClosingMark(collected.text) || hasClosingMark(raw);\n' +
				'\t\traw = stripClosingMarks(closingScan.text);\n',
			'收尾标记剥除'
		)
		rep(
			/\t\tconst 净文字 = this\.cleanOut\(picked\.净文字, row\);\n/,
			() => '\t\tconst 净文字 = stripClosingMarks(this.cleanOut(picked.净文字, row));\n',
			'正文最后剥标记'
		)
		rep(
			/\nObject\.assign\(ChatGateway\.prototype, mediaMethods, behaviorMethods\);/,
			() =>
				'\n/**\n' +
				' * deepseek 偶尔把整条回复写进「思考」、正文留空（QQ 上表现成已读不回）。\n' +
				" * 从思考里最后一次「输出 / 答案 / 回复」后面把那段话捞回来；捞不到就返回 ''。\n" +
				' */\n' +
				'function salvageReasoningOutput(reasoning) {\n' +
				"\tconst s = String(reasoning ?? '');\n" +
				'\tlet idx = -1;\n' +
				"\tfor (const key of ['输出', '答案', '回复']) idx = Math.max(idx, s.lastIndexOf(key));\n" +
				"\tif (idx < 0) return '';\n" +
				"\tlet body = s.slice(idx).replace(/^(输出|答案|回复)[。:：\\-—\\s]*/u, '').trim();\n" +
				"\tbody = body.replace(/^[\"'“”‘’\\s]+|[\"'“”‘’\\s]+$/gu, '').trim();\n" +
				"\tif (body.length < 1 || body.length > 600) return '';\n" +
				"\tif (/^检查/u.test(body)) return '';\n" +
				'\treturn body;\n' +
				'}\n\n' +
				'/**\n' +
				' * 把各种写法的收尾标记都剥掉：模型偶尔写成全角/半角方括号、圆括号、〔〕等，\n' +
				' * 或者中间带空格、单独占一行。标准写法【收尾】由 parseClosing 处理，这里兜住变体。\n' +
				' */\n' +
				'function stripClosingMarks(text) {\n' +
				"\treturn String(text ?? '')\n" +
				"\t\t.replace(/[【［\\[（(〔〈《﹝{「『]\\s*收\\s*尾\\s*[】］\\]）)〕〉》﹞}」』]/gu, '')\n" +
				"\t\t.replace(/^[ \\t]*收\\s*尾[ \\t]*$/gmu, '')\n" +
				"\t\t.replace(/[\\u200b\\u200c\\u200d\\ufeff]/gu, '')\n" +
				'\t\t.replace(/\\n{3,}/g, \'\\n\\n\')\n' +
				'\t\t.trim();\n' +
				'}\n\n' +
				'/** 有没有收尾标记（各种括号写法都算）。 */\n' +
				'function hasClosingMark(text) {\n' +
				"\treturn /[【［\\[（(〔〈《﹝{「『]\\s*收\\s*尾\\s*[】］\\]）)〕〉》﹞}」』]/u.test(String(text ?? ''));\n" +
				'}\n\n' +
				'Object.assign(ChatGateway.prototype, mediaMethods, behaviorMethods);',
			'salvageReasoningOutput 函数'
		)
		if (ok) { fs.writeFileSync(gwFile, gw, 'utf8'); out('[done] gateway.js（思考兜底）: 已打补丁') }
		else { out('[!!] gateway.js（思考兜底）: 有锚点没找到，未写入'); failed = true }
	}
}

// ── 5) QQ 回复规则：正文里必须写出要发的话 ──────────────────────────────
const idxFile = path.join(lib, 'index.js')
if (!fs.existsSync(idxFile)) {
	out('[!!] index.js: 文件不存在（插件没装？）')
	failed = true
} else {
	const idx = fs.readFileSync(idxFile, 'utf8')
	if (idx.includes('[接着说]')) {
		out('[ok] index.js（正文规则）: 已经是补丁后的内容')
	} else {
		const re = /\n([ \t]*)lines\.push\(\.\.\.voiceLines\(\{ v: voiceConfig/
		if (!re.test(idx)) { out('[!!] index.js（正文规则）: 找不到锚点'); failed = true }
		else {
			fs.writeFileSync(idxFile, idx.replace(re, "\n$1lines.push('[正文] 把真正要发出去的话写在回复正文里，不要只写在思考里；只写思考等于这轮没回。');\n$1lines.push('[接着说] 这一轮想说的没说完，就空一行接着写完（会拆成几条连发）；不要写半截停住等对方回话，也别写成「我跟你说…」然后等他问。一个话题自然聊完时，顺着刚才那件具体事反问/追问一句，让话有下一句；对方明显不想聊了才收住。');$&"), 'utf8')
			out('[done] index.js（正文规则）: 已打补丁')
		}
	}
}

// ── 6) safe-download：放行本地代理 fake-IP 段（198.18.0.0/15）──────────
const sdFile = path.join(lib, 'safe-download.js')
if (!fs.existsSync(sdFile)) {
	out('[!!] safe-download.js: 文件不存在（插件没装？）')
	failed = true
} else {
	let sd = fs.readFileSync(sdFile, 'utf8')
	if (sd.includes('(a === 198 && b === 51 && c === 100)')) {
		out('[ok] safe-download.js（fake-IP 放行）: 已经是补丁后的内容')
	} else {
		const from = '  (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||'
		if (!sd.includes(from)) { out('[!!] safe-download.js（fake-IP 放行）: 找不到锚点'); failed = true }
		else {
			sd = sd.replace(from, '  // 198.18.0.0/15 是本地代理（Clash 等 fake-IP 模式）把公网域名映射成的保留段：\n  // 连接它实际由代理转发到真实主机，不是内网。QQ 图片/CDN 常被映射到这里，\n  // 一律拒绝会让「图片下载失败」看起来像模型不支持多模态。\n  (a === 198 && b === 51 && c === 100) ||')
			fs.writeFileSync(sdFile, sd, 'utf8')
			out('[done] safe-download.js（fake-IP 放行）: 已打补丁')
		}
	}
}

// ── 7) X 话题：每天从 X / 权威新闻攒几条（不走 X API）──────────────────
{
	const xtFile = path.join(lib, 'x-topics.js')
	const xtData = path.join(patchDir, 'x-topics.js')
	if (!fs.existsSync(xtData)) { out('[!!] x-topics.js: 缺少补丁数据文件 fish-soul-patch/x-topics.js'); failed = true }
	else {
		const want = fs.readFileSync(xtData, 'utf8')
		if (fs.existsSync(xtFile) && fs.readFileSync(xtFile, 'utf8') === want) out('[ok] x-topics.js: 已经是补丁后的内容')
		else { fs.writeFileSync(xtFile, want, 'utf8'); out('[done] x-topics.js: 已放入') }
	}

	// db.js：x_topic 表
	const dbFile = path.join(lib, 'db.js')
	let dbText = fs.readFileSync(dbFile, 'utf8')
	if (dbText.includes('CREATE TABLE IF NOT EXISTS x_topic')) out('[ok] db.js（x_topic 表）: 已经是补丁后的内容')
	else {
		const m = dbText.match(/CREATE TABLE IF NOT EXISTS douyin_seen \([\s\S]*?\n\);/)
		if (m === null) { out('[!!] db.js（x_topic 表）: 找不到 douyin_seen 锚点'); failed = true }
		else {
			dbText = dbText.replace(m[0], m[0] + '\n\n' + fs.readFileSync(path.join(patchDir, 'xtopics-db.txt'), 'utf8').trim())
			fs.writeFileSync(dbFile, dbText, 'utf8')
			out('[done] db.js（x_topic 表）: 已打补丁')
		}
	}

	// config-schema.js：xTopics 配置块
	const schemaFile = path.join(lib, 'config-schema.js')
	let schemaText = fs.readFileSync(schemaFile, 'utf8')
	if (schemaText.includes('xTopics: z.object')) out('[ok] config-schema.js（xTopics）: 已经是补丁后的内容')
	else {
		const anchor = '\t\tproactive: z.object({'
		const block = fs.readFileSync(path.join(patchDir, 'xtopics-schema.txt'), 'utf8')
		if (!schemaText.includes(anchor)) { out('[!!] config-schema.js（xTopics）: 找不到 proactive 锚点'); failed = true }
		else {
			schemaText = schemaText.replace(anchor, block + anchor)
			fs.writeFileSync(schemaFile, schemaText, 'utf8')
			out('[done] config-schema.js（xTopics）: 已打补丁')
		}
	}

	// index.js：import / 搜索函数 + 实例 / 启动 / 上下文
	const idxFile2 = path.join(lib, 'index.js')
	let idxText = fs.readFileSync(idxFile2, 'utf8')
	if (idxText.includes('new XTopics(')) out('[ok] index.js（x-topics）: 已经是补丁后的内容')
	else {
		let ok7 = true
		const imp = "import { DouyinHttp } from './douyin-http.js';"
		if (!idxText.includes(imp)) { ok7 = false; out('[!!] index.js（x-topics）: 找不到 DouyinHttp import') }
		else idxText = idxText.replace(imp, imp + "\nimport { XTopics } from './x-topics.js';")

		const runRe = /\tasync function runWebSearch\(query, \{ signal, count \} = \{\}\) \{\n[\s\S]*?\n\t\}/
		if (!runRe.test(idxText)) { ok7 = false; out('[!!] index.js（x-topics）: 找不到 runWebSearch') }
		else idxText = idxText.replace(runRe, fs.readFileSync(path.join(patchDir, 'xtopics-runwebsearch.txt'), 'utf8').trimEnd())

		const startAnchor = "\tctx.effect(() => () => { douyin.stop(); douyinHost.dispose(); }, 'dsh-fish-soul: douyin channel');"
		if (!idxText.includes(startAnchor)) { ok7 = false; out('[!!] index.js（x-topics）: 找不到 douyin start') }
		else idxText = idxText.replace(startAnchor, startAnchor + '\n' + fs.readFileSync(path.join(patchDir, 'xtopics-start-extra.txt'), 'utf8').trimEnd())

		const ctxAnchor = "\n\t\tif (persona.postHistory !== '') lines.push(applyMacros"
		if (!idxText.includes(ctxAnchor)) { ok7 = false; out('[!!] index.js（x-topics）: 找不到 postHistory 上下文锚点') }
		else idxText = idxText.replace(ctxAnchor, '\n' + fs.readFileSync(path.join(patchDir, 'xtopics-context.txt'), 'utf8').trimEnd() + ctxAnchor)

		if (ok7) { fs.writeFileSync(idxFile2, idxText, 'utf8'); out('[done] index.js（x-topics）: 已打补丁') }
		else { out('[!!] index.js（x-topics）: 有锚点没找到，未写入'); failed = true }
	}

	// websearch.js：Tavily news 参数 + 保留完整日期
	const wsFile = path.join(lib, 'websearch.js')
	let wsText = fs.readFileSync(wsFile, 'utf8')
	if (wsText.includes('topic ? { topic }')) out('[ok] websearch.js（news 参数）: 已经是补丁后的内容')
	else {
		const a1 = 'export async function webSearch(cfg, query, { fetchImpl = globalThis.fetch, signal, count = 6 } = {}) {'
		const b1 = 'export async function webSearch(cfg, query, { fetchImpl = globalThis.fetch, signal, count = 6, topic = \'\', days = 0, includeDomains = [], excludeDomains = [] } = {}) {'
		const a2 = 'body: JSON.stringify({ query: q, max_results: n, include_answer: true })'
		const b2 = 'body: JSON.stringify({ query: q, max_results: n, include_answer: true, ...(topic ? { topic } : {}), ...(days > 0 ? { days } : {}), ...(Array.isArray(includeDomains) && includeDomains.length > 0 ? { include_domains: includeDomains } : {}), ...(Array.isArray(excludeDomains) && excludeDomains.length > 0 ? { exclude_domains: excludeDomains } : {}) })'
		const a3 = "date: String(r.date ?? '').slice(0, 10)"
		const b3 = "date: String(r.date ?? '').slice(0, 40)"
		if (!wsText.includes(a1) || !wsText.includes(a2) || !wsText.includes(a3)) { out('[!!] websearch.js（news 参数）: 找不到锚点'); failed = true }
		else {
			wsText = wsText.replace(a1, b1).replace(a2, b2).replace(a3, b3)
			fs.writeFileSync(wsFile, wsText, 'utf8')
			out('[done] websearch.js（news 参数）: 已打补丁')
		}
	}
}

// ── 8) 设置页 UI：连续对话 + X 话题（含 followup schema / 路由）─────────
{
	const schemaFile2 = path.join(lib, 'config-schema.js')
	let st = fs.readFileSync(schemaFile2, 'utf8')
	if (!st.includes('followup: z.object')) {
		const anchor = '\t\tqq: z.object({'
		if (!st.includes(anchor)) { out('[!!] config-schema.js（followup）: 找不到 qq 锚点'); failed = true }
		else {
			st = st.replace(anchor, fs.readFileSync(path.join(patchDir, 'followup-schema.txt'), 'utf8') + anchor)
			fs.writeFileSync(schemaFile2, st, 'utf8')
			out('[done] config-schema.js（followup）: 已打补丁')
		}
	} else out('[ok] config-schema.js（followup）: 已经是补丁后的内容')

	const routesFile = path.join(lib, 'routes.js')
	let rt = fs.readFileSync(routesFile, 'utf8')
	if (!rt.includes("'/patches'")) {
		const depA = 'const { db, clock, embedder, worker, life, getConfig, saveConfig, log, gateway, channel, bili, biliClient, browser, biliSocial } = deps;'
		const depB = 'const { db, clock, embedder, worker, life, getConfig, saveConfig, log, gateway, channel, bili, biliClient, browser, biliSocial, xTopics } = deps;'
		const anchor = "\t\t\t\tif (method === 'POST' && path === '/channels/qq-config') {"
		let ok8 = true
		if (!rt.includes(depA)) { ok8 = false; out('[!!] routes.js（patches）: 找不到 deps 行') } else rt = rt.replace(depA, depB)
		if (!rt.includes(anchor)) { ok8 = false; out('[!!] routes.js（patches）: 找不到 qq-config 锚点') } else rt = rt.replace(anchor, fs.readFileSync(path.join(patchDir, 'routes-patches.txt'), 'utf8') + anchor)
		if (ok8) { fs.writeFileSync(routesFile, rt, 'utf8'); out('[done] routes.js（patches）: 已打补丁') } else failed = true
	} else out('[ok] routes.js（patches）: 已经是补丁后的内容')

	const idxFile3 = path.join(lib, 'index.js')
	let it = fs.readFileSync(idxFile3, 'utf8')
	if (!it.includes('douyinSocial, xTopics,')) {
		const depLine = 'db, clock, embedder, embeddingCfg, worker, life, getConfig, saveConfig, log, gateway, channel, bili, biliClient, browser, biliSocial, douyinSocial,'
		if (!it.includes(depLine)) { out('[!!] index.js（patches deps）: 找不到 registerRoutes deps'); failed = true }
		else { it = it.replace(depLine, depLine.replace('douyinSocial,', 'douyinSocial, xTopics,')); fs.writeFileSync(idxFile3, it, 'utf8'); out('[done] index.js（patches deps）: 已打补丁') }
	} else out('[ok] index.js（patches deps）: 已经是补丁后的内容')

	const clientFile = path.join(lib, 'client.js')
	let ct = fs.readFileSync(clientFile, 'utf8')
	if (ct.includes('function ContinuityPane')) out('[ok] client.js（连续对话 UI）: 已经是补丁后的内容')
	else {
		const endAnchor = 'Button({ key: "b", variant: "ghost", disabled: busy, onClick: () => pause(c) }, c.paused ? "恢复" : "暂停")] }))) : null));'
		const endNew = 'Button({ key: "b", variant: "ghost", disabled: busy, onClick: () => pause(c) }, c.paused ? "恢复" : "暂停")] }))) : null), h(ContinuityPane, { api, notify }));'
		const compAnchor = '\n\n\t\t/**\n\t\t * B站设置页'
		let ok8c = true
		if (!ct.includes(endAnchor)) { ok8c = false; out('[!!] client.js（连续对话 UI）: 找不到 ChannelPane 结尾') } else ct = ct.replace(endAnchor, endNew)
		if (!ct.includes(compAnchor)) { ok8c = false; out('[!!] client.js（连续对话 UI）: 找不到 B站 锚点') } else ct = ct.replace(compAnchor, '\n' + fs.readFileSync(path.join(patchDir, 'client-continuity.txt'), 'utf8').trimEnd() + compAnchor)
		if (ok8c) { fs.writeFileSync(clientFile, ct, 'utf8'); out('[done] client.js（连续对话 UI）: 已打补丁') } else failed = true
	}

	const modelsFile2 = path.join(lib, 'client.models.js')
	let mt = fs.readFileSync(modelsFile2, 'utf8')
	if (mt.includes('function XTopicsPane')) out('[ok] client.models.js（X 话题 UI）: 已经是补丁后的内容')
	else {
		const compAnchor2 = '\t\t/** 上网查：DSH 自带的 web_search'
		const startAnchor = '\t\t\treturn Group({ title: "上网查" },'
		const endAnchor2 = 'w.enabled ? Row({ title: "每天最多" }, Num({ min: 0, max: 500, value: perDay, "aria-label": "每天最多", onChange: (e) => setPerDay(e.target.value), onBlur: () => save({}) }), Muted("次")) : null);'
		let ok8m = true
		if (!mt.includes(compAnchor2)) { ok8m = false; out('[!!] client.models.js（X 话题 UI）: 找不到 Web 锚点') } else mt = mt.replace(compAnchor2, fs.readFileSync(path.join(patchDir, 'client-models-xtopics.txt'), 'utf8') + compAnchor2)
		if (!mt.includes(startAnchor)) { ok8m = false; out('[!!] client.models.js（X 话题 UI）: 找不到 return Group 锚点') } else mt = mt.replace(startAnchor, '\t\t\treturn h(react.Fragment, null, Group({ title: "上网查" },')
		if (!mt.includes(endAnchor2)) { ok8m = false; out('[!!] client.models.js（X 话题 UI）: 找不到每天最多锚点') } else mt = mt.replace(endAnchor2, endAnchor2.replace(' : null);', ' : null), h(XTopicsPane, { api, notify, ui }));'))
		if (ok8m) { fs.writeFileSync(modelsFile2, mt, 'utf8'); out('[done] client.models.js（X 话题 UI）: 已打补丁') } else failed = true
	}
}
// ── 9) 出站剥离内部标记（system-reminder / DSML）──────────────────────
{
    const imFile = path.join(lib, 'internal-markup.js')
    const imData = path.join(patchDir, 'internal-markup.js')
    if (!fs.existsSync(imData)) { out('[!!] internal-markup.js: 缺少补丁数据文件'); failed = true }
    else {
        const want = fs.readFileSync(imData, 'utf8')
        if (fs.existsSync(imFile) && fs.readFileSync(imFile, 'utf8') === want) out('[ok] internal-markup.js: 已经是补丁后的内容')
        else { fs.writeFileSync(imFile, want, 'utf8'); out('[done] internal-markup.js: 已放入') }
    }

    const gwFile2 = path.join(lib, 'gateway.js')
    let gw2 = fs.readFileSync(gwFile2, 'utf8')
    let gwChanged = false
    if (!gw2.includes("from './internal-markup.js'")) {
        const impRe = /import \{[^}]*\} from '\.\/gateway-util\.js';/
        if (!impRe.test(gw2)) { out('[!!] gateway.js（内部标记）: 找不到 gateway-util import'); failed = true }
        else { gw2 = gw2.replace(impRe, (m) => m + "\nimport { stripInternalMarkup } from './internal-markup.js';"); gwChanged = true }
    }
    if (!gw2.includes('stripInternalMarkup(stripClosingMarks')) {
        const before = gw2
        gw2 = gw2.replace('raw = stripClosingMarks(closingScan.text);', 'raw = stripInternalMarkup(stripClosingMarks(closingScan.text));')
        gw2 = gw2.replace('const 净文字 = stripClosingMarks(this.cleanOut(picked.净文字, row));', 'const 净文字 = stripInternalMarkup(stripClosingMarks(this.cleanOut(picked.净文字, row)));')
        if (gw2 === before) { out('[!!] gateway.js（内部标记）: 找不到 sendReply 锚点'); failed = true }
        else gwChanged = true
    }
    if (!gw2.includes('正文里只有内部标记')) {
        const a = "if (raw === '' && collected.items.length > 0) return true;"
        if (!gw2.includes(a)) { out('[!!] gateway.js（内部标记）: 找不到 sticker 提前返回锚点'); failed = true }
        else {
            gw2 = gw2.replace(a, a + "\n\t\tif (raw.trim() === '' && (st.images ?? []).length === 0) {\n\t\t\tthis.note('silent', { channelId: row.channel_id, title: row.title, reason: '正文里只有内部标记，已丢弃', memories, ...recallNote });\n\t\t\treturn true;\n\t\t}")
            gwChanged = true
        }
    }
    if (gwChanged) { fs.writeFileSync(gwFile2, gw2, 'utf8'); out('[done] gateway.js（内部标记）: 已打补丁') }
    else out('[ok] gateway.js（内部标记）: 已经是补丁后的内容')

    const idxFile2 = path.join(lib, 'index.js')
    let idx2 = fs.readFileSync(idxFile2, 'utf8')
    if (idx2.includes('[内部标记]')) out('[ok] index.js（内部标记规则）: 已经是补丁后的内容')
    else {
        const a = "lines.push('[接着说] 这一轮想说的没说完，就空一行接着写完（会拆成几条连发）；不要写半截停住等对方回话，也别写成「我跟你说…」然后等他问。一个话题自然聊完时，顺着刚才那件具体事反问/追问一句，让话有下一句；对方明显不想聊了才收住。');"
        if (!idx2.includes(a)) { out('[!!] index.js（内部标记规则）: 找不到 [接着说] 锚点'); failed = true }
        else {
            idx2 = idx2.replace(a, a + "\n\t\t\tlines.push('[内部标记] 不要把 <system-reminder>、工具调用标签（DSML 等）写进回复正文；这些是内部内容，只写要发给对方的话。');")
            fs.writeFileSync(idxFile2, idx2, 'utf8')
            out('[done] index.js（内部标记规则）: 已打补丁')
        }
    }
}

// ── 10) fish_search 网络失败自动重试一次（fetch failed / 5xx）──────────
{
	const srFile = path.join(lib, 'search-retry.js')
	const srData = path.join(patchDir, 'search-retry.js')
	if (!fs.existsSync(srData)) { out('[!!] search-retry.js: 缺少补丁数据文件'); failed = true }
	else {
		const want = fs.readFileSync(srData, 'utf8')
		if (fs.existsSync(srFile) && fs.readFileSync(srFile, 'utf8') === want) out('[ok] search-retry.js: 已经是补丁后的内容')
		else { fs.writeFileSync(srFile, want, 'utf8'); out('[done] search-retry.js: 已放入') }
	}

	const idxFile3 = path.join(lib, 'index.js')
	let idx3 = fs.readFileSync(idxFile3, 'utf8')
	let idxChanged = false
	if (!idx3.includes("from './search-retry.js'")) {
		const imp = "import { webSearchConfig, ownSearchReady, webSearch, formatSearch } from './websearch.js';"
		if (!idx3.includes(imp)) { out('[!!] index.js（搜索重试）: 找不到 websearch import'); failed = true }
		else { idx3 = idx3.replace(imp, imp + "\nimport { withSearchRetry } from './search-retry.js';"); idxChanged = true }
	}
	if (!idx3.includes('withSearchRetry(() => runWebSearch')) {
		const a = 'return formatSearch(q, await runWebSearch(q, { signal: toolCtx?.signal }));'
		if (!idx3.includes(a)) { out('[!!] index.js（搜索重试）: 找不到 fish_search 调用'); failed = true }
		else {
			idx3 = idx3.replace(a, 'return formatSearch(q, await withSearchRetry(() => runWebSearch(q, { signal: toolCtx?.signal }), { signal: toolCtx?.signal }));')
			idxChanged = true
		}
	}
	if (idxChanged) { fs.writeFileSync(idxFile3, idx3, 'utf8'); out('[done] index.js（搜索重试）: 已打补丁') }
	else out('[ok] index.js（搜索重试）: 已经是补丁后的内容')
}
// ── 11) 搜索结果模式（links / summary 沙箱摘要）+ 设置页开关 ──────────
{
	let ver = ''
	try { ver = String(JSON.parse(fs.readFileSync(path.join(lib, '..', 'package.json'), 'utf8')).version ?? '') } catch { /* 读不到就跳过 */ }
	const mm = /^0\.(\d+)\./.exec(ver)
	if (mm !== null && Number(mm[1]) >= 18) {
		const r = applySearchMode({ lib, patchDir, out })
		if (!r.ok) failed = true
	} else {
		out(`[skip] 搜索结果模式：${ver || '未知版本'} 不支持（需要 0.18.x）`)
	}
}
// ── 12) Content Exists Risk：自动标记会话不可用，下一条消息换新 ──────────
{
	let ver = ''
	try { ver = String(JSON.parse(fs.readFileSync(path.join(lib, '..', 'package.json'), 'utf8')).version ?? '') } catch { /* 读不到就跳过 */ }
	const mm = /^0\.(\d+)\.(\d+)/.exec(ver)
	const supported = mm !== null && (Number(mm[1]) > 18 || (Number(mm[1]) === 18 && Number(mm[2]) >= 22))
	if (supported) {
		const r = applyContentRisk({ lib, patchDir, out })
		if (!r.ok) failed = true
	} else {
		out(`[skip] 内容风控自愈：${ver || '未知版本'} 不支持（需要 0.18.22+）`)
	}
}
// ── 13) 多步 turn 的最后一步 [不回] 不覆盖前面真正的回复 ─────────────
{
	let ver = ''
	try { ver = String(JSON.parse(fs.readFileSync(path.join(lib, '..', 'package.json'), 'utf8')).version ?? '') } catch { /* 读不到就跳过 */ }
	const mm = /^0\.(\d+)\.(\d+)/.exec(ver)
	const supported = mm !== null && (Number(mm[1]) > 18 || (Number(mm[1]) === 18 && Number(mm[2]) >= 22))
	if (supported) {
		const r = applyReplyPreserve({ lib, out })
		if (!r.ok) failed = true
	} else {
		out(`[skip] 回复保留：${ver || '未知版本'} 不支持（需要 0.18.22+）`)
	}
}
out(failed ? '\n有步骤没成功，先别急着重启，看看上面的提示。' : '\n补丁完成，重启 DSH 生效。')
process.exitCode = failed ? 1 : 0
