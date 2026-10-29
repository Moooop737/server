/**
 * 断言判定 —— 纯函数，不碰库、不碰网络。
 * expect 全部命中、reject 全部不命中才算 passed；每条 check 单独记 matched / error。
 * 子串大小写不敏感；正则统一按 'i' 编译（JS 字符串不能携带 flags），编译失败记在该条 error 上并算不通过。
 */

export { evaluateAssertions }

import type { EvalAssertionCheck, EvalAssertionResult, EvalAssertions } from '../adapter/contract'

function evaluateAssertions(Answer: string, Assertions: EvalAssertions): EvalAssertionResult {
  const Expect = Assertions.expect.map((Item) => check(Item.text, Item.regex, Answer, true))
  const Reject = Assertions.reject.map((Item) => check(Item.text, Item.regex, Answer, false))
  return { passed: [...Expect, ...Reject].every((Item) => Item.matched), expect: Expect, reject: Reject }
}

function check(Text: string, Regex: boolean, Answer: string, WantPresent: boolean): EvalAssertionCheck {
  if (Regex) {
    try {
      const Hit = new RegExp(Text, 'i').test(Answer)
      return { text: Text, regex: true, matched: WantPresent ? Hit : !Hit, error: null }
    } catch (Err) {
      return { text: Text, regex: true, matched: false, error: Err instanceof Error ? Err.message : String(Err) }
    }
  }
  const Hit = Answer.toLowerCase().includes(Text.toLowerCase())
  return { text: Text, regex: false, matched: WantPresent ? Hit : !Hit, error: null }
}
