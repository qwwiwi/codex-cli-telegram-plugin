import { expect, test } from 'bun:test'
import {
  busyNotice, parallelSettings, routeWhileBusy, SideRegistry, sideInstructions,
} from '../../src/codex/parallel.js'
import { ownerProvenance } from '../../src/codex/provenance.js'

const keywords = parallelSettings({ KROT_CODEX_PARALLEL: '1' }).keywords

function route(text: string | undefined, replyTo: number | undefined, sides = new SideRegistry(), maxParallel = 2) {
  return routeWhileBusy({ text, replyTo }, { keywords, maxParallel, sides })
}

test('parallel mode is off by default and reads its cap and keywords from the environment', () => {
  expect(parallelSettings({}).enabled).toBe(false)
  expect(parallelSettings({ KROT_CODEX_PARALLEL: '1' })).toEqual({
    enabled: true, maxParallel: 2, keywords: ['уточнение', 'поправка', 'к задаче', 'стоп'],
  })
  expect(parallelSettings({ KROT_CODEX_PARALLEL: '1', KROT_CODEX_MAX_PARALLEL: '3',
    KROT_CODEX_CORRECTION_WORDS: ' Добавь , ещё ' })).toEqual({ enabled: true, maxParallel: 3, keywords: ['добавь', 'ещё'] })
  for (const bad of ['0', '9', 'abc', '1.5']) {
    expect(parallelSettings({ KROT_CODEX_PARALLEL: '1', KROT_CODEX_MAX_PARALLEL: bad }).maxParallel).toBe(2)
  }
})

test('a reply or a correction keyword goes to the running main turn, anything else to a side thread', () => {
  expect(route('Уточнение: делай в другой папке', undefined)).toEqual({ route: 'main' })
  expect(route('уточнение. ещё и тесты', undefined)).toEqual({ route: 'main' })
  expect(route('  Стоп', undefined)).toEqual({ route: 'main' })
  expect(route('К задаче: добавь README', undefined)).toEqual({ route: 'main' })
  expect(route('сделай так', 42)).toEqual({ route: 'main' })
  // A keyword must be a whole word, not a prefix of another word.
  expect(route('стопка книг: сколько стоит?', undefined)).toEqual({ route: 'side' })
  expect(route('Какая погода в Москве?', undefined)).toEqual({ route: 'side' })
  expect(route(undefined, undefined)).toEqual({ route: 'side' })
})

test('a reply to a side conversation continues that side thread', () => {
  const sides = new SideRegistry()
  sides.remember(100, 'side-thread')
  sides.remember(101, 'side-thread')
  expect(route('а подробнее?', 101, sides)).toEqual({ route: 'side', thread: 'side-thread' })
  sides.begin(200, 'другое', 'side-thread')
  expect(route('а подробнее?', 101, sides, 3)).toEqual({ route: 'queue' })
})

test('the cap counts the main thread: beyond it new messages are queued', () => {
  const sides = new SideRegistry()
  expect(route('вопрос раз', undefined, sides, 2)).toEqual({ route: 'side' })
  sides.begin(1, 'вопрос раз')
  expect(sides.size).toBe(1)
  expect(route('вопрос два', undefined, sides, 2)).toEqual({ route: 'queue' })
  expect(route('вопрос два', undefined, sides, 3)).toEqual({ route: 'side' })
  expect(route('вопрос два', undefined, new SideRegistry(), 1)).toEqual({ route: 'queue' })
  // Corrections still reach the main turn when every slot is busy.
  expect(route('уточнение: быстрее', undefined, sides, 2)).toEqual({ route: 'main' })
  sides.end(1)
  expect(sides.size).toBe(0)
  expect(route('вопрос два', undefined, sides, 2)).toEqual({ route: 'side' })
})

test('[R02] the queue notice and side note say what is running', () => {
  const sides = new SideRegistry()
  sides.begin(7, 'Найди рецепт борща')
  const notice = busyNotice({ title: 'Перепиши лендинг', elapsedMs: 5 * 60_000 }, sides.titles, 2)
  expect(notice).toContain('Перепиши лендинг')
  expect(notice).toContain('5 мин')
  expect(notice).toContain('Найди рецепт борща')
  expect(notice).toContain('очеред')
  const note = sideInstructions({ title: 'Перепиши лендинг', step: 'Правлю index.html', elapsedMs: 90_000 }, ownerProvenance)
  expect(note).toContain('Перепиши лендинг')
  expect(note).toContain('Правлю index.html')
  expect(note).toContain('2 мин')
  expect(note).toContain('файл')
  expect(sideInstructions({ title: 'x'.repeat(500), elapsedMs: 0 }, ownerProvenance).length).toBeLessThan(1500)
})

test('[R03] at the largest cap seven side threads run next to the main one and the eighth message waits', () => {
  const { maxParallel } = parallelSettings({ KROT_CODEX_PARALLEL: '1', KROT_CODEX_MAX_PARALLEL: '8' })
  expect(maxParallel).toBe(8)
  const sides = new SideRegistry()
  for (let id = 1; id <= 7; id++) {
    expect(route(`вопрос ${id}`, undefined, sides, maxParallel)).toEqual({ route: 'side' })
    sides.begin(id, `вопрос ${id}`)
  }
  expect(sides.size).toBe(7)
  expect(route('вопрос 8', undefined, sides, maxParallel)).toEqual({ route: 'queue' })
})
