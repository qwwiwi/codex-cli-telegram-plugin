import { expect, test } from 'bun:test'
import { unfinishedOwnerTask, ownerStatusCheck, ownerExecutionTask, publicProgress } from '../../src/codex/continuation.js'

const task = 'Продолжай подключение и проверь доставку в обе стороны.'
const report = 'Сквозной обмен пока не подтверждён. Один вызов отклонён. Остаются два шага: переключить доставку и проверить оба направления.'

test('a remaining step resumes the task without the model marker', () => {
  expect(unfinishedOwnerTask(task, report)).toBe(true)
  expect(unfinishedOwnerTask(task, 'Вход ещё нужно включить. После переключения можно будет проверить доставку.')).toBe(true)
  expect(unfinishedOwnerTask(task, 'Работа завершена. Если захочешь, потом можно будет проверить запасной маршрут.')).toBe(false)
})

test('an unrelated status question, stop or genuine external dependency does not launch a new goal', () => {
  const status = 'Так, что у нас с настройкой? Всё готово?'
  expect(ownerStatusCheck(status)).toBe(true)
  expect(ownerExecutionTask(status)).toBe(false)
  expect(unfinishedOwnerTask(status, report)).toBe(false)
  expect(unfinishedOwnerTask('Только скажи статус, ничего не меняй.', report, true)).toBe(false)
  expect(unfinishedOwnerTask(task, 'Осталось проверить доставку. Чтобы продолжить, войди в аккаунт.', true)).toBe(false)
})

test('public progress retains Markdown and the whole report', () => {
  const message = '**первый этап готов.**\n\n- Проверил \`bun test\`.\n- ' + 'д'.repeat(220) + '.'
  const progress = publicProgress('Веха: ' + message)
  expect(progress).toEqual({ milestone: true, text: message.replace('первый', 'Первый') })
  expect(publicProgress('Ответ в чате: проверяю ещё один сценарий.')).toEqual({
    milestone: false, text: 'Проверяю ещё один сценарий.',
  })
  expect(publicProgress('Черновая мысль модели')).toBeUndefined()
})
