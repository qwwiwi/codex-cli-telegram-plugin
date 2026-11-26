import { expect, test } from 'bun:test'

import { renderHud } from '../../src/status/context-hud.js'

test('renders the Codex limits line in the HUD only when it is known', () => {
  const line = 'Лимиты Codex: потрачено за неделю 36% · за 5ч 12% (сброс 01.12 00:30 МСК)'
  const withLimits = renderHud({ usedTokens: 50_000 }, 100_000, 'gpt-test', undefined, undefined, line)
  expect(withLimits.text.split('\n')).toEqual([
    '🧠 <b>Контекст</b>: ▰▰▰▰▰▱▱▱▱▱ 50% (50k / 100k)',
    '<i>gpt-test</i>',
    line,
  ])
  expect(renderHud(null, 0, undefined, undefined, undefined, line).text).toBe(`🧠 <b>Контекст</b>: —\n${line}`)
  expect(renderHud(null, 0).text).toBe('🧠 <b>Контекст</b>: —')
})
