/**
 * 模型清单路由 —— GET /models，返回在册对话模型的 { id, provider, name } 清单与默认模型。
 * name 是注册表里写死的显示名；id 是 `${provider}:${modelId}` 复合键，同一 modelId 挂两家不会互相覆盖。
 * provider 是注册表里的供应商键，前端据此挂品牌标；别在前端另抄一份映射。
 * 清单不过滤：注册了什么就列什么，坏模型也在（调用方自己认）。
 * default 来自 CHAT_MODEL，前端拿它做下拉的初始选中；不在这里做可用性探测。
 */

import 'reflect-metadata'
import { Hono } from 'hono'
import { inject, injectable } from 'tsyringe'
import { ChatHandle } from '../adapter/contract'
import { AppConfig } from '../config'

export { ModelsRoute }

@injectable()
class ModelsRoute {
  private readonly handle: ChatHandle
  private readonly config: AppConfig

  constructor(
    @inject(ChatHandle) Handle: ChatHandle,
    @inject(AppConfig) Config: AppConfig) {
    this.handle = Handle
    this.config = Config
  }

  build(): Hono {
    const app = new Hono()

    app.get('/', (c) => c.json({ default: this.config.chatModel, models: this.handle.catalog() }))

    return app
  }
}
