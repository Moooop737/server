/**
 * 模型清单路由 —— GET /models，返回可用语言模型的 { id, provider, provider_kind, icon, name } 清单与默认模型。
 * 数据来自运行时快照：catalog() 只列 available 的语言模型；default 是默认行解析出的模型键，不可用时为 null。
 * provider 是实例名（deepseek1 / route1），provider_kind 是工厂类型，显示与模型键用实例名。
 * icon 是配置页给该供应商选的品牌标键（providers.icon 列），前端只按它挂标：实例名与品牌键并不相同
 *   （route1 的 icon 是 router1），按 kind 或名字猜都会落空。未选标时为 null，前端不画。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { RuntimeModelRegistry } from '../adapter/model/runtime-registry'

export { ModelsRoute }

@injectable()
class ModelsRoute {
  private readonly registry: RuntimeModelRegistry

  constructor(@inject(RuntimeModelRegistry) Registry: RuntimeModelRegistry) {
    this.registry = Registry
  }

  build(): Hono {
    const app = new Hono()

    app.get('/', (c) => c.json({ default: this.registry.defaultKey(), models: this.registry.catalog() }))

    return app
  }
}
