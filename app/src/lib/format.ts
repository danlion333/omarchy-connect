export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${units[i]}`
}

export function rate(bytesPerSecond: number | null | undefined): string {
  if (!Number.isFinite(bytesPerSecond as number)) return '—'
  return `${bytes(bytesPerSecond as number)}/s`
}

export function percent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—'
  return `${(fraction * 100).toFixed(digits)}%`
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)} ms`
}

export function duration(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds as number) || (seconds as number) < 0) return '—'
  const s = Math.floor(seconds as number)
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${s % 60}s`
  return `${s}s`
}

export function clock(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  const d = new Date(timestamp)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toTimeString().slice(0, 5)
  return sameDay ? time : `${d.getDate()}/${d.getMonth() + 1} ${time}`
}

export function ago(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  const diff = Math.max(0, Date.now() - timestamp) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}
