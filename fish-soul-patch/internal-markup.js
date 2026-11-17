/**
 * 剥掉不该出现在聊天正文里的内部标记。
 *
 * 背景：模型偶尔会把 DSH 的 `<system-reminder>…</system-reminder>` 原样复述出来，
 * 还会把工具调用的 DSML 标记（`<||DSML|| parameter>` 等）当正文输出；fish-soul 的
 * 出站如果原样转发，用户就会在 QQ 里看到内部提示词和工具标记。
 *
 * 这里只删明确的内部标记，不做通用 HTML 清洗，避免误伤正常文字。
 */
export function stripInternalMarkup(text) {
	let s = String(text ?? '');
	// system-reminder：成对的整段删；没有闭合标签的，从它开始删到结尾（内部内容不发出）
	s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
	s = s.replace(/<system-reminder>[\s\S]*$/gi, '');
	// DSML 工具调用标记：半角/全角竖线、可选空格，例如 </||DSML|| parameter>
	s = s.replace(/<\/?\s*[|｜]{1,2}\s*DSML\s*[|｜]{1,2}[^>]*>/gi, '');
	// 其它 <|...|> 形式的 DeepSeek 特殊 token（只删带竖线的标签）
	s = s.replace(/<\/?\s*[|｜]{1,2}\s*[^<>|｜]{0,40}\s*[|｜]{1,2}\s*>/g, '');
	// 常见工具调用 XML（模型偶尔当正文写出来）
	s = s.replace(/<\/?(?:tool_call|function_calls?|invoke|parameter|tool_result)\b[^>]*>/gi, '');
	return s.replace(/\n{3,}/g, '\n\n').trim();
}
