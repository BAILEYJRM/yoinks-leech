import React from 'react'
import {createRequire} from 'node:module'
import {render} from 'ink'
import {App, type Outcome} from './app.js'
import {captureFrames} from './lib/click-map.js'
import {parseArgs} from './lib/args.js'
import {readClipboard} from './lib/clipboard.js'
import {isProbablyUrl} from './lib/platforms.js'
import {runStandaloneServer, setPublicBaseUrl, stopServer} from './lib/server.js'

// read at runtime from the shipped package.json so npm version bumps
// can't drift from a hardcoded constant
const VERSION: string = createRequire(import.meta.url)('../package.json').version

const HELP = `
  yoinks-Leech — yoink any video. paste. yoink. done.

  Usage
    $ yoinks-leech [url]
    $ yoinks-leech --serve [options]
    $ yoinks [url]

  Examples
    $ yoinks-leech https://youtu.be/dQw4w9WgXcQ
    $ yoinks-leech --serve --port 4321 --host 0.0.0.0
    $ yoinks-leech                 (prompts for a url)

  Options
    --theme <mode>      use auto, light, or dark for this run
    -s, --serve         run the dedicated masked download server daemon
    -p, --port <port>   port for the download server (default: 4321)
    --host <host>       host to bind the download server (default: 0.0.0.0)
    --public-url <url>  public download base URL (e.g. https://downloads.dominio.com)
    -h, --help          show this help
    -v, --version       show version

  Features
    • Download videos from YouTube, X, Instagram, Threads, TikTok & 1800+ sites.
    • Built-in Session History with direct masked downloads.
    • Ephemeral files with 72-hour auto-expiration.
    • Embedded protected HTTP server (hides server paths & internal addresses).
    • Decoupled server mode for multi-user Docker & Cloudflare Tunnel deployments.

  Downloads are saved to ~/Downloads.
`

const args = parseArgs(process.argv.slice(2))

if (args.error) {
  console.error(`yoinks-Leech: ${args.error}\nTry “yoinks-leech --help” for usage.`)
  process.exit(1)
}

if (args.help) {
  console.log(HELP)
  process.exit(0)
}

if (args.version) {
  console.log(VERSION)
  process.exit(0)
}

if (args.serve) {
  await runStandaloneServer({
    port: args.port,
    host: args.host,
    publicUrl: args.publicUrl,
  })
  process.exit(0)
}

if (args.publicUrl) {
  setPublicBaseUrl(args.publicUrl)
}

const initialUrl = args.initialUrl
const initialThemeMode = args.themeMode ?? 'auto'

const isTTY = Boolean(process.stdout.isTTY)

// no url given — offer the clipboard url (⇥ to paste) when it already holds one
let clipboardUrl: string | undefined
if (!initialUrl && isTTY) {
  const clipped = readClipboard().trim()
  // reject multi-line clipboard content — new URL() silently strips newlines
  if (clipped && !/\s/.test(clipped) && isProbablyUrl(clipped)) clipboardUrl = clipped
}
const enterAltScreen = () => process.stdout.write('\x1b[?1049h\x1b[H')
// also switch mouse tracking off — a crash can skip React effect cleanup
const leaveAltScreen = () => process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')

if (isTTY) {
  enterAltScreen()
  process.on('exit', () => {
    leaveAltScreen()
    void stopServer()
  })
  // restore the terminal BEFORE a crash prints, or the stack trace is
  // wiped along with the alternate screen and the app looks like it
  // silently quit
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      leaveAltScreen()
      void stopServer()
      console.error(error)
      process.exit(1)
    })
  }
}

let outcome: Outcome = {}
const {waitUntilExit} = render(
  <App
    initialUrl={initialUrl}
    clipboardUrl={clipboardUrl}
    initialThemeMode={initialThemeMode}
    port={args.port}
    host={args.host}
    publicUrl={args.publicUrl}
    onOutcome={result => (outcome = result)}
  />,
  // keep a copy of every frame so clicks can be hit-tested against it
  {stdout: captureFrames(process.stdout)},
)

await waitUntilExit()

if (isTTY) leaveAltScreen()
await stopServer()

if (outcome.filepath) {
  console.log(`✓ yoinked → ${outcome.filepath}`)
}
