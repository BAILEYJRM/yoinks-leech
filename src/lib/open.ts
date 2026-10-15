import {exec} from 'node:child_process'
import os from 'node:os'

/**
 * Checks whether the current process is running in a headless or remote terminal environment
 * where local desktop browser commands (like xdg-open) cannot open a window.
 */
export function isHeadlessOrRemote(): boolean {
  if (process.platform === 'linux') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return true
    }
  }
  if (process.env.TTYD || process.env.SSH_CONNECTION || process.env.SSH_CLIENT) {
    return true
  }
  return false
}

/**
 * Generates an OSC 8 terminal hyperlink escape sequence.
 * Modern terminal emulators (xterm.js, ttyd, Windows Terminal, iTerm2, Kitty, Alacritty, GNOME Terminal)
 * allow users to click the link directly in their browser.
 */
export function terminalHyperlink(url: string, text: string = url): string {
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`
}

/**
 * Safely opens a URL in the user's default web browser across platforms.
 * Returns true if a system open command was invoked, or false if headless/remote.
 */
export function openInBrowser(url: string): boolean {
  if (isHeadlessOrRemote()) {
    return false
  }

  const platform = os.platform()
  let command: string

  if (platform === 'win32') {
    // start command in windows cmd needs an empty title argument if first arg has quotes
    command = `start "" "${url}"`
  } else if (platform === 'darwin') {
    command = `open "${url}"`
  } else {
    command = `xdg-open "${url}"`
  }

  try {
    exec(command, () => {
      // fire and forget
    })
    return true
  } catch {
    // ignore open errors
    return false
  }
}

