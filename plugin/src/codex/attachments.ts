import { constants, createWriteStream } from 'node:fs'
import { mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { TelegramApi } from '../channel/tools.js'
import { assertSendableFileInRoots, isPhotoExtension, MAX_ATTACHMENT_BYTES } from '../security/paths.js'

export const attachmentInstructions =
  'Служебное правило канала Telegram. Если пользователь просит прислать файл, помести готовую копию в telegram-outbox/ внутри рабочей папки. ' +
  'Если каталога нет, создай его. Установи права 0640 только для копии, которую пользователь попросил отправить. ' +
  'В конце ответа добавь для каждого файла отдельную строку @@SEND_FILE: путь. ' +
  'Путь может быть относительным к рабочей папке. Не заключай строку в Markdown.'

export function extractAttachments(reply: string): { text: string; files: string[] } {
  const files = new Set<string>()
  const text: string[] = []
  let fence: string | undefined
  for (const line of reply.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker.startsWith(fence) && line.trim() === marker) fence = undefined
    }
    const path = !fence && !marker ? /^[ \t]*@@SEND_FILE:[ \t]*(\S.*?)[ \t]*$/.exec(line)?.[1] : undefined
    if (path) files.add(path)
    else text.push(line)
  }
  return { text: files.size ? text.join('\n').trim() : reply, files: [...files] }
}

export async function sendAttachment(
  telegram: Pick<TelegramApi, 'sendDocument' | 'sendPhoto'>,
  chatId: string,
  workspace: string,
  path: string,
  replyTo?: number,
): Promise<number> {
  const canonical = assertSendableFileInRoots({ filePath: path, roots: [workspace] })
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (process.platform === 'linux' && await realpath('/proc/self/fd/' + file.fd) !== canonical) {
      throw new Error('Attachment changed while opening')
    }
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new Error('Unsupported attachment')
    const staging = await mkdtemp(join(tmpdir(), 'krot-codex-send-'))
    try {
      const filename = basename(canonical)
      const options = { filename, ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }) }
      const stagedPath = join(staging, filename)
      const stream = file.createReadStream({ end: MAX_ATTACHMENT_BYTES - 1, autoClose: false })
      await pipeline(stream, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }))
      if (stream.bytesRead !== stat.size || (await file.stat()).size !== stat.size) {
        throw new Error('Attachment size changed during upload')
      }
      if (isPhotoExtension(canonical) && stat.size <= 10 * 1024 * 1024) {
        return (await telegram.sendPhoto(chatId, stagedPath, options)).message_id
      } else {
        return (await telegram.sendDocument(chatId, stagedPath, options)).message_id
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  } finally {
    await file.close()
  }
}
