import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {formatBytes, toPlainText} from './format.js'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'yoinks')
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json')
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json')

/** History cap: 30 elements maximum */
export const LIMIT = 30

/** 72 hours TTL in milliseconds */
export const TTL_MS = 72 * 60 * 60 * 1000

/** 3 days quota window (72 hours) */
export const QUOTA_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

/** 10 GB download quota per 3 days */
export const MAX_QUOTA_BYTES = 10 * 1024 * 1024 * 1024

export type HistoryRecord = {
  id: string
  sessionId: string
  url: string
  title: string
  filename: string
  filepath: string
  filesize?: number
  timestamp: number
  expiresAt: number
  maskedToken: string
  platform?: string
  choiceLabel?: string
  fileExists?: boolean
}

type StoredHistory = {
  version: 2
  records: HistoryRecord[]
  urls: string[]
}

function generateToken(): string {
  return crypto.randomBytes(16).toString('hex')
}

export function generateSessionId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : generateToken()
}

/**
 * Gets or creates the local terminal user's session (valid for 72h).
 */
export function getOrCreatePersistentSessionId(): string {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as {sessionId: string; createdAt: number}
      if (data && data.sessionId && Date.now() - data.createdAt < TTL_MS) {
        return data.sessionId
      }
    }
  } catch {
    // ignore
  }

  const newId = generateSessionId()
  try {
    fs.mkdirSync(CONFIG_DIR, {recursive: true})
    fs.writeFileSync(SESSION_FILE, JSON.stringify({sessionId: newId, createdAt: Date.now()}, null, 2))
  } catch {
    // ignore
  }
  return newId
}

/**
 * Calculates download quota usage in the last 3 days for the given session.
 */
export function getSessionQuotaUsage(sessionId?: string): {
  usedBytes: number
  maxBytes: number
  remainingBytes: number
  percent: number
  isExceeded: boolean
} {
  const records = loadHistoryRecords(sessionId)
  const now = Date.now()
  const recentRecords = records.filter(r => r.timestamp && now - r.timestamp < QUOTA_WINDOW_MS)
  const usedBytes = recentRecords.reduce((sum, r) => sum + (r.filesize || 0), 0)
  const remainingBytes = Math.max(0, MAX_QUOTA_BYTES - usedBytes)
  const percent = Math.min(1, usedBytes / MAX_QUOTA_BYTES)
  const isExceeded = usedBytes >= MAX_QUOTA_BYTES

  return {usedBytes, maxBytes: MAX_QUOTA_BYTES, remainingBytes, percent, isExceeded}
}

/**
 * Checks if a download is permitted under the 10GB / 3-day quota.
 */
export function checkDownloadQuota(
  estimatedBytes?: number,
  sessionId?: string,
): {
  allowed: boolean
  usedBytes: number
  remainingBytes: number
  reason?: string
} {
  const quota = getSessionQuotaUsage(sessionId)
  if (quota.isExceeded) {
    return {
      allowed: false,
      usedBytes: quota.usedBytes,
      remainingBytes: 0,
      reason: `3-day quota of 10 GB reached (${formatBytes(quota.usedBytes)} used). Resets as files expire.`,
    }
  }
  if (estimatedBytes && quota.usedBytes + estimatedBytes > MAX_QUOTA_BYTES) {
    return {
      allowed: false,
      usedBytes: quota.usedBytes,
      remainingBytes: quota.remainingBytes,
      reason: `Download of ${formatBytes(estimatedBytes)} exceeds 10 GB limit (${formatBytes(quota.remainingBytes)} remaining).`,
    }
  }
  return {allowed: true, usedBytes: quota.usedBytes, remainingBytes: quota.remainingBytes}
}

/**
 * Robustly checks if a file exists on disk, handling Windows character replacements, emojis, and format conversions.
 */
