import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractAttachments, sendAttachment } from '../../src/codex/attachments.js'

test('extracts file-only replies and preserves quoted examples', () => {
  expect(extractAttachments('@@SEND_FILE: итог.txt\r\n@@SEND_FILE: итог.txt')).toEqual({
    text: '', files: ['итог.txt'],
  })
  expect(extractAttachments('```\n@@SEND_FILE: example.txt\n```\n@@SEND_FILE: real.txt')).toEqual({
    text: '```\n@@SEND_FILE: example.txt\n```', files: ['real.txt'],
  })
})

test('only stages eligible workspace files for delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'krot-outbound-test-'))
  const workspace = join(root, 'workspace')
  try {
    await mkdir(workspace)
    await writeFile(join(root, 'outside.txt'), 'outside')
    await writeFile(join(workspace, '.env'), 'fake credentials')
    await writeFile(join(workspace, 'report.txt'), 'Принято')
    if (process.platform !== 'win32') {
      await symlink(join(root, 'outside.txt'), join(workspace, 'escape.txt'), 'file')
    }
    const calls: string[] = []
    let stagedPath = ''
    const api = {
      async sendDocument(chat: string, path: string, opts: { filename?: string }) {
        stagedPath = path
        calls.push(chat, opts.filename ?? '', await readFile(path, 'utf8'))
        return { message_id: 1 }
      },
      async sendPhoto() { throw new Error('Expected a document') },
    }

    await expect(sendAttachment(api, 'owner', workspace, '../outside.txt')).rejects.toThrow()
    if (process.platform !== 'win32') {
      await expect(sendAttachment(api, 'owner', workspace, 'escape.txt')).rejects.toThrow()
    }
    await expect(sendAttachment(api, 'owner', workspace, '.env')).rejects.toThrow()
    await sendAttachment(api, 'owner', workspace, 'report.txt')
    expect(calls).toEqual(['owner', 'report.txt', 'Принято'])
    await expect(readFile(stagedPath)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
