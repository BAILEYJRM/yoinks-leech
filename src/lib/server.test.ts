import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {saveDownloadRecord} from './history.js'
import {getMaskedDownloadUrl, startServer, stopServer} from './server.js'

test('embedded masked download server serves files with token security and session filter', async () => {
  const tmpFile = path.join(os.tmpdir(), `yoinks-server-test-${Date.now()}.mp4`)
  const fileContent = '0123456789abcdefghijklmnopqrstuvwxyz'
  fs.writeFileSync(tmpFile, fileContent)

  const serverInfo = await startServer(0) // dynamic port for test isolation
  const mySession = 'user-session-123'

  try {
    const record = saveDownloadRecord({
      url: 'https://example.com/test-server',
      title: 'Server Test Video',
      filepath: tmpFile,
      sessionId: mySession,
      platform: 'YouTube',
    })

    const maskedUrl = getMaskedDownloadUrl(record.maskedToken)
    assert.ok(maskedUrl.includes(`/d/${record.maskedToken}`))

    // 1. Test masked direct download
    const res = await fetch(maskedUrl)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'video/mp4')
    assert.ok(res.headers.get('content-disposition')?.includes('attachment'))
    const body = await res.text()
    assert.equal(body, fileContent)

    // 2. Test range request (partial content)
    const rangeRes = await fetch(maskedUrl, {
      headers: {Range: 'bytes=0-9'},
    })
    assert.equal(rangeRes.status, 206)
    assert.equal(rangeRes.headers.get('content-range'), `bytes 0-9/${fileContent.length}`)
    const rangeBody = await rangeRes.text()
    assert.equal(rangeBody, '0123456789')

    // 3. Test invalid token (404)
    const badRes = await fetch(`${serverInfo.baseUrl}/d/non-existent-token`)
    assert.equal(badRes.status, 404)

    // 4. Test API history filtered by session ID
    const apiResMatching = await fetch(`${serverInfo.baseUrl}/api/history`, {
      headers: {'X-Session-ID': mySession},
    })
    assert.equal(apiResMatching.status, 200)
    const matchingData = await apiResMatching.json() as {records: Array<{id: string; downloadUrl: string}>}
    assert.ok(matchingData.records.some(r => r.id === record.id))

    // 5. Test API history filtered by another session (should not see the record)
    const apiResOther = await fetch(`${serverInfo.baseUrl}/api/history?session_id=other-session`)
    assert.equal(apiResOther.status, 200)
    const otherData = await apiResOther.json() as {records: Array<{id: string}>}
    assert.equal(otherData.records.some(r => r.id === record.id), false)
  } finally {
    await stopServer(true)
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  }
})

test('public base URL configures masked download URLs for external domains', async () => {
  const {setPublicBaseUrl} = await import('./server.js')
  setPublicBaseUrl('https://downloads.example.com')
  const testUrl = getMaskedDownloadUrl('abc123token')
  assert.equal(testUrl, 'https://downloads.example.com/d/abc123token')
  setPublicBaseUrl(undefined)
})

test('isServerRunning detects active server and secondary startServer reuses it without closing', async () => {
  const {isServerRunning} = await import('./server.js')
  const first = await startServer(0)
  const port = first.port

  try {
    const running = await isServerRunning(port, '127.0.0.1')
    assert.equal(running, true)

    // Secondary session adopts existing server
    const second = await startServer(port, '127.0.0.1')
    assert.equal(second.port, port)

    // Secondary session exits and calls close() — server must remain running
    await second.close()
    const stillRunning = await isServerRunning(port, '127.0.0.1')
    assert.equal(stillRunning, true)
  } finally {
    await stopServer(true)
  }
})

