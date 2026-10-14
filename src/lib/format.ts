export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const d = new Date(timestamp)
  const month = d.toLocaleString('en-US', {month: 'short'})
  const day = d.getDate()
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${month} ${day}, ${hours}:${minutes}`
}

export function formatRemainingTime(expiresAt: number): string {
  if (!expiresAt) return ''
  const diffMs = expiresAt - Date.now()
  if (diffMs <= 0) return 'expired'
  const hours = Math.floor(diffMs / (3600 * 1000))
  if (hours >= 1) return `${hours}h left`
  const minutes = Math.floor(diffMs / (60 * 1000))
  return `${minutes}m left`
}

export function toPlainText(text: string): string {
  if (!text) return ''
  return text
    // Strip emojis, pictographs, flags, variation selectors, zero-width chars
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200B}-\u{200D}\u{200E}\u{200F}\u{FEFF}]/gu,
      '',
    )
    // Replace pipe, colon, question mark, quotes, slashes, and illegal filesystem characters with space
    .replace(/[|:?*"<>/\\|｜]/g, ' ')
    // Normalize multiple spaces and trim
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Truncates text to max characters and appends "..." if it does not fit.
 */
export function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text
  if (max <= 3) return text.slice(0, max)
  return `${text.slice(0, max - 3).trimEnd()}...`
}

export function shortenPath(filepath: string, homedir: string, max = 60): string {
  const pretty = filepath.startsWith(homedir) ? `~${filepath.slice(homedir.length)}` : filepath
  if (pretty.length <= max) return pretty
  const ext = /\.\w{1,5}$/.exec(pretty)?.[0] ?? ''
  return `${pretty.slice(0, max - ext.length - 1)}…${ext}`
}

export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  return formatDuration(seconds)
}
