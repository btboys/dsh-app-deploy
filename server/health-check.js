// 健康检查：HTTP 2xx + success === true + code === 200，单次 5s，间隔 3s，总 120s
export function isHealthyPayload(body) {
  return !!body && body.success === true && body.code === 200
}

export async function checkHealth(url, log, timeoutMs = 120000, intervalMs = 3000) {
  if (!url) return true
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  log('健康检查开始（HTTP 2xx、success=true、code=200）\n')
  while (Date.now() < deadline) {
    let reason
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      })
      if (response.ok) {
        const body = await response.json()
        if (isHealthyPayload(body)) {
          log('健康检查通过\n')
          return true
        }
        reason = '业务状态不健康（需要 success=true、code=200）'
      } else {
        await response.body?.cancel()
        reason = `HTTP ${response.status}`
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
