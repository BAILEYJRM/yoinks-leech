import {execFileSync, spawnSync} from 'node:child_process'

const READ_COMMANDS: Array<[string, string[]]> =
  process.platform === 'darwin'
    ? [['pbpaste', []]]
    : process.platform === 'win32'
      ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
      : [
          ['wl-paste', ['--no-newline']],
          ['xclip', ['-selection', 'clipboard', '-o']],
          ['xsel', ['--clipboard', '--output']],
        ]

const WRITE_COMMANDS: Array<[string, string[]]> =
  process.platform === 'darwin'
    ? [['pbcopy', []]]
    : process.platform === 'win32'
      ? [['clip', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ]

export function readClipboard(): string {
  for (const [command, args] of READ_COMMANDS) {
    try {
      return execFileSync(command, args, {encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore']})
    } catch {
      // tool missing or clipboard empty — try the next one
    }
  }
  return ''
}

/**
 * Emits an OSC 52 escape sequence to the terminal stdout.
 * Supported by xterm.js (ttyd), Windows Terminal, iTerm2, Alacritty, Kitty, WezTerm, etc.
 * Copies text directly into the client machine's browser/system clipboard from remote environments.
 */
export function writeOsc52Clipboard(text: string): void {
  try {
    if (!process.stdout || typeof process.stdout.write !== 'function') return
    const base64 = Buffer.from(text, 'utf8').toString('base64')
    const osc52 = `\u001b]52;c;${base64}\u0007`
    if (process.env.TMUX) {
      process.stdout.write(`\u001bPtmux;\u001b${osc52}\u001b\\`)
    } else {
      process.stdout.write(osc52)
    }
  } catch {
    // ignore stdout errors
  }
}

export function writeClipboard(text: string): boolean {
  // Always emit OSC 52 so remote/ttyd/containerized terminal clipboards receive it
  writeOsc52Clipboard(text)

  let localSuccess = false
  for (const [command, args] of WRITE_COMMANDS) {
    try {
      const res = spawnSync(command, args, {
        input: text,
        encoding: 'utf8',
        timeout: 500,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      if (res.status === 0) {
        localSuccess = true
        break
      }
    } catch {
      // try next command
    }
  }
  return localSuccess
}

