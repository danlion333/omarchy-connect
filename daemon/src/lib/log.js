const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

const level = (process.env.OMARCHY_CONNECT_LOG || 'info').toLowerCase()
const RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
const threshold = RANK[level] ?? RANK.info

function stamp() {
  return new Date().toTimeString().slice(0, 8)
}

function emit(rank, color, tag, args) {
  if (rank < threshold) return
  const stream = rank >= RANK.warn ? process.stderr : process.stdout
  stream.write(`${C.dim}${stamp()}${C.reset} ${color}${tag}${C.reset} ${args.join(' ')}\n`)
}

const fmt = (a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a))

export const log = {
  debug: (...a) => emit(RANK.debug, C.dim, 'dbg', a.map(fmt)),
  info: (...a) => emit(RANK.info, C.blue, '-->', a.map(fmt)),
  ok: (...a) => emit(RANK.info, C.green, ' ok', a.map(fmt)),
  warn: (...a) => emit(RANK.warn, C.yellow, ' !!', a.map(fmt)),
  error: (...a) => emit(RANK.error, C.red, 'err', a.map(fmt)),
  colors: C,
}
