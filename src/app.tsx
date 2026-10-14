import React, {useCallback, useEffect, useRef, useState} from 'react'
import os from 'node:os'
import path from 'node:path'
import {Box, Text, useApp, useInput, useStdout} from 'ink'
import SelectInput, {type IndicatorProps, type ItemProps} from 'ink-select-input'
import Spinner from 'ink-spinner'
import {FramedInput} from './components/framed-input.js'
import {FullScreen} from './components/fullscreen.js'
import {Logo} from './components/logo.js'
import {Panel} from './components/panel.js'
import {ProgressBar} from './components/progress-bar.js'
import {Shortcuts} from './components/shortcuts.js'
import {TextInput} from './components/text-input.js'
import {clickTargetAt, findFrameRow, frameRowSpan, type ClickTarget} from './lib/click-map.js'
import {writeClipboard} from './lib/clipboard.js'
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatEta,
  formatRemainingTime,
  formatSpeed,
  shortenPath,
  toPlainText,
  truncate,
  wrapText,
} from './lib/format.js'
import {
  checkDownloadQuota,
  cleanMissingRecords,
  generateSessionId,
  getOrCreatePersistentSessionId,
  getSessionQuotaUsage,
  loadHistory,
  loadHistoryRecords,
  saveDownloadRecord,
  type HistoryRecord,
} from './lib/history.js'
import {openInBrowser} from './lib/open.js'
import {detectPlatform, isProbablyUrl, type Platform} from './lib/platforms.js'
import {getMaskedDownloadUrl, setPublicBaseUrl, startServer} from './lib/server.js'
import {useMouseClick} from './lib/use-mouse-click.js'
import {nextThemeMode, ThemeProvider, type ThemeMode, useTheme} from './theme.js'
import {
  buildChoices,
  download,
  ensureYtDlp,
  findFfmpeg,
  probe,
  type DownloadChoice,
  type DownloadProgress,
  type VideoInfo,
} from './lib/ytdlp.js'

const OUT_DIR = path.join(os.homedir(), 'Downloads')
const YOINK_BUTTON = 'yoink'
const DONE_LABEL = '↵ yoink another'
const TAGLINE = 'yoinks-Leech — paste. yoink. done.'
const PAGE_SIZE = 10

const choiceLabel = (choice: DownloadChoice) => `${choice.kind === 'audio' ? '♪ ' : '▶ '}${choice.label}`

function ChoiceIndicator({isSelected}: IndicatorProps) {
  const theme = useTheme()
  return (
    <Box marginRight={1}>
      <Text color={theme.primary}>{isSelected ? '❯' : ' '}</Text>
    </Box>
  )
}

function ChoiceItem({isSelected, label}: ItemProps) {
  const theme = useTheme()
  return (
    <Text color={theme.primary} bold={isSelected}>
      {label}
    </Text>
  )
}

const Gap = ({lines = 1}: {lines?: number}) => (
  <Box flexDirection="column" flexShrink={0}>
    {Array.from({length: lines}, (_, i) => (
      <Text key={i}> </Text>
    ))}
  </Box>
)

function partLabel(progress: DownloadProgress): string {
  return progress.totalParts > 1 ? `part ${progress.part + 1}/${progress.totalParts}  ` : ''
}

function downloadMeta(progress: DownloadProgress): string {
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  const eta = progress.eta ? `${formatEta(progress.eta)} left` : ''
  return `${partLabel(progress)}${speed.padStart(10)}  ${eta.padEnd(12)}`
}

function indeterminateMeta(progress: DownloadProgress): string {
  const bytes = formatBytes(progress.downloadedBytes)
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  return `${partLabel(progress)}${bytes.padStart(8)}  ${speed.padEnd(10)}`
}

export type Outcome = {filepath?: string}

