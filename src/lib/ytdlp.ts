import {spawn, type ChildProcess} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {formatBytes, toPlainText} from './format.js'
import {type Platform} from './platforms.js'

export type VideoInfo = {
  id: string
  title: string
  duration?: number
  uploader?: string
  formats: RawFormat[]
}

type RawFormat = {
  format_id: string
  ext: string
  resolution?: string
  height?: number
  width?: number
  vcodec?: string
  acodec?: string
  filesize?: number
  filesize_approx?: number
  tbr?: number
}

export type DownloadChoice = {
  kind: 'video' | 'audio'
  label: string
  args: string[]
}

const BIN_DIR = path.join(os.homedir(), '.config', 'yoinks', 'bin')
const YTDLP_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

export async function ensureYtDlp(
  onProgress?: (status: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (fs.existsSync(YTDLP_BIN)) return YTDLP_BIN

  fs.mkdirSync(BIN_DIR, {recursive: true})
  onProgress?.('downloading yt-dlp…')

  const url =
    process.platform === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : process.platform === 'darwin'
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'

  const res = await fetch(url, {signal})
  if (!res.ok || !res.body) throw new Error(`failed to download yt-dlp: ${res.statusText}`)

  const file = fs.createWriteStream(YTDLP_BIN)
  const reader = res.body.getReader()

  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      file.write(value)
    }
  } finally {
    file.end()
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(YTDLP_BIN, 0o755)
  }

  return YTDLP_BIN
}

export async function findFfmpeg(): Promise<string | undefined> {
  try {
    const ffmpegStatic = (await import('ffmpeg-static')).default
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic
  } catch {
    // ignore
  }
  return undefined
}

export function probe(
  ytdlp: string,
  url: string,
  signal?: AbortSignal,
): Promise<{info: VideoInfo; infoJsonPath: string}> {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir()
    const jsonPath = path.join(tmpDir, `yoinks-info-${Date.now()}.json`)
    const args = ['--dump-json', '--no-playlist', '--no-warnings', url]

    const child = spawn(ytdlp, args, {signal})
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (signal?.aborted) {
        reject(new Error('Probe aborted.'))
        return
      }
      if (code === 0 && stdout) {
        try {
          fs.writeFileSync(jsonPath, stdout)
          const parsed = JSON.parse(stdout) as VideoInfo
          resolve({info: parsed, infoJsonPath: jsonPath})
        } catch (err) {
          reject(err)
        }
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Probe failed with code ${code}.`))
      }
    })
  })
}

const MAX_VIDEO_CHOICES = 4

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats || []
  const choices: DownloadChoice[] = []

  const audioFormats = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = audioFormats.sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best?.acodec && best.acodec !== 'none'
    const size = (best?.filesize ?? best?.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: [
        '-f',
        `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `audio only · mp3${audioSizeLabel}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    infoJsonPath?: string
    choice: DownloadChoice
    outDir: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args, {signal})
    activeChild = child

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''
    const destinations: string[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          })
        } else if (line.includes('Downloading 1 format(s):')) {
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) destinations.push(target)
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          destinations.push(line.slice('[download] Destination: '.length))
        } else if (path.isAbsolute(line)) {
          filepath = line
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      activeChild = undefined
      if (signal?.aborted) {
        void removePartials(destinations)
        reject(new Error('Download cancelled.'))
        return
      }
      if (code === 0) {
        // Resolve actual on-disk file
        let resolvedPath = filepath

        // 1. Check destinations recorded from Merger / ExtractAudio
        if (destinations.length > 0) {
          const validDest = [...destinations].reverse().find(d => fs.existsSync(d))
          if (validDest) resolvedPath = validDest
        }

        // 2. Check if original filepath exists
        if (!resolvedPath || !fs.existsSync(resolvedPath)) {
          if (filepath) {
            // Trim whitespace before extension on Windows (e.g., "title .mp4" -> "title.mp4")
            const trimmedExt = filepath.replace(/\s+\.([^.]+)$/, '.$1')
            if (fs.existsSync(trimmedExt)) {
              resolvedPath = trimmedExt
            }
          }
        }

        if (resolvedPath && fs.existsSync(resolvedPath)) {
          // Rename file to clean plain text (removes emojis and special chars)
          try {
            const ext = path.extname(resolvedPath)
            const base = path.basename(resolvedPath, ext)
            const plainBase = toPlainText(base)
            if (plainBase && plainBase !== base) {
              const plainPath = path.join(path.dirname(resolvedPath), `${plainBase}${ext}`)
              if (!fs.existsSync(plainPath)) {
                fs.renameSync(resolvedPath, plainPath)
                resolvedPath = plainPath
              }
            }
          } catch {
            // ignore rename errors
          }
          resolve(resolvedPath)
        } else if (filepath) {
          resolve(filepath)
        } else {
          reject(new Error('Download completed but could not locate destination file.'))
        }
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`])
      .map(file => fs.promises.rm(file, {force: true})),
  )
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
