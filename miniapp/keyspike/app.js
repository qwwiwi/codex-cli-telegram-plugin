// S0 phone spike page of the secret hand-over design (docs/design/secret-handover-spike.md).
// Fake values only. No network: the CSP sets connect-src 'none' and this file makes no requests.
// The value field is never sent; "Send" posts a fixed 3968-byte test string via sendData.

export const TEST_LENGTH = 3968
const PLATFORMS = ['android', 'android_x', 'ios', 'macos', 'tdesktop', 'weba', 'webk', 'web', 'unigram', 'unknown']
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const FAKE_VALUE = 'FAKE-sk-test-0000000000000000000000000000'
const CLIPBOARD_TIMEOUT_MS = 1500

/** The fixed test payload. plugin/src/codex/keyspike.ts builds the same string. */
export function buildTestString(platform) {
  let out = 'ks0.' + platform + '.'
  for (let i = 0; out.length < TEST_LENGTH; i++) out += ALPHABET[(i * 7 + 3) % ALPHABET.length]
  return out
}

export function knownPlatform(platform) {
  return PLATFORMS.includes(platform) ? platform : 'unknown'
}

function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('alphabet')
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** P2: rid (16 bytes), pk (65-byte uncompressed P-256 point), exp (decimal seconds). */
export function readParams(search) {
  const query = new URLSearchParams(search)
  const rid = query.get('rid') ?? ''
  const pk = query.get('pk') ?? ''
  const exp = query.get('exp') ?? ''
  const problems = []
  const decode = text => { try { return fromBase64url(text) } catch { return undefined } }
  const ridBytes = decode(rid)
  const pkBytes = decode(pk)
  if (!ridBytes || ridBytes.length !== 16) problems.push('rid')
  if (!pkBytes || pkBytes.length !== 65 || pkBytes[0] !== 4) problems.push('pk')
  if (!/^[0-9]{1,12}$/.test(exp)) problems.push('exp')
  return { ok: problems.length === 0, problems, ridBytes, pkBytes, exp: Number(exp) }
}

async function hkdfKey(shared, salt, info) {
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

/**
 * P3: ECDH P-256 + HKDF-SHA-256 + AES-256-GCM round trip on a fake value. The public key from the
 * URL must import as a P-256 point; the decrypting side is a local stand-in for the vault, since the
 * page never holds the request's private key.
 */
export async function cryptoRoundTrip(pkBytes, ridBytes) {
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' }
  await crypto.subtle.importKey('raw', pkBytes, ecdh, true, [])
  const vault = await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])
  const vaultPublic = new Uint8Array(await crypto.subtle.exportKey('raw', vault.publicKey))
  const ephemeral = await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const info = concat(new TextEncoder().encode('krot-key/1 key'), ephemeralPublic, vaultPublic)
  const pageShared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: vault.publicKey }, ephemeral.privateKey, 256))
  const pageKey = await hkdfKey(pageShared, ridBytes, info)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = concat(new TextEncoder().encode('krot-key/1'), ridBytes, ephemeralPublic)
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, pageKey,
    new TextEncoder().encode(FAKE_VALUE))
  const vaultShared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral.publicKey }, vault.privateKey, 256))
  const vaultKey = await hkdfKey(vaultShared, ridBytes, info)
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, vaultKey, sealed)
  return new TextDecoder().decode(opened) === FAKE_VALUE
}

function errorName(error) {
  return error && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error'
}

/**
 * P8/P9: the browser clipboard first, then Telegram's method with a 1.5 s timeout, then null
 * (the caller shows the manual hint). Must run inside the tap handler. `trace` gets one line per try.
 */
export async function pasteFromClipboard(nav, tg, trace) {
  if (nav && nav.clipboard && typeof nav.clipboard.readText === 'function') {
    try {
      const text = await nav.clipboard.readText()
      if (typeof text === 'string' && text.trim() !== '') {
        trace('браузер: да')
        return { source: 'browser', text: text.trim() }
      }
      trace('браузер: пусто')
    } catch (error) {
      trace('браузер: ' + errorName(error))
    }
  } else {
    trace('браузер: нет API')
  }
  if (tg && typeof tg.readTextFromClipboard === 'function' && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast('6.4')) {
    const text = await new Promise(resolve => {
      let done = false
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value) } }
      const timer = setTimeout(() => finish(undefined), CLIPBOARD_TIMEOUT_MS)
      try {
        tg.readTextFromClipboard(value => finish(typeof value === 'string' ? value : null))
      } catch (error) {
        trace('Telegram: ' + errorName(error))
        finish(null)
      }
    })
    if (typeof text === 'string' && text.trim() !== '') {
      trace('Telegram: да')
      return { source: 'telegram', text: text.trim() }
    }
    trace(text === undefined ? 'Telegram: нет ответа за 1,5 с' : 'Telegram: null')
  } else {
    trace('Telegram: нет метода')
  }
  return null
}

