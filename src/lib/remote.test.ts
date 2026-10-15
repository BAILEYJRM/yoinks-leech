import assert from 'node:assert/strict'
import test from 'node:test'
import {isHeadlessOrRemote, openInBrowser, terminalHyperlink} from './open.js'
import {writeOsc52Clipboard, writeClipboard} from './clipboard.js'

test('terminalHyperlink formats valid OSC 8 hyperlink escape sequences', () => {
  const url = 'https://downloads.example.org/d/abc123xyz'
  const link = terminalHyperlink(url)
  assert.equal(link, `\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`)

  const customText = terminalHyperlink(url, '[⬇ dl]')
  assert.equal(customText, `\u001b]8;;${url}\u0007[⬇ dl]\u001b]8;;\u0007`)
})

test('isHeadlessOrRemote detects ttyd and headless environments', () => {
  const origTtyd = process.env.TTYD
  const origSsh = process.env.SSH_CONNECTION

  try {
    process.env.TTYD = '1'
    assert.equal(isHeadlessOrRemote(), true)

    delete process.env.TTYD
    process.env.SSH_CONNECTION = '10.0.0.1 1234 10.0.0.2 22'
    assert.equal(isHeadlessOrRemote(), true)
  } finally {
    if (origTtyd !== undefined) process.env.TTYD = origTtyd
    else delete process.env.TTYD

    if (origSsh !== undefined) process.env.SSH_CONNECTION = origSsh
    else delete process.env.SSH_CONNECTION
  }
})

test('openInBrowser safely returns false in headless/remote environments without throwing', () => {
  const origTtyd = process.env.TTYD
  try {
    process.env.TTYD = '1'
    const result = openInBrowser('https://example.com/test')
    assert.equal(result, false)
  } finally {
    if (origTtyd !== undefined) process.env.TTYD = origTtyd
    else delete process.env.TTYD
  }
})

test('writeOsc52Clipboard outputs valid OSC 52 base64 sequence to stdout', () => {
  const chunks: string[] = []
  const origWrite = process.stdout.write
  process.stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk))
    return true
  }

  try {
    const text = 'https://downloads.example.com/d/12345'
    writeOsc52Clipboard(text)

    const expectedBase64 = Buffer.from(text).toString('base64')
    const expectedOsc52 = `\u001b]52;c;${expectedBase64}\u0007`
    assert.equal(chunks.some(c => c.includes(expectedOsc52)), true)
  } finally {
    process.stdout.write = origWrite
  }
})

test('writeOsc52Clipboard handles tmux DCS wrapping', () => {
  const chunks: string[] = []
  const origWrite = process.stdout.write
  const origTmux = process.env.TMUX

  process.stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk))
    return true
  }

  try {
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0'
    const text = 'https://example.com/tmux-test'
    writeOsc52Clipboard(text)

    const expectedBase64 = Buffer.from(text).toString('base64')
    const expectedOsc52 = `\u001b]52;c;${expectedBase64}\u0007`
    const expectedWrapped = `\u001bPtmux;\u001b${expectedOsc52}\u001b\\`
    assert.equal(chunks.some(c => c.includes(expectedWrapped)), true)
  } finally {
    process.stdout.write = origWrite
    if (origTmux !== undefined) process.env.TMUX = origTmux
    else delete process.env.TMUX
  }
})
