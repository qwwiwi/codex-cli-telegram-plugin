import { randomBytes } from 'node:crypto'
import type { EditOpts, InlineKeyboardLike, SendMessageOpts } from '../channel/tools.js'
import type { ControlState } from './control-state.js'
import type { CodexModel } from './session.js'

export type { CodexModel }

// krot:cm:<menu>:<index> picks a model, krot:ce:<menu>:<index> a reasoning effort.
// The menu ID lives only in this process, so buttons from before a restart are stale.
export const MODEL_MENU_CALLBACK = /^krot:c([me]):([a-z0-9]{1,16}):(\d{1,2})$/
export const STALE_MENU = 'Меню устарело, открой /cc заново'
const unknownModel = 'Такой модели нет в списке /cc model.'
const maxModels = 30
const maxMenus = 20

const effortLabels: Record<string, string> = {
  none: 'без рассуждений', minimal: 'минимальное', low: 'низкое', medium: 'среднее', high: 'высокое', xhigh: 'максимальное',
}

export function effortLabel(effort: string): string {
  return effortLabels[effort] ?? effort
}

// Default model first, the rest in the App Server's order.
function orderModels(models: readonly CodexModel[]): CodexModel[] {
  return [...models.filter(x => x.default), ...models.filter(x => !x.default)].slice(0, maxModels)
}

function rows<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

const mark = (title: string, current: boolean) => (current ? '✓ ' : '') + title

export function modelKeyboard(models: readonly CodexModel[], current: string | undefined, menu: string): InlineKeyboardLike {
  return { inline_keyboard: rows(orderModels(models).map((model, index) => ({
    text: mark(model.name, model.name === current), callback_data: 'krot:cm:' + menu + ':' + index,
  })), 2) }
}

export function effortKeyboard(model: CodexModel, current: string | undefined, menu: string): InlineKeyboardLike {
  return { inline_keyboard: rows(model.efforts.map((effort, index) => ({
    text: mark(effortLabel(effort), effort === current), callback_data: 'krot:ce:' + menu + ':' + index,
  })), 3) }
}

type MenuTelegram = {
  sendMessage(chat: string, text: string, options: SendMessageOpts): Promise<{ message_id: number }>
  editMessageText(chat: string, id: number, text: string, options: EditOpts): Promise<void>
}

export interface ModelMenuOptions {
  ownerId: number
  chat: string
  telegram: MenuTelegram
  controls: Pick<ControlState, 'model' | 'effort' | 'selectEffort' | 'selectModelAndEffort'>
  models: () => Promise<CodexModel[]>
  // false behind the root relay: it refuses `effort` on turn/start, so no effort row is offered.
  efforts: boolean
  // KROT_CODEX_MODEL: what `/cc model default` selects when set.
  defaultModel?: string
}

export interface MenuQuery {
  data: string
  fromId: number
  chatId: number | undefined
  chatType: string | undefined
  messageId: number | undefined
}

type Menu = { models: CodexModel[]; picked?: CodexModel }

// The /cc model picker: one button per model, then a row of the efforts the picked model supports.
export class ModelMenu {
  private readonly menus = new Map<string, Menu>()

  constructor(private readonly options: ModelMenuOptions) {}

  async open(): Promise<void> {
    const { telegram, chat, controls } = this.options
    const models = orderModels(await this.options.models())
    if (!models.length) {
      await telegram.sendMessage(chat, 'Codex не вернул список моделей.', {})
      return
    }
    const id = randomBytes(4).toString('hex')
    this.menus.set(id, { models })
    if (this.menus.size > maxMenus) this.menus.delete(this.menus.keys().next().value!)
    const current = controls.model ?? this.options.defaultModel ?? models.find(x => x.default)?.name
    await telegram.sendMessage(chat, 'Модель Codex для следующих запросов', { reply_markup: modelKeyboard(models, current, id) })
  }

  // `/cc model <name>`: the reply text for the owner.
  async choose(value: string): Promise<string> {
    const models = await this.options.models()
    const name = value === 'default'
      ? this.options.defaultModel ?? models.find(x => x.default)?.name
      : models.find(x => x.name === value)?.name
    if (!name) return unknownModel
    this.select(name, models)
    return 'Модель для следующих запросов: ' + name
  }

  // A tap on a menu button. undefined: not the owner in the private chat, the tap is ignored.
  async answer(query: MenuQuery): Promise<string | undefined> {
    const { ownerId, telegram, chat, controls } = this.options
    if (query.fromId !== ownerId || query.chatType !== 'private' || query.chatId !== ownerId) return undefined
    const match = MODEL_MENU_CALLBACK.exec(query.data)
    const menu = match ? this.menus.get(match[2]!) : undefined
    if (!match || !menu || query.messageId === undefined) return STALE_MENU
    const index = Number(match[3])
    if (match[1] === 'm') {
      const choice = menu.models[index]
      if (!choice) return STALE_MENU
      // The same check as /cc model <name>: the model must still be on the App Server's list.
      const models = await this.options.models()
      const model = models.find(x => x.name === choice.name)
      if (!model) return unknownModel
      this.select(model.name, models)
      const offered = this.options.efforts ? model : { ...model, efforts: [] }
      menu.picked = offered
      const text = 'Модель для следующих запросов: ' + model.name +
        (offered.efforts.length ? '\nУсилие рассуждений:' : '')
      await telegram.editMessageText(chat, query.messageId, text,
        { reply_markup: effortKeyboard(offered, controls.effort ?? model.defaultEffort, match[2]!) })
      return 'Модель: ' + model.name
    }
    const picked = menu.picked
    const effort = picked?.efforts[index]
    // An effort row belongs to the model picked in this menu; once another model is chosen it is stale.
    if (!picked || !effort || controls.model !== picked.name) return STALE_MENU
    controls.selectEffort(effort)
    await telegram.editMessageText(chat, query.messageId,
      'Модель для следующих запросов: ' + picked.name + '\nУсилие рассуждений: ' + effortLabel(effort),
      { reply_markup: { inline_keyboard: [] } })
    return 'Усилие: ' + effortLabel(effort)
  }

  // Sets the model; an effort the new model does not support falls back to the model default. One write for both.
  private select(name: string, models: readonly CodexModel[]): void {
    const { controls } = this.options
    const efforts = models.find(x => x.name === name)?.efforts ?? []
    const effort = controls.effort && efforts.includes(controls.effort) ? controls.effort : undefined
    controls.selectModelAndEffort(name, effort)
  }
}