function setCheck(id, text, ok) {
  const node = document.getElementById(id)
  node.textContent = text
  node.classList.toggle('ok', ok === true)
  node.classList.toggle('bad', ok === false)
}

function pluralChars(count) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'символ'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'символа'
  return 'символов'
}

function start() {
  const tg = window.Telegram && window.Telegram.WebApp
  // P14: outside Telegram the script reports platform "unknown" (keyboard launches carry no initData).
  if (!tg || !tg.platform || tg.platform === 'unknown') {
    document.getElementById('outside').hidden = false
    return
  }
  tg.ready()
  tg.expand()
  document.getElementById('app').hidden = false

  let violations = 0
  document.addEventListener('securitypolicyviolation', event => {
    violations++
    setCheck('check-csp', violations + ' (' + event.effectiveDirective + ')', false)
  })

  const platform = knownPlatform(tg.platform)
  setCheck('check-client', tg.platform + ' · ' + tg.version, undefined)

  const params = readParams(window.location.search)
  if (params.ok) {
    setCheck('check-params', 'да', true)
    const tick = () => {
      const left = params.exp - Math.floor(Date.now() / 1000)
      // Display only: the phone clock decides nothing (design 5.2).
      setCheck('check-exp', left > 0 ? Math.floor(left / 60) + ' мин ' + (left % 60) + ' с' : 'время вышло', left > 0)
    }
    tick()
    setInterval(tick, 1000)
  } else {
    setCheck('check-params', 'нет: ' + params.problems.join(', '), false)
    setCheck('check-exp', '—', false)
  }

  if (!window.crypto || !crypto.subtle) {
    setCheck('check-crypto', 'нет Web Crypto', false)
  } else if (!params.ok) {
    setCheck('check-crypto', 'нет ключа в ссылке', false)
  } else {
    cryptoRoundTrip(params.pkBytes, params.ridBytes)
      .then(ok => setCheck('check-crypto', ok ? 'да' : 'нет', ok))
      .catch(error => setCheck('check-crypto', 'ошибка: ' + errorName(error), false))
  }

  const input = document.getElementById('value')
  const pasteStatus = document.getElementById('paste-status')
  const showCount = prefix => {
    const count = input.value.length
    pasteStatus.textContent = prefix + count + ' ' + pluralChars(count)
  }
  input.addEventListener('input', () => showCount('Символов: '))

  const pasteButton = document.getElementById('paste')
  pasteButton.addEventListener('click', async () => {
    const trace = []
    const result = await pasteFromClipboard(navigator, tg, line => trace.push(line))
    if (result) {
      input.value = result.text
      showCount('Вставлено: ')
      pasteStatus.textContent += ' (' + trace.join('; ') + ')'
    } else {
      input.focus()
      pasteStatus.textContent = 'Нажмите и подержите поле, затем «Вставить». (' + trace.join('; ') + ')'
    }
  })

  const sendButton = document.getElementById('send')
  const sendStatus = document.getElementById('send-status')
  sendButton.addEventListener('click', () => {
    if (sendButton.disabled) return
    sendButton.disabled = true
    const payload = buildTestString(platform)
    const bytes = new TextEncoder().encode(payload).length
    if (bytes !== TEST_LENGTH) {
      sendStatus.textContent = 'Ошибка: строка ' + bytes + ' байт вместо ' + TEST_LENGTH + '.'
      return
    }
    try {
      tg.sendData(payload)
      sendStatus.textContent = 'Отправлено. Окно должно закрыться.'
    } catch (error) {
      sendStatus.textContent = 'sendData не сработал: ' + errorName(error) + '. Откройте страницу кнопкой под полем ввода.'
    }
  })
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
}
