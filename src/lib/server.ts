import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {findRecordByToken, getSessionQuotaUsage, loadHistoryRecords} from './history.js'

let activeServer: http.Server | null = null
let currentPort: number | null = null

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/["\r\n\\]/g, '_')
}

export function getServerBaseUrl(): string | undefined {
  if (!currentPort) return undefined
  return `http://127.0.0.1:${currentPort}`
}

export function getMaskedDownloadUrl(token: string): string {
  const base = getServerBaseUrl() || 'http://127.0.0.1:4321'
  return `${base}/d/${token}`
}

export function createDownloadServer(): http.Server {
  return http.createServer((req, res) => {
    // Basic CORS & security headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'X-Session-ID, Content-Type, Range')
    res.setHeader('X-Content-Type-Options', 'nosniff')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const pathname = reqUrl.pathname

    // Health check
    if (pathname === '/' || pathname === '/health') {
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({
        status: 'ok',
        service: 'yoinks-direct-masked-download',
        ttlHours: 72,
        quota3dGb: 10,
        maxItems: 30,
        itemsPerPage: 10,
      }))
      return
    }

    // JSON history API (masked, isolated by session if requested)
    if (pathname === '/api/history') {
      const sessionIdHeader = req.headers['x-session-id']
      const sessionIdQuery = reqUrl.searchParams.get('session_id')
      const targetSessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : sessionIdQuery || undefined

      const records = loadHistoryRecords(targetSessionId)
      const quota = getSessionQuotaUsage(targetSessionId)
      const now = Date.now()
      const baseUrl = getServerBaseUrl() || `http://${req.headers.host || '127.0.0.1:4321'}`
      const safeRecords = records.map(r => ({
        id: r.id,
        title: r.title,
        filename: r.filename,
        filesize: r.filesize,
        timestamp: r.timestamp,
        expiresAt: r.expiresAt,
        expiresInSeconds: Math.max(0, Math.round((r.expiresAt - now) / 1000)),
        platform: r.platform,
        choiceLabel: r.choiceLabel,
        downloadUrl: `${baseUrl}/d/${r.maskedToken}`,
      }))

      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({
        quota: {
          usedBytes: quota.usedBytes,
          maxBytes: quota.maxBytes,
          remainingBytes: quota.remainingBytes,
          percent: quota.percent,
          isExceeded: quota.isExceeded,
        },
        records: safeRecords,
      }, null, 2))
      return
    }

    // Masked file download route: /d/:token or /download/:token
    const match = pathname.match(/^\/(?:d|download)\/([a-zA-Z0-9_-]+)$/)
    if (match) {
      const token = match[1]!
      const record = findRecordByToken(token)

      if (!record || !record.filepath) {
        res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'})
        res.end('404 Not Found: Invalid or expired download link (links expire after 72 hours).')
        return
      }

      // Check 72-hour TTL expiration
      const now = Date.now()
      if (record.expiresAt && now > record.expiresAt) {
        try {
          if (fs.existsSync(record.filepath)) fs.unlinkSync(record.filepath)
        } catch {
          // ignore
        }
        res.writeHead(410, {'Content-Type': 'text/plain; charset=utf-8'})
        res.end('410 Gone: This download link has expired. Ephemeral files are retained for 72 hours only.')
        return
      }

      let stat: fs.Stats
      try {
        stat = fs.statSync(record.filepath)
        if (!stat.isFile()) throw new Error('Not a file')
      } catch {
        res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'})
        res.end('404 Not Found: The requested media file is no longer available on disk.')
        return
      }

      const totalSize = stat.size
      const mimeType = getMimeType(record.filepath)
      const safeName = sanitizeFilename(record.filename || path.basename(record.filepath))

      // Support Range requests (video scrubbing & paused/resumed downloads)
      const range = req.headers.range
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0]!, 10)
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1

        if (isNaN(start) || start >= totalSize || (parts[1] && isNaN(end)) || start > end) {
          res.writeHead(416, {
            'Content-Range': `bytes */${totalSize}`,
          })
          res.end()
          return
        }

        const chunksize = end - start + 1
        const stream = fs.createReadStream(record.filepath, {start, end})

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}"`,
        })

        stream.pipe(res)
        return
      }

      res.writeHead(200, {
        'Content-Length': totalSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}"`,
      })

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      const fileStream = fs.createReadStream(record.filepath)
      fileStream.pipe(res)
      return
    }

    res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'})
    res.end('404 Not Found')
  })
}

/**
 * Starts the embedded masked download server.
 */
export async function startServer(
  preferredPort = 4321,
): Promise<{port: number; baseUrl: string; close: () => Promise<void>}> {
  if (activeServer && currentPort) {
    return {
      port: currentPort,
      baseUrl: getServerBaseUrl()!,
      close: stopServer,
    }
  }

  const server = createDownloadServer()

  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          if (port !== 0) {
            tryListen(0)
            return
          }
        }
        reject(err)
      })

      server.listen(port, '127.0.0.1', () => {
        const addr = server.address()
        const assignedPort = typeof addr === 'object' && addr ? addr.port : port
        activeServer = server
        currentPort = assignedPort
        resolve({
          port: assignedPort,
          baseUrl: `http://127.0.0.1:${assignedPort}`,
          close: stopServer,
        })
      })
    }

    tryListen(preferredPort)
  })
}

/**
 * Stops the running embedded server if active.
 */
export async function stopServer(): Promise<void> {
  if (!activeServer) return
  return new Promise((resolve, reject) => {
    activeServer?.close(err => {
      activeServer = null
      currentPort = null
      if (err) reject(err)
      else resolve()
    })
  })
}
