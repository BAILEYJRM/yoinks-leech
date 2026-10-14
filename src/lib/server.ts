import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {findRecordByToken, getSessionQuotaUsage, loadHistoryRecords} from './history.js'

let activeServer: http.Server | null = null
let currentPort: number | null = null
let currentHost: string | null = null
let configuredPublicUrl: string | null = null
let isServerOwner = false
let clientCount = 0

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

export function setPublicBaseUrl(url?: string): void {
  configuredPublicUrl = url ? url.replace(/\/+$/, '') : null
}

export function getServerBaseUrl(): string | undefined {
  if (configuredPublicUrl) return configuredPublicUrl
  const envPublic = process.env.PUBLIC_DOWNLOAD_URL || process.env.YOINKS_PUBLIC_URL
  if (envPublic) return envPublic.replace(/\/+$/, '')
  if (!currentPort) return undefined
  const host = currentHost && currentHost !== '0.0.0.0' ? currentHost : '127.0.0.1'
  return `http://${host}:${currentPort}`
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
 * Checks if a yoinks download server is already active on the specified port.
 */
export async function isServerRunning(port = 4321, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const targetHost = host === '0.0.0.0' ? '127.0.0.1' : host
    const req = http.request(
      {
        host: targetHost,
        port,
        path: '/health',
        method: 'GET',
        timeout: 400,
      },
      res => {
        if (res.statusCode !== 200) {
          resolve(false)
          return
        }
        let data = ''
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {status?: string; service?: string}
            resolve(parsed.status === 'ok' && parsed.service === 'yoinks-direct-masked-download')
          } catch {
            resolve(false)
          }
        })
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

/**
 * Starts or connects to the embedded masked download server.
 * Binds to 0.0.0.0 by default to be accessible through Docker port mapping and Cloudflare.
 */
export async function startServer(
  preferredPort = 4321,
  preferredHost = process.env.HOST || '0.0.0.0',
): Promise<{port: number; baseUrl: string; close: () => Promise<void>}> {
  clientCount++

  const sessionClose = async () => {
    clientCount = Math.max(0, clientCount - 1)
    if (clientCount === 0) {
      await stopServer()
    }
  }

  if (activeServer && currentPort) {
    return {
      port: currentPort,
      baseUrl: getServerBaseUrl()!,
      close: sessionClose,
    }
  }

  // If a specific non-zero port is requested, check if a shared download server is already active
  if (preferredPort > 0 && (await isServerRunning(preferredPort, preferredHost))) {
    currentPort = preferredPort
    currentHost = preferredHost
    isServerOwner = false
    return {
      port: preferredPort,
      baseUrl: getServerBaseUrl()!,
      close: sessionClose,
    }
  }

  const server = createDownloadServer()

  return new Promise((resolve, reject) => {
    const tryListen = (port: number, host: string) => {
      server.once('error', async (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // If port is in use, verify if it is our shared yoinks server
          if (port !== 0 && (await isServerRunning(port, host))) {
            currentPort = port
            currentHost = host
            isServerOwner = false
            resolve({
              port,
              baseUrl: getServerBaseUrl()!,
              close: sessionClose,
            })
            return
          }
          if (port !== 0) {
            tryListen(0, host)
            return
          }
        }
        reject(err)
      })

      server.listen(port, host, () => {
        const addr = server.address()
        const assignedPort = typeof addr === 'object' && addr ? addr.port : port
        activeServer = server
        currentPort = assignedPort
        currentHost = host
        isServerOwner = true
        resolve({
          port: assignedPort,
          baseUrl: getServerBaseUrl()!,
          close: sessionClose,
        })
      })
    }

    tryListen(preferredPort, preferredHost)
  })
}

/**
 * Stops the running embedded server if active and owned by this process.
 */
export async function stopServer(force = false): Promise<void> {
  if (force) {
    clientCount = 0
  } else if (clientCount > 0) {
    return
  }

  if (!activeServer) {
    if (force) {
      currentPort = null
      currentHost = null
      isServerOwner = false
    }
    return
  }
  if (!isServerOwner && !force) {
    return
  }
  return new Promise((resolve, reject) => {
    activeServer?.close(err => {
      activeServer = null
      currentPort = null
      currentHost = null
      isServerOwner = false
      clientCount = 0
      if (err) reject(err)
      else resolve()
    })
  })
}

/**
 * Runs the download server as a persistent standalone daemon.
 */
export async function runStandaloneServer(options: {
  port?: number
  host?: string
  publicUrl?: string
}): Promise<void> {
  const port = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 4321)
  const host = options.host ?? process.env.HOST ?? '0.0.0.0'
  if (options.publicUrl) {
    setPublicBaseUrl(options.publicUrl)
  }

  const {port: boundPort, baseUrl} = await startServer(port, host)
  console.log(`[yoinks-leech] Dedicated masked download server running on ${host}:${boundPort}`)
  console.log(`[yoinks-leech] Local base URL: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`)
  if (options.publicUrl || process.env.PUBLIC_DOWNLOAD_URL || process.env.YOINKS_PUBLIC_URL) {
    console.log(`[yoinks-leech] Public download base URL: ${baseUrl}`)
  }
  console.log(`[yoinks-leech] Waiting for downloads and TUI sessions. Press Ctrl+C to stop.`)

  const shutdown = async () => {
    console.log('\n[yoinks-leech] Shutting down download server...')
    await stopServer(true)
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return new Promise(() => {})
}