type Phase =
  | {name: 'input'; warning?: string}
  | {name: 'probing'; status: string}
  | {name: 'picking'}
  | {
      name: 'downloading'
      choice: DownloadChoice
      progress?: DownloadProgress
      processing: boolean
      refreshing?: boolean
    }
  | {name: 'done'; filepath: string; maskedToken?: string; copied?: boolean}
  | {name: 'history'; selectedIndex: number; copied?: boolean; notice?: string}
  | {name: 'error'; message: string}

const HINTS: Record<Phase['name'], Array<[string, string]>> = {
  input: [
    ['↵', 'yoink'],
    ['^c', 'quit'],
  ],
  probing: [
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  picking: [
    ['↑↓', 'choose'],
    ['↵', 'yoink'],
    ['esc', 'back'],
    ['^c', 'quit'],
  ],
  downloading: [
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  done: [
    ['o', 'download via link'],
    ['c', 'copy link'],
    ['h', 'session history'],
    ['↵', 'yoink another'],
    ['^c', 'quit'],
  ],
  history: [
    ['↑↓', 'choose'],
    ['←→', 'page'],
    ['↵', 'download file'],
    ['c', 'copy link'],
    ['x', 'clean missing'],
    ['esc', 'back'],
    ['^c', 'quit'],
  ],
  error: [
    ['↵', 'try again'],
    ['^c', 'quit'],
  ],
}

type AppProps = {
  initialUrl?: string
  clipboardUrl?: string
  initialThemeMode?: ThemeMode
  port?: number
  host?: string
  publicUrl?: string
  sessionId?: string
  onOutcome: (outcome: Outcome) => void
}

export function App({initialThemeMode = 'auto', ...props}: AppProps) {
  const [themeMode, setThemeMode] = useState(initialThemeMode)
  const cycleTheme = useCallback(() => {
    setThemeMode(nextThemeMode)
  }, [])

  return (
    <ThemeProvider mode={themeMode}>
      <AppContent {...props} cycleTheme={cycleTheme} />
    </ThemeProvider>
  )
}

function AppContent({
  initialUrl,
  clipboardUrl,
  port,
  host,
  publicUrl,
  sessionId: customSessionId,
  onOutcome,
  cycleTheme,
}: {
  initialUrl?: string
  clipboardUrl?: string
  port?: number
  host?: string
  publicUrl?: string
  sessionId?: string
  onOutcome: (outcome: Outcome) => void
  cycleTheme: () => void
}) {
  const theme = useTheme()
  const {exit} = useApp()
  const {stdout} = useStdout()
  const sessionIdRef = useRef<string>(customSessionId || getOrCreatePersistentSessionId())
  const [url, setUrl] = useState(initialUrl ?? '')
  const [urlInput, setUrlInput] = useState('')
  const [history, setHistory] = useState(() => loadHistory(sessionIdRef.current))
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>(() =>
    loadHistoryRecords(sessionIdRef.current),
  )
  const [platform, setPlatform] = useState<Platform>()
  const [info, setInfo] = useState<VideoInfo>()
  const [choices, setChoices] = useState<DownloadChoice[]>([])
  const ytdlpRef = useRef('')
  const highlightRef = useRef(0)
  const infoJsonRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>(initialUrl ? {name: 'probing', status: 'warming up…'} : {name: 'input'})

  // Auto-start embedded masked download server or adopt existing shared daemon
  useEffect(() => {
    if (publicUrl) setPublicBaseUrl(publicUrl)
    void startServer(port ?? 4321, host ?? process.env.HOST ?? '0.0.0.0')
  }, [port, host, publicUrl])

  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80
  const boxWidth = Math.max(14, Math.min(64, columns - 6))
  const historyBoxWidth = Math.max(20, Math.min(78, columns - 4))
  const contentWidth = Math.max(10, Math.min(columns - 4, 78))

  const startProbe = useCallback(async (targetUrl: string) => {
    const controller = new AbortController()
    abortRef.current = controller
    setPlatform(detectPlatform(targetUrl))
    setPhase({name: 'probing', status: 'warming up…'})
    try {
      const ytdlp =
        ytdlpRef.current ||
        (await ensureYtDlp(status => setPhase({name: 'probing', status}), controller.signal))
      ytdlpRef.current = ytdlp
      if (controller.signal.aborted) return
      setPhase({name: 'probing', status: 'fetching video info…'})
      const {info: videoInfo, infoJsonPath} = await probe(ytdlp, targetUrl, controller.signal)
      if (controller.signal.aborted) return
      infoJsonRef.current = infoJsonPath
      setInfo(videoInfo)
      setChoices(buildChoices(videoInfo))
      highlightRef.current = 0
      setPhase({name: 'picking'})
    } catch (error) {
      if (controller.signal.aborted) return
      setPhase({name: 'error', message: error instanceof Error ? error.message : String(error)})
    }
  }, [])

  useEffect(() => {
    if (initialUrl) void startProbe(initialUrl)
  }, [initialUrl, startProbe])

  const resetToInput = useCallback(() => {
    setUrl('')
    setUrlInput('')
    setPlatform(undefined)
    setInfo(undefined)
    setChoices([])
    setHistoryRecords(loadHistoryRecords(sessionIdRef.current))
    setPhase({name: 'input'})
  }, [])

  const cancelRun = useCallback(() => {
    abortRef.current?.abort()
    resetToInput()
    setUrlInput(url)
  }, [resetToInput, url])

  const handleDownloadByRecord = useCallback((record: HistoryRecord) => {
    if (record.fileExists === false) {
      setPhase(p => (p.name === 'history' ? {...p, notice: `✗ File "${record.filename}" is no longer on disk.`} : p))
      return
    }
    const downloadUrl = getMaskedDownloadUrl(record.maskedToken)
    openInBrowser(downloadUrl)
  }, [])

  useInput(
    (input, key) => {
      if (key.ctrl && input === 't') {
        cycleTheme()
        return
      }

      // History phase shortcuts (including pagination)
      if (phase.name === 'history') {
        const totalItems = historyRecords.length
        const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1
        const currentPage = Math.floor(phase.selectedIndex / PAGE_SIZE)

        if (key.upArrow) {
          setPhase(p => (p.name === 'history' ? {...p, selectedIndex: Math.max(0, p.selectedIndex - 1), copied: false, notice: undefined} : p))
          return
        }
        if (key.downArrow) {
          setPhase(p =>
            p.name === 'history'
              ? {...p, selectedIndex: Math.min(Math.max(0, historyRecords.length - 1), p.selectedIndex + 1), copied: false, notice: undefined}
              : p,
          )
          return
        }
        // Left arrow / Previous page
        if (key.leftArrow) {
          const prevPage = Math.max(0, currentPage - 1)
          setPhase(p => (p.name === 'history' ? {...p, selectedIndex: prevPage * PAGE_SIZE, copied: false, notice: undefined} : p))
          return
        }
        // Right arrow / Next page
        if (key.rightArrow) {
          const nextPage = Math.min(totalPages - 1, currentPage + 1)
          setPhase(p => (p.name === 'history' ? {...p, selectedIndex: nextPage * PAGE_SIZE, copied: false, notice: undefined} : p))
          return
        }
        if (key.return) {
          const selected = historyRecords[phase.selectedIndex]
          if (selected) handleDownloadByRecord(selected)
          return
        }
        if (input.toLowerCase() === 'c') {
          const selected = historyRecords[phase.selectedIndex]
          if (selected) {
            writeClipboard(getMaskedDownloadUrl(selected.maskedToken))
            setPhase(p => (p.name === 'history' ? {...p, copied: true, notice: undefined} : p))
          }
          return
        }
        if (input.toLowerCase() === 'x') {
          const cleaned = cleanMissingRecords(sessionIdRef.current)
          setHistoryRecords(cleaned)
          setPhase(p => (p.name === 'history' ? {...p, selectedIndex: 0, notice: '✓ Cleaned up missing files.'} : p))
          return
        }
        if (key.escape) {
          resetToInput()
          return
        }
      }

      // Open history from input or done with 'h'
      if ((phase.name === 'input' || phase.name === 'done') && input.toLowerCase() === 'h') {
        const records = loadHistoryRecords(sessionIdRef.current)
        setHistoryRecords(records)
        setPhase({name: 'history', selectedIndex: 0})
        return
      }

      // Done screen shortcuts
      if (phase.name === 'done') {
        if (input.toLowerCase() === 'o' && phase.maskedToken) {
          openInBrowser(getMaskedDownloadUrl(phase.maskedToken))
          return
        }
        if (input.toLowerCase() === 'c' && phase.maskedToken) {
          writeClipboard(getMaskedDownloadUrl(phase.maskedToken))
          setPhase(p => (p.name === 'done' ? {...p, copied: true} : p))
          return
        }
      }

      if (key.escape && (phase.name === 'picking' || phase.name === 'error' || phase.name === 'done')) resetToInput()
      if (key.escape && (phase.name === 'probing' || phase.name === 'downloading')) cancelRun()
      if (key.return && (phase.name === 'error' || phase.name === 'done')) resetToInput()
    },
    {isActive: Boolean(process.stdin.isTTY)},
  )

  const handleUrlSubmit = (value: string) => {
    const trimmed = value.trim()
    if (!isProbablyUrl(trimmed)) {
      setPhase({name: 'input', warning: 'that doesn’t look like a link — paste a full url'})
      return
    }

    // Check 10GB / 3-day quota usage
    const quotaCheck = checkDownloadQuota(undefined, sessionIdRef.current)
    if (!quotaCheck.allowed) {
      setPhase({name: 'error', message: quotaCheck.reason || '3-day download quota exceeded.'})
      return
    }

    setUrl(trimmed)
    void startProbe(trimmed)
  }

  const clipboardOffered = Boolean(clipboardUrl) && urlInput === ''
  const clipboardAccepted = Boolean(clipboardUrl) && urlInput === clipboardUrl

  const handlePick = (item: {value: number}) => {
    const choice = choices[item.value]
    if (!choice) return

    // Verify download quota before starting
    const quotaCheck = checkDownloadQuota(undefined, sessionIdRef.current)
    if (!quotaCheck.allowed) {
      setPhase({name: 'error', message: quotaCheck.reason || 'Download quota exceeded for 3-day window.'})
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setPhase({name: 'downloading', choice, processing: false})
    void (async () => {
      const handlers = {
        onProgress: (progress: DownloadProgress) =>
          setPhase(prev => (prev.name === 'downloading' ? {...prev, progress, processing: false} : prev)),
        onProcessing: () =>
          setPhase(prev => (prev.name === 'downloading' ? {...prev, processing: true} : prev)),
      }
      try {
        const ffmpegLocation = await findFfmpeg()
        const base = {ytdlp: ytdlpRef.current, ffmpegLocation, url, choice, outDir: OUT_DIR}
        let filepath: string
        try {
          filepath = await download({...base, infoJsonPath: infoJsonRef.current}, handlers, controller.signal)
        } catch (error) {
          if (controller.signal.aborted) throw error
          setPhase(prev =>
            prev.name === 'downloading' ? {...prev, progress: undefined, refreshing: true} : prev,
          )
          filepath = await download(base, handlers, controller.signal)
        }
        onOutcome({filepath})

        // Save record scoped to active user session with 72h TTL
        const savedRecord = saveDownloadRecord({
          url,
          title: info?.title || path.basename(filepath),
          filepath,
          sessionId: sessionIdRef.current,
          platform: platform?.label,
          choiceLabel: choice.label,
        })
        setHistory(loadHistory(sessionIdRef.current))
        setHistoryRecords(loadHistoryRecords(sessionIdRef.current))
        setPhase({name: 'done', filepath, maskedToken: savedRecord.maskedToken})
      } catch (error) {
        if (controller.signal.aborted) return
        setPhase({name: 'error', message: error instanceof Error ? error.message : String(error)})
      }
    })()
  }

  let hints: Array<[string, string]> = [...HINTS[phase.name], ['^t', `theme:${theme.mode}`]]
  if (phase.name === 'input') {
    const records = historyRecords.length > 0 ? historyRecords : loadHistoryRecords(sessionIdRef.current)
    if (records.length > 0) {
      hints = [hints[0]!, ['h', 'history'], ...hints.slice(1)]
    }
  }

  const hintAction = (key: string): (() => void) | undefined => {
    if (key === '^c') return () => exit()
    if (key === '^t') return cycleTheme
    if (key === 'esc') return phase.name === 'probing' || phase.name === 'downloading' ? cancelRun : resetToInput
    if (key === 'h') {
      return () => {
        setHistoryRecords(loadHistoryRecords(sessionIdRef.current))
        setPhase({name: 'history', selectedIndex: 0})
      }
    }
    if (key === '←→' && phase.name === 'history') {
      return () => {
        const totalItems = historyRecords.length
        const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1
        const currentPage = Math.floor(phase.selectedIndex / PAGE_SIZE)
        const nextPage = (currentPage + 1) % totalPages
        setPhase(p => (p.name === 'history' ? {...p, selectedIndex: nextPage * PAGE_SIZE, copied: false, notice: undefined} : p))
      }
    }
    if (key === 'x' && phase.name === 'history') {
      return () => {
        const cleaned = cleanMissingRecords(sessionIdRef.current)
        setHistoryRecords(cleaned)
        setPhase(p => (p.name === 'history' ? {...p, selectedIndex: 0, notice: '✓ Cleaned up missing files.'} : p))
      }
    }
    if (key === 'o' && phase.name === 'done' && phase.maskedToken) {
      return () => openInBrowser(getMaskedDownloadUrl(phase.maskedToken!))
    }
    if (key === 'c') {
      if (phase.name === 'done' && phase.maskedToken) {
        return () => {
          writeClipboard(getMaskedDownloadUrl(phase.maskedToken!))
          setPhase(p => (p.name === 'done' ? {...p, copied: true} : p))
        }
      }
      if (phase.name === 'history') {
        return () => {
          const selected = historyRecords[phase.selectedIndex]
          if (selected) {
            writeClipboard(getMaskedDownloadUrl(selected.maskedToken))
            setPhase(p => (p.name === 'history' ? {...p, copied: true, notice: undefined} : p))
          }
        }
      }
    }
    if (key === '↵') {
      if (phase.name === 'input') return () => handleUrlSubmit(urlInput)
      if (phase.name === 'picking') return () => handlePick({value: highlightRef.current})
      if (phase.name === 'history') {
        const selected = historyRecords[phase.selectedIndex]
        if (selected) return () => handleDownloadByRecord(selected)
      }
      if (phase.name === 'error' || phase.name === 'done') return resetToInput
    }
    return undefined
  }

  const clickTargets: ClickTarget[] = []
  if (phase.name === 'input') {
    clickTargets.push({match: `  ${YOINK_BUTTON}  `, padY: 1, action: () => handleUrlSubmit(urlInput)})
  }
  if (phase.name === 'picking') {
    for (const [index, choice] of choices.entries()) {
      clickTargets.push({match: choiceLabel(choice), action: () => handlePick({value: index})})
    }
  }
  if (phase.name === 'done') {
    clickTargets.push({match: DONE_LABEL, padX: 4, padY: 1, action: resetToInput})
    if (phase.maskedToken) {
      const maskedUrl = getMaskedDownloadUrl(phase.maskedToken)
      clickTargets.push({match: maskedUrl, action: () => openInBrowser(maskedUrl)})
      clickTargets.push({match: 'download via link', action: () => openInBrowser(maskedUrl)})
      clickTargets.push({
        match: 'copy link',
        action: () => {
          writeClipboard(maskedUrl)
          setPhase(p => (p.name === 'done' ? {...p, copied: true} : p))
        },
      })
    }
  }
  if (phase.name === 'history') {
    const currentPage = Math.floor(phase.selectedIndex / PAGE_SIZE)
    const pageStart = currentPage * PAGE_SIZE
    const pageItems = historyRecords.slice(pageStart, pageStart + PAGE_SIZE)

    for (let i = 0; i < pageItems.length; i++) {
      const record = pageItems[i]!
      const actualIndex = pageStart + i
      const numPrefix = `${actualIndex + 1}. `
      const plainTitle = toPlainText(record.title || record.filename)
      const availableTitleLength = Math.max(10, historyBoxWidth - numPrefix.length - 42)
      const titleText = truncate(plainTitle, availableTitleLength)
      const fullTitle = `${numPrefix}${titleText}`

      clickTargets.push({
        match: fullTitle,
        action: () => {
          setPhase(p => (p.name === 'history' ? {...p, selectedIndex: actualIndex, notice: undefined} : p))
          handleDownloadByRecord(record)
        },
      })
    }
  }

  for (const [key, label] of hints) {
    const action = hintAction(key)
    if (action) clickTargets.push({match: `${key} ${label}`, action})
  }

  useMouseClick(
    (x, y) => {
      const taglineRow = findFrameRow(TAGLINE)
      if (taglineRow > 3 && y - 1 >= taglineRow - 4 && y - 1 <= taglineRow - 2) {
        const span = frameRowSpan(y - 1)
        if (span && x >= span[0] - 1 && x <= span[1] + 1) {
          if (phase.name === 'probing' || phase.name === 'downloading') cancelRun()
          else if (phase.name !== 'input') resetToInput()
          return
        }
      }
      clickTargetAt(x, y, clickTargets)?.action()
    },
    Boolean(process.stdin.isTTY),
  )

  const quota = getSessionQuotaUsage(sessionIdRef.current)

  return (
    <FullScreen>
      <Logo />
      {phase.name === 'history' ? null : <Gap />}
      <Text color={theme.primary}>{TAGLINE}</Text>
      <Text color={theme.gray} dimColor={theme.dimSecondary}>youtube · x · instagram · threads · tiktok · +1800 more</Text>
      <Gap />

      {phase.name === 'input' && (
        <Box flexDirection="column" alignItems="center">
          <FramedInput title="Paste a link" width={boxWidth} button={YOINK_BUTTON}>
            <TextInput
              value={urlInput}
              onChange={setUrlInput}
              onSubmit={handleUrlSubmit}
              placeholder="https://youtube.com/watch?v=…"
              width={boxWidth - 6}
              history={history}
              submitOnPaste={isProbablyUrl}
              onTab={() => {
                if (clipboardOffered) setUrlInput(clipboardUrl!)
              }}
            />
          </FramedInput>
          {phase.warning ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>✗ {phase.warning}</Text>
          ) : clipboardOffered ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>link in your clipboard — ⇥ to paste it</Text>
          ) : clipboardAccepted ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>from your clipboard — ↵ to yoink it</Text>
          ) : (
            <Box flexDirection="column" alignItems="center">
              <Text color={theme.gray} dimColor={theme.dimSecondary}>
                3-day Quota: {formatBytes(quota.usedBytes) || '0 B'} / 10 GB ({Math.round(quota.percent * 100)}%) · press “h” for history
              </Text>
            </Box>
          )}
        </Box>
      )}

      {phase.name === 'history' && (
        <Box flexDirection="column" alignItems="center" width={historyBoxWidth}>
          {(() => {
            const totalItems = historyRecords.length
            const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1
            const currentPage = Math.floor(phase.selectedIndex / PAGE_SIZE)
            const pageStart = currentPage * PAGE_SIZE
            const pageItems = historyRecords.slice(pageStart, pageStart + PAGE_SIZE)

            const panelTitle = `Session Downloads · Page ${currentPage + 1}/${totalPages} (${totalItems}/30 max)`

            return (
              <Panel title={panelTitle} width={historyBoxWidth}>
                {totalItems === 0 ? (
                  <Box paddingY={1} justifyContent="center">
                    <Text color={theme.gray} dimColor={theme.dimSecondary}>No downloads in your active session yet.</Text>
                  </Box>
                ) : (
                  <Box flexDirection="column">
                    {pageItems.map((record, index) => {
                      const actualIndex = pageStart + index
                      const isSelected = actualIndex === phase.selectedIndex
                      const numPrefix = `${actualIndex + 1}. `
                      // Single-line compact layout so 10 items fit comfortably on 1 line with shortcuts visible
                      const plainTitle = toPlainText(record.title || record.filename)
                      const availableTitleLength = Math.max(10, historyBoxWidth - numPrefix.length - 42)
                      const titleText = truncate(plainTitle, availableTitleLength)
                      const fullTitle = `${numPrefix}${titleText}`
                      const sizeStr = record.filesize ? formatBytes(record.filesize) : ''
                      const remainingStr = record.expiresAt ? formatRemainingTime(record.expiresAt) : '72h'
                      const metaParts = [record.platform, sizeStr, remainingStr].filter(Boolean).join(' · ')
                      const isMissing = record.fileExists === false

                      return (
                        <Box key={record.id || actualIndex} height={1} justifyContent="space-between" width={historyBoxWidth - 4}>
                          <Box flexShrink={1}>
                            <Text color={theme.primary} bold={isSelected} wrap="truncate-end">
                              {isSelected ? '❯ ' : '  '}
                              {fullTitle}
                            </Text>
                          </Box>
                          <Box flexShrink={0} paddingLeft={1}>
                            <Text color={theme.gray} dimColor={theme.dimSecondary} wrap="truncate-end">
                              {metaParts}  
                            </Text>
                            <Text color={isMissing ? theme.gray : theme.primary} dimColor={isMissing} bold={isSelected}>
                              {isMissing ? '[missing]' : '[⬇ dl]'}
                            </Text>
                          </Box>
                        </Box>
                      )
                    })}
                  </Box>
                )}
              </Panel>
            )
          })()}

          {phase.notice ? (
            <Box marginTop={0}>
              <Text color={theme.primary} bold>{phase.notice}</Text>
            </Box>
          ) : phase.copied ? (
            <Box marginTop={0}>
              <Text color={theme.primary} bold>✓ Masked download link copied to clipboard!</Text>
            </Box>
          ) : (
            <Box marginTop={0} flexDirection="column" alignItems="center">
              <Text color={theme.gray} dimColor={theme.dimSecondary}>
                Quota (3d): {formatBytes(quota.usedBytes) || '0 B'} / 10 GB ({Math.round(quota.percent * 100)}%) · 72h auto-cleanup
              </Text>
            </Box>
          )}
        </Box>
      )}

      {phase.name === 'probing' && (
        <Box flexDirection="column" alignItems="center">
          <FramedInput title={platform ? platform.label : 'Paste a link'} width={boxWidth} button={YOINK_BUTTON} buttonDim>
            <Text color={theme.gray} dimColor={theme.dimSecondary}>{url.length > boxWidth - 8 ? `${url.slice(0, boxWidth - 9)}…` : url}</Text>
          </FramedInput>
        </Box>
      )}

      {phase.name === 'picking' && platform && (
        <Box width={contentWidth}>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} paddingTop={1} paddingRight={3}>
            {wrapText(info?.title ?? '', Math.max(10, contentWidth - 41)).map((line, index) => (
              <Text key={index} bold color={theme.primary}>
                {line}
              </Text>
            ))}
            <Gap />
            <Text color={theme.gray} dimColor={theme.dimSecondary}>
              ▸ {platform.label}
              {info?.duration ? ` · ${formatDuration(info.duration)}` : ''}
              {info?.uploader ? ` · ${info.uploader}` : ''}
            </Text>
          </Box>
          <Panel title="Download" width={38}>
            <SelectInput
              indicatorComponent={ChoiceIndicator}
              itemComponent={ChoiceItem}
              items={choices.map((choice, index) => ({
                key: String(index),
                label: choiceLabel(choice),
                value: index,
              }))}
              onSelect={handlePick}
              onHighlight={item => (highlightRef.current = item.value)}
            />
          </Panel>
        </Box>
      )}

      {phase.name === 'downloading' && (
        <Box flexDirection="column" alignItems="center">
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {info?.title ? `${truncate(info.title, 42)} · ` : ''}
            {phase.choice.label}
          </Text>
          <Gap />
          {phase.processing ? (
            <>
              <ProgressBar percent={1} />
              <Gap />
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}> processing…</Text>
              </Text>
            </>
          ) : phase.progress?.totalBytes ? (
            <>
              <ProgressBar percent={phase.progress.downloadedBytes / phase.progress.totalBytes} />
              <Gap />
              <Text color={theme.gray} dimColor={theme.dimSecondary}>{downloadMeta(phase.progress)}</Text>
            </>
          ) : phase.progress ? (
            <>
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}> downloading…</Text>
              </Text>
              <Gap />
              <Text color={theme.gray} dimColor={theme.dimSecondary}>{indeterminateMeta(phase.progress)}</Text>
            </>
          ) : (
            <>
              <ProgressBar percent={0} />
              <Gap />
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}>
                  {phase.refreshing ? ' link expired — grabbing a fresh one…' : ' starting download…'}
                </Text>
              </Text>
            </>
          )}
        </Box>
      )}

      {phase.name === 'done' && (
        <Box flexDirection="column" alignItems="center">
          <Text>
            <Text bold color={theme.primary}>✓ yoinked! </Text>
            <Text color={theme.primary}>find your file in:</Text>
          </Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{shortenPath(phase.filepath, os.homedir(), 60)}</Text>
          
          {phase.maskedToken ? (
            <>
              <Gap lines={1} />
              <Box flexDirection="column" alignItems="center">
                <Text color={theme.gray} dimColor={theme.dimSecondary}>Masked Direct Download (72h Ephemeral):</Text>
                <Text color={theme.primary} bold>{getMaskedDownloadUrl(phase.maskedToken)}</Text>
                {phase.copied ? (
                  <Text color={theme.primary}>✓ Link copied to clipboard!</Text>
                ) : null}
              </Box>
            </>
          ) : null}

          <Gap />
          <Box
            borderStyle="round"
            borderColor={theme.gray}
            borderDimColor={theme.dimSecondary}
            borderBackgroundColor={theme.background}
            paddingX={3}
          >
            <Text bold color={theme.primary}>{DONE_LABEL}</Text>
          </Box>
        </Box>
      )}

      {phase.name === 'error' && (
        <Box flexDirection="column" alignItems="center" width={Math.max(10, Math.min(columns - 6, 72))}>
          <Text bold color={theme.primary}>✗ {phase.message}</Text>
        </Box>
      )}

      {hints.length > 0 ? (
        <Box marginTop={1} flexShrink={0}>
          <Shortcuts
            items={hints}
            leading={
              phase.name === 'probing' ? (
                <Text>
                  <Text color={theme.primary}>
                    <Spinner type="dots" />
                  </Text>
                  <Text color={theme.gray} dimColor={theme.dimSecondary}> {phase.status}</Text>
                </Text>
              ) : undefined
            }
          />
        </Box>
      ) : null}
    </FullScreen>
  )
}
