/** 防止多步 turn 的最后一步 `[不回]` 覆盖前面已经生成的正经回复。 */
import fs from 'node:fs'
import path from 'node:path'

export function applyReplyPreserve({ lib, out }) {
	const file = path.join(lib, 'gateway-dispatch.js')
	let t = fs.readFileSync(file, 'utf8')
	if (t.includes('const visible = stripInternalMarkup')) { out('[ok] gateway-dispatch.js（回复保留）: 已经是补丁后的内容'); return { ok: true } }
	const old = "\t\t\tif (text !== '') { st.text = text; st.images = images; } else if (images.length > 0) st.images = st.images.concat(images).slice(0, 10);"
	const neu = [
		"\t\t\t// 最后一步只回了 [不回] 或内部提示时，不要覆盖本轮前面已经生成的正经回复。",
		"\t\t\tconst visible = stripInternalMarkup(text).trim();",
		"\t\t\tif (visible !== '') { st.text = text; st.images = images; } else if (images.length > 0) st.images = st.images.concat(images).slice(0, 10);",
		"\t\t\telse if (text !== '' && String(st.text ?? '').trim() === '') { st.text = text; st.images = images; }"
	].join('\n')
	if (!t.includes(old)) { out('[!!] gateway-dispatch.js（回复保留）: 找不到锚点'); return { ok: false } }
	t = t.replace(old, neu)
	fs.writeFileSync(file, t, 'utf8')
	out('[done] gateway-dispatch.js（回复保留）: 已打补丁')
	return { ok: true }
}
