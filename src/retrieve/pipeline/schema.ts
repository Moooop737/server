/**
 * T2 spike · JSON Schema 子集判定（结构可赋值）—— 判断上游输出端口能否接到下游输入端口。
 * 方向：isSubschema(Provided, Required) = true 表示 Provided 的每个合法值都满足 Required。
 * 只支持组件端口实际用到的关键字：type / const / enum / anyOf / properties / required / additionalProperties / items。
 * 其余约束（min/max/length/format/pattern/ref/allOf…）按「不支持」处理，由装配层拒绝，不静默放行。
 */

export { isSubschema }
export type { JsonSchema, SchemaVerdict }

type JsonSchema = { [Key: string]: unknown }

type SchemaVerdict =
  | { ok: true }
  | { ok: false; path: string; reason: string; unsupported: boolean }

const UNSUPPORTED_KEYS = [
  '$ref', '$defs', 'definitions',
  'allOf', 'oneOf', 'not', 'if', 'then', 'else',
  'patternProperties', 'propertyNames', 'unevaluatedProperties',
  'prefixItems', 'contains',
  'pattern', 'format',
] as const

function isSubschema(Provided: JsonSchema, Required: JsonSchema, Path = '$'): SchemaVerdict {
  for (const Key of UNSUPPORTED_KEYS) {
    if (Key in Provided) return fail(Path, `provided 使用了不支持的 ${Key}`, true)
    if (Key in Required) return fail(Path, `required 使用了不支持的 ${Key}`, true)
  }

  const ProvidedAny = anyOfOf(Provided)
  const RequiredAny = anyOfOf(Required)
  if (ProvidedAny !== null) {
    for (let i = 0; i < ProvidedAny.length; i++) {
      const Verdict = isSubschema(ProvidedAny[i]!, Required, `${Path}.anyOf[${i}]`)
      if (!Verdict.ok) return Verdict
    }
    return { ok: true }
  }
  if (RequiredAny !== null) {
    let Last: SchemaVerdict = fail(Path, 'provided 不匹配 required 的任一 anyOf 分支')
    for (let i = 0; i < RequiredAny.length; i++) {
      const Verdict = isSubschema(Provided, RequiredAny[i]!, `${Path}.anyOf[${i}]`)
      if (Verdict.ok) return Verdict
      if (Verdict.unsupported) return Verdict
      Last = Verdict
    }
    return Last
  }

  const ValuesP = valuesOf(Provided)
  const ValuesR = valuesOf(Required)
  if (ValuesR !== null) {
    if (ValuesP === null) return fail(Path, 'provided 未限制取值，required 是枚举/常量')
    for (const Value of ValuesP) {
      if (!ValuesR.some((Allowed) => sameJson(Value, Allowed))) {
        return fail(Path, `provided 取值 ${JSON.stringify(Value)} 不在 required 的枚举内`)
      }
    }
  }

  const TypesP = typeListOf(Provided)
  const TypesR = typeListOf(Required)
  if (TypesR !== null) {
    if (TypesP === null) return fail(Path, `required 限定 type ${TypesR.join('|')}，provided 未限定`)
    for (const Type of TypesP) {
      if (TypesR.includes(Type)) continue
      if (Type === 'integer' && TypesR.includes('number')) continue
      return fail(Path, `type ${Type} 不在 required 的 ${TypesR.join('|')} 内`)
    }
  }

  const ObjectTypes = TypesR ?? TypesP
  const LooksObject = ObjectTypes !== null
    ? ObjectTypes.includes('object')
    : 'properties' in Provided || 'properties' in Required || 'required' in Provided || 'required' in Required
  if (LooksObject) {
    const Verdict = checkObject(Provided, Required, Path)
    if (!Verdict.ok) return Verdict
  }

  const LooksArray = ObjectTypes !== null
    ? ObjectTypes.includes('array')
    : 'items' in Provided || 'items' in Required
  if (LooksArray) {
    const Verdict = checkArray(Provided, Required, Path)
    if (!Verdict.ok) return Verdict
  }

  return { ok: true }
}

function checkObject(Provided: JsonSchema, Required: JsonSchema, Path: string): SchemaVerdict {
  const PropsP = propertiesOf(Provided)
  const PropsR = propertiesOf(Required)
  const NeededP = requiredOf(Provided)
  const NeededR = requiredOf(Required)

  for (const Key of NeededR) {
    if (!(Key in PropsP)) return fail(`${Path}.${Key}`, 'required 需要该字段，provided 未提供')
    if (!NeededP.includes(Key)) return fail(`${Path}.${Key}`, 'required 要求该字段必需，provided 中它是可选的')
    const Verdict = isSubschema(PropsP[Key]!, PropsR[Key]!, `${Path}.${Key}`)
    if (!Verdict.ok) return Verdict
  }

  for (const Key of Object.keys(PropsR)) {
    if (Key in PropsP) continue
    if (NeededR.includes(Key)) continue
    // required 的可选字段，provided 不提供也合法（缺失 = undefined）
  }

  for (const Key of Object.keys(PropsP)) {
    if (Key in PropsR) continue
    const Additional = Required.additionalProperties
    if (Additional === false) return fail(`${Path}.${Key}`, 'required 是封闭对象，不接受额外字段')
    if (Additional !== undefined && Additional !== true && typeof Additional === 'object') {
      const Verdict = isSubschema(PropsP[Key]!, Additional as JsonSchema, `${Path}.${Key}`)
      if (!Verdict.ok) return Verdict
    }
  }

  return { ok: true }
}

function checkArray(Provided: JsonSchema, Required: JsonSchema, Path: string): SchemaVerdict {
  const ItemsR = Required.items
  if (ItemsR === undefined) return { ok: true }
  const ItemsP = Provided.items
  if (ItemsP === undefined) return fail(`${Path}[]`, 'required 限定了元素结构，provided 未限定')
  if (Array.isArray(ItemsP) || Array.isArray(ItemsR)) return fail(Path, '不支持 tuple 形式的 items', true)
  return isSubschema(ItemsP as JsonSchema, ItemsR as JsonSchema, `${Path}[]`)
}

function anyOfOf(Schema: JsonSchema): JsonSchema[] | null {
  const Any = Schema.anyOf
  if (!Array.isArray(Any)) return null
  return Any.filter((Item): Item is JsonSchema => Item !== null && typeof Item === 'object' && !Array.isArray(Item))
}

function valuesOf(Schema: JsonSchema): unknown[] | null {
  if ('const' in Schema) return [Schema.const]
  if (Array.isArray(Schema.enum)) return Schema.enum
  return null
}

function typeListOf(Schema: JsonSchema): string[] | null {
  const Type = Schema.type
  if (typeof Type === 'string') return [Type]
  if (Array.isArray(Type) && Type.every((Item) => typeof Item === 'string')) return Type as string[]
  return null
}

function propertiesOf(Schema: JsonSchema): Record<string, JsonSchema> {
  const Props = Schema.properties
  if (Props === null || typeof Props !== 'object' || Array.isArray(Props)) return {}
  return Props as Record<string, JsonSchema>
}

function requiredOf(Schema: JsonSchema): string[] {
  const Needed = Schema.required
  if (!Array.isArray(Needed)) return []
  return Needed.filter((Item): Item is string => typeof Item === 'string')
}

function sameJson(A: unknown, B: unknown): boolean {
  return JSON.stringify(A) === JSON.stringify(B)
}

function fail(Path: string, Reason: string, Unsupported = false): SchemaVerdict {
  return { ok: false, path: Path, reason: Reason, unsupported: Unsupported }
}
