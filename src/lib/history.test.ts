import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkDownloadQuota,
  cleanExpiredRecords,
  findRecordByToken,
  getSessionQuotaUsage,
  LIMIT,
  loadHistory,
  loadHistoryRecords,
  MAX_QUOTA_BYTES,
  saveDownloadRecord,
  TTL_MS,
} from './history.js'

test('saves download record with masked token and retrieves it with session isolation', () => {
  const tmpFile = path.join(os.tmpdir(), `yoinks-test-file-${Date.now()}.mp4`)
  fs.writeFileSync(tmpFile, 'dummy video data')

  const sessionA = 'session-user-a'
  const sessionB = 'session-user-b'

  try {
    const record = saveDownloadRecord({
      url: 'https://youtu.be/test12345',
      title: 'Sample Video Title',
      filepath: tmpFile,
      sessionId: sessionA,
      platform: 'YouTube',
      choiceLabel: '1080p',
    })

    assert.ok(record.id)
    assert.ok(record.maskedToken)
    assert.equal(record.sessionId, sessionA)
    assert.ok(record.expiresAt > Date.now())

    // Session A should see the record
    const recordsA = loadHistoryRecords(sessionA)
    assert.ok(recordsA.some(r => r.id === record.id))

    // Session B should NOT see the record
    const recordsB = loadHistoryRecords(sessionB)
    assert.equal(recordsB.some(r => r.id === record.id), false)

    // Token lookup works directly
    const found = findRecordByToken(record.maskedToken)
    assert.ok(found)
    assert.equal(found?.id, record.id)
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  }
})

test('cleans up expired records (> 72 hours) and deletes their local files', () => {
  const tmpFile = path.join(os.tmpdir(), `yoinks-expired-file-${Date.now()}.mp4`)
  fs.writeFileSync(tmpFile, 'expired video data')

  const session = 'session-expired-test'
  const record = saveDownloadRecord({
    url: 'https://youtu.be/expired-video',
    title: 'Expired Video',
    filepath: tmpFile,
    sessionId: session,
  })

  // Modify disk JSON to put expiresAt in the past
  const historyFile = path.join(os.homedir(), '.config', 'yoinks', 'history.json')
  if (fs.existsSync(historyFile)) {
    const data = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as {records: Array<{id: string; expiresAt: number}>}
    const item = data.records.find(r => r.id === record.id)
    if (item) {
      item.expiresAt = Date.now() - 5000 // 5 seconds in the past
      fs.writeFileSync(historyFile, JSON.stringify(data, null, 2))
    }
  }

  // Running expired cleanup
  cleanExpiredRecords()

  // Token lookup should now return undefined and the local file is removed
  const lookup = findRecordByToken(record.maskedToken)
  assert.equal(lookup, undefined)
  assert.equal(fs.existsSync(tmpFile), false)
})

test('verifies 30 items limit and 10GB / 3-day quota', () => {
  assert.equal(LIMIT, 30)
  assert.equal(MAX_QUOTA_BYTES, 10 * 1024 * 1024 * 1024)

  const session = 'quota-test-session'
  const quota = getSessionQuotaUsage(session)
  assert.equal(quota.maxBytes, 10 * 1024 * 1024 * 1024)

  // Test checking quota under 10GB
  const checkOk = checkDownloadQuota(500 * 1024 * 1024, session) // 500 MB
  assert.equal(checkOk.allowed, true)

  // Test checking quota over 10GB
  const checkOver = checkDownloadQuota(11 * 1024 * 1024 * 1024, session) // 11 GB
  assert.equal(checkOver.allowed, false)
  assert.ok(checkOver.reason?.includes('exceeds 10 GB limit'))
})
