/**
 * Content-Disposition 头 —— 文件名同时给 ASCII fallback 与 RFC5987 filename*，避免中文/空格在 header 里乱码。
 * 只负责编码与 attachment/inline 前缀，不判断资源类型。
 */

export { attachmentDisposition, inlineDisposition }

function attachmentDisposition(FileName: string): string {
  return disposition('attachment', FileName)
}

function inlineDisposition(FileName: string): string {
  return disposition('inline', FileName)
}

function disposition(Kind: 'attachment' | 'inline', FileName: string): string {
  const fallback = FileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  const encoded = encodeURIComponent(FileName)
    .replace(/['()*]/g, (Char) => `%${Char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${Kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
