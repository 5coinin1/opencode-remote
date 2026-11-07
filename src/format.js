const CHUNK = 1900

export function truncate(s, n) {
  if (!s) return ''
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

/** Chia văn bản dài thành nhiều phần <= CHUNK, ưu tiên cắt ở dòng mới. */
export function chunk(text, size = CHUNK) {
  const out = []
  let rest = text ?? ''
  if (rest === '') return ['']
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  out.push(rest)
  return out
}

/** Tóm tắt input của tool cho gọn (1 dòng, tối đa n ký tự). */
export function summarizeToolInput(input) {
  let s
  if (input == null) s = ''
  else if (typeof input === 'string') s = input
  else {
    try {
      s = JSON.stringify(input)
    } catch {
      s = String(input)
    }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return truncate(s, 160)
}

export function formatTokens(tokens) {
  if (!tokens) return ''
  const i = tokens.input ?? 0
  const o = tokens.output ?? 0
  const r = tokens.reasoning ?? 0
  const cr = tokens.cache?.read ?? 0
  const parts = [`in ${i}`, `out ${o}`]
  if (r) parts.push(`reason ${r}`)
  if (cr) parts.push(`cache ${cr}`)
  return parts.join(' / ')
}

export function formatCost(cost) {
  if (cost == null) return ''
  return `$${Number(cost).toFixed(4)}`
}
