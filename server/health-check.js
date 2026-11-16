// 健康检查：HTTP 200 必须通过；可选成功内容正则匹配响应文本；单次 5s，间隔 3s，总 120s

// 编译成功内容正则；pattern 支持纯字符串或 /正则/flags 写法（flags 仅 i m s u y，不支持 g——多次 test 会受 lastIndex 影响）
// 返回 { re } 或 { error }
export function compilePattern(pattern) {
  if (!pattern) return { re: null }
  let source = pattern
  let flags = ''
  const delimited = pattern.match(/^\/(.*)\/([a-z]*)$/s)
  if (delimited) {
    if (!delimited[1]) return { error: '正则表达式为空' }
    if (/[^imsuy]/.test(delimited[2])) return { error: `不支持的 flag「${delimited[2]}」（仅支持 i m s u y，不支持 g）` }
    source = delimited[1]
    flags = delimited[2]
  }
  try {
    return { re: new RegExp(source, flags) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : '正则编译失败' }
  }
}

export async function checkHealth(url, pattern, log, timeoutMs = 120000, intervalMs = 3000) {
  if (!url) return true
  const { re, error } = compilePattern(pattern)
  const rule = pattern ? `HTTP 200 且响应内容匹配 /${pattern}/` : 'HTTP 200'
  if (error) {
    log(`健康检查失败：成功内容正则不合法（${error}）\n`)
    return false
  }
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  log(`健康检查开始（${rule}）\n`)
  while (Date.now() < deadline) {
    let reason
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
        headers: { Accept: '*/*', 'Cache-Control': 'no-cache' },
      })
      if (response.status === 200) {
        const text = await response.text()
        if (!re || re.test(text)) {
          log('健康检查通过\n')
          return true
        }
        reason = '响应内容与成功正则不匹配'
      } else {
        await response.body?.cancel()
        reason = `HTTP ${response.status}（需要 200）`
      }
    } catch (error) {
      reason = error instanceof Error ? error.name : '请求失败'
    }
    log(`健康检查第 ${++attempt} 次未通过：${reason}\n`)
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)))
  }
  log(`健康检查失败：${timeoutMs / 1000} 秒内未恢复健康\n`)
  return false
}
