/** 模型键 `${provider}:${modelId}` 的稳定拆法；键制保证必含冒号。 */
export { modelIdOf }

function modelIdOf(Key: string): string {
  const At = Key.indexOf(':')
  return At === -1 ? Key : Key.slice(At + 1)
}