export function checkAndFixFilePath(originalPath: string): {exists: boolean; actualPath: string; size?: number} {
  if (!originalPath) return {exists: false, actualPath: originalPath}

  // Helper to rename on disk to plain text if needed
  const sanitizeOnDisk = (foundPath: string): {exists: boolean; actualPath: string; size?: number} => {
    try {
      const ext = path.extname(foundPath)
      const base = path.basename(foundPath, ext)
      const plainBase = toPlainText(base)
      if (plainBase && plainBase !== base) {
        const plainPath = path.join(path.dirname(foundPath), `${plainBase}${ext}`)
        if (!fs.existsSync(plainPath)) {
          fs.renameSync(foundPath, plainPath)
          foundPath = plainPath
        }
      }
      const stat = fs.statSync(foundPath)
      return {exists: stat.isFile(), actualPath: foundPath, size: stat.size}
    } catch {
      return {exists: fs.existsSync(foundPath), actualPath: foundPath}
    }
  }

  // 1. Direct path check
  try {
    if (fs.existsSync(originalPath)) {
      return sanitizeOnDisk(originalPath)
    }
  } catch {
    // continue
  }

  // 2. Trailing spaces before extension check
  const trimmed = originalPath.replace(/\s+\.([^.]+)$/, '.$1')
  if (trimmed !== originalPath) {
    try {
      if (fs.existsSync(trimmed)) {
        return sanitizeOnDisk(trimmed)
      }
    } catch {
      // continue
    }
  }

  // 3. Scan directory for matching files (handles emoji sanitization, special unicode symbols, partial ffmpeg suffixes)
  const dir = path.dirname(originalPath)
  const ext = path.extname(originalPath)
  const baseWithoutExt = path.basename(originalPath, ext).trim()

  const keywords = baseWithoutExt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3)

  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir)
      const mediaFiles = files.filter(f => {
        const fileExt = path.extname(f).toLowerCase()
        return ['.mp4', '.mkv', '.webm', '.mp3', '.m4a', '.mov', '.avi'].includes(fileExt)
      })

      let bestMatch: string | undefined
      let maxScore = 0

      for (const file of mediaFiles) {
        const fileLower = file.toLowerCase()
        if (keywords.length > 0) {
          const matchedCount = keywords.filter(k => fileLower.includes(k)).length
          const score = matchedCount / keywords.length
          if (score >= 0.4 && score > maxScore) {
            maxScore = score
            bestMatch = path.join(dir, file)
          }
        }
      }

      if (bestMatch && fs.existsSync(bestMatch)) {
        return sanitizeOnDisk(bestMatch)
      }
    }
  } catch {
    // continue
  }

  return {exists: false, actualPath: originalPath}
}

function parseRawHistory(content: string): {records: HistoryRecord[]; urls: string[]} {
  try {
    const parsed: unknown = JSON.parse(content)
    if (Array.isArray(parsed)) {
      const urls = parsed.filter((item): item is string => typeof item === 'string')
      return {records: [], urls}
    }
    if (parsed && typeof parsed === 'object' && 'records' in parsed) {
      const data = parsed as Partial<StoredHistory>
      const records = Array.isArray(data.records) ? data.records : []
      const urls = Array.isArray(data.urls) ? data.urls : records.map(r => r.url)
      return {records, urls}
    }
  } catch {
    // ignore parse error
  }
  return {records: [], urls: []}
}

function readStoredHistory(): {records: HistoryRecord[]; urls: string[]} {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {records: [], urls: []}
    const content = fs.readFileSync(HISTORY_FILE, 'utf8')
    return parseRawHistory(content)
  } catch {
    return {records: [], urls: []}
  }
}

