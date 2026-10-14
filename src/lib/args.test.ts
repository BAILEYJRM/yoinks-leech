import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from './args.js'
import {isThemeMode, nextThemeMode, themeFor} from '../theme.js'

test('parses a url and a spaced theme option without confusing the value for the url', () => {
  assert.deepEqual(parseArgs(['--theme', 'light', 'https://example.com/video']), {
    help: false,
    version: false,
    serve: false,
    themeMode: 'light',
    initialUrl: 'https://example.com/video',
  })
})

test('parses an equals-style theme option after the url', () => {
  assert.deepEqual(parseArgs(['https://example.com/video', '--theme=dark']), {
    help: false,
    version: false,
    serve: false,
    themeMode: 'dark',
    initialUrl: 'https://example.com/video',
  })
})

test('parses custom port options', () => {
  assert.deepEqual(parseArgs(['--port', '8080', 'https://example.com/video']), {
    help: false,
    version: false,
    serve: false,
    port: 8080,
    initialUrl: 'https://example.com/video',
  })

  assert.deepEqual(parseArgs(['-p', '9000']), {
    help: false,
    version: false,
    serve: false,
    port: 9000,
    initialUrl: undefined,
  })
})

test('parses serve, host, and public-url options', () => {
  assert.deepEqual(parseArgs(['--serve', '--host', '0.0.0.0', '--public-url', 'https://downloads.example.com']), {
    help: false,
    version: false,
    serve: true,
    host: '0.0.0.0',
    publicUrl: 'https://downloads.example.com',
    initialUrl: undefined,
  })

  assert.deepEqual(parseArgs(['-s', '--host=127.0.0.1', '--public-url=https://dl.example.com']), {
    help: false,
    version: false,
    serve: true,
    host: '127.0.0.1',
    publicUrl: 'https://dl.example.com',
    initialUrl: undefined,
  })
})

test('rejects missing, invalid, and unknown options', () => {
  assert.match(parseArgs(['--theme']).error ?? '', /needs a value/)
  assert.match(parseArgs(['--theme', 'sepia']).error ?? '', /unknown theme/)
  assert.match(parseArgs(['--port', 'not-a-port']).error ?? '', /valid port number/)
  assert.match(parseArgs(['--wat']).error ?? '', /unknown option/)
  assert.match(parseArgs(['one', 'two']).error ?? '', /single url/)
})

test('recognizes only supported modes and cycles through all of them', () => {
  assert.equal(isThemeMode('auto'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('sepia'), false)
  assert.equal(nextThemeMode('auto'), 'light')
  assert.equal(nextThemeMode('light'), 'dark')
  assert.equal(nextThemeMode('dark'), 'auto')
})

test('auto delegates to terminal colors while forced modes own the full surface', () => {
  assert.deepEqual(themeFor('auto'), {
    mode: 'auto',
    primary: undefined,
    gray: undefined,
    dark: undefined,
    background: undefined,
    dimSecondary: true,
    inverseButton: true,
  })

  assert.equal(themeFor('light').background, '#ffffff')
  assert.equal(themeFor('light').primary, '#18181b')
  assert.equal(themeFor('dark').background, '#18181b')
  assert.equal(themeFor('dark').primary, '#ffffff')
})
