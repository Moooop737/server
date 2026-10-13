/**
 * in-flight 登记处 —— 进程级 Map<resourceId, AbortController>，让「取消入库」这个意图能被任意请求按下。
 * 持有者是管线：runOne 建行之后的瞬间 add，结束时在 finally 里 remove。
 * 登记只在内存：进程重启即空，遗留的 processing 行由 bootstrap 的启动清扫转 failed，本模块不管。
 * abort 只回答「此前有登记、且现在按下了」，不校验资源状态、不碰数据库——那是调用方的事。
 * abort 不顺手删登记，交持有方的 finally 清；重复 abort 是 no-op。
 */

export { InflightRegistry }

class InflightRegistry {
  private readonly inflight = new Map<string, AbortController>()

  add(Id: string, Ctrl: AbortController): void {
    this.inflight.set(Id, Ctrl)
  }

  remove(Id: string): void {
    this.inflight.delete(Id)
  }

  has(Id: string): boolean {
    return this.inflight.has(Id)
  }

  abort(Id: string): boolean {
    const ctrl = this.inflight.get(Id)
    if (!ctrl) return false
    ctrl.abort()
    return true
  }
}