function writeStoredHistory(data: {records: HistoryRecord[]; urls: string[]}): void {
  try {
    fs.mkdirSync(CONFIG_DIR, {recursive: true})
    const payload: StoredHistory = {
      version: 2,
      records: data.records.slice(0, LIMIT),
      urls: Array.from(new Set(data.urls)).slice(0, LIMIT),
    }
    fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(payload, null, 2)}\n`)
  } catch {
    // ignore write errors
  }
}

export function cleanExpiredRecords(): void {
  const {records, urls} = readStoredHistory()
  const now = Date.now()
  const surviving: HistoryRecord[] = []

  for (const record of records) {
    const isExpired = record.expiresAt ? now > record.expiresAt : false
    if (isExpired) {
      try {
        const fileCheck = checkAndFixFilePath(record.filepath)
        if (fileCheck.exists) {
          fs.unlinkSync(fileCheck.actualPath)
        }
      } catch {
        // ignore deletion error
      }
    } else {
      surviving.push(record)
    }
  }

  if (surviving.length !== records.length) {
    writeStoredHistory({records: surviving, urls})
  }
}

export function loadHistory(sessionId?: string): string[] {
  cleanExpiredRecords()
  const {urls, records} = readStoredHistory()
  if (sessionId) {
    return records.filter(r => r.sessionId === sessionId).map(r => r.url)
  }
  if (urls.length > 0) return urls
  return records.map(r => r.url)
}

export function loadHistoryRecords(sessionId?: string): HistoryRecord[] {
  cleanExpiredRecords()
  const {records, urls} = readStoredHistory()
  let modified = false

  const updatedRecords = records.map(record => {
    const plainTitle = toPlainText(record.title || record.filename)
    const fileCheck = checkAndFixFilePath(record.filepath)
    const newFilename = path.basename(fileCheck.actualPath)
    if (record.title !== plainTitle || record.filepath !== fileCheck.actualPath || record.filename !== newFilename) {
      modified = true
    }
    return {
      ...record,
      title: plainTitle,
      filename: newFilename,
      filepath: fileCheck.actualPath,
      filesize: fileCheck.size ?? record.filesize,
      fileExists: fileCheck.exists,
    }
  })

  if (modified) {
    writeStoredHistory({records: updatedRecords, urls})
  }

  const filtered = sessionId ? updatedRecords.filter(r => r.sessionId === sessionId) : updatedRecords
  return filtered.slice(0, LIMIT)
}

export function findRecordByToken(token: string): HistoryRecord | undefined {
  cleanExpiredRecords()
  const {records} = readStoredHistory()
  const now = Date.now()
  const record = records.find(r => r.maskedToken === token || r.id === token)

  if (!record) return undefined
  if (record.expiresAt && now > record.expiresAt) {
    try {
      const fileCheck = checkAndFixFilePath(record.filepath)
      if (fileCheck.exists) fs.unlinkSync(fileCheck.actualPath)
    } catch {
      // ignore
    }
    cleanExpiredRecords()
    return undefined
  }

  const fileCheck = checkAndFixFilePath(record.filepath)
  return {
    ...record,
    filepath: fileCheck.actualPath,
    filesize: fileCheck.size ?? record.filesize,
    fileExists: fileCheck.exists,
  }
}

export function addToHistory(url: string): string[] {
  const {records, urls} = readStoredHistory()
  const nextUrls = [url, ...urls.filter(entry => entry !== url)].slice(0, LIMIT)
  writeStoredHistory({records, urls: nextUrls})
  return nextUrls
}

export function cleanMissingRecords(sessionId?: string): HistoryRecord[] {
  cleanExpiredRecords()
  const {records, urls} = readStoredHistory()
  const validRecords = records.filter(r => checkAndFixFilePath(r.filepath).exists)
  writeStoredHistory({records: validRecords, urls})
  const results = sessionId ? validRecords.filter(r => r.sessionId === sessionId) : validRecords
  return results.slice(0, LIMIT).map(r => {
    const fileCheck = checkAndFixFilePath(r.filepath)
    return {
      ...r,
      filepath: fileCheck.actualPath,
      filesize: fileCheck.size ?? r.filesize,
      fileExists: true,
    }
  })
}

export function saveDownloadRecord(entry: {
  url: string
  title: string
  filepath: string
  sessionId?: string
  platform?: string
  choiceLabel?: string
}): HistoryRecord {
  const {records, urls} = readStoredHistory()
  const fileCheck = checkAndFixFilePath(entry.filepath)
  const actualPath = fileCheck.actualPath
  const filename = path.basename(actualPath)

  const now = Date.now()
  const plainTitle = toPlainText(entry.title || filename)
  const record: HistoryRecord = {
    id: crypto.randomUUID ? crypto.randomUUID() : generateToken(),
    sessionId: entry.sessionId || getOrCreatePersistentSessionId(),
    url: entry.url,
    title: plainTitle,
    filename,
    filepath: actualPath,
    filesize: fileCheck.size,
    timestamp: now,
    expiresAt: now + TTL_MS,
    maskedToken: generateToken(),
    platform: entry.platform,
    choiceLabel: entry.choiceLabel,
    fileExists: fileCheck.exists,
  }

  const nextRecords = [record, ...records.filter(r => r.filepath !== actualPath)].slice(0, LIMIT)
  const nextUrls = [entry.url, ...urls.filter(u => u !== entry.url)].slice(0, LIMIT)
  writeStoredHistory({records: nextRecords, urls: nextUrls})
  return record
}
