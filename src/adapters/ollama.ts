// Ollama 健康探测：查 /api/version 确认可达（带超时，避免静默挂起）
export async function pingOllama(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
