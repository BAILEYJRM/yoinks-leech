import {exec} from 'node:child_process'
import os from 'node:os'

/**
 * Safely opens a URL in the user's default web browser across platforms.
 */
export function openInBrowser(url: string): void {
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
  } catch {
    // ignore open errors
  }
}
