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

export function writeClipboard(text: string): boolean {
  for (const [command, args] of WRITE_COMMANDS) {
    try {
      const res = spawnSync(command, args, {
        input: text,
        encoding: 'utf8',
        timeout: 500,
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      if (res.status === 0) return true
    } catch {
      // try next command
    }
  }
  return false
}
