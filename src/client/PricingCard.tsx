/** The pricing plugin's card in the Plugins configuration tab. */

import { useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the settings.plugin.item SlotMap merge declared by the Plugins
// configuration section. Cross-plugin collaboration goes through the slot
// system, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { WEEKDAYS, type Weekday } from '../pricing.ts'
import { effectiveDaySchedule, type PricingCardFace } from './pricing-form.ts'
import type { PricingKey } from './locales.ts'
import { DayTimeline } from './DayTimeline.tsx'
import css from './PricingCard.module.css'

/** Props the renderer binds for the pricing card. */
export type PricingCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'pricing'>
  & InjectFace<PricingCardFace>

/** One model price row: three numeric buckets plus a remove action. */
function ModelRow(props: {
  id: string
  price: { inputPeak: number; cacheHitPeak: number; outputPeak: number }
  disabled: boolean
  t: (key: PricingKey) => string
  onPrice(bucket: 'inputPeak' | 'cacheHitPeak' | 'outputPeak', value: number): void
  onRemove(): void
}) {
  const { id, price, disabled, t, onPrice, onRemove } = props
  const [text, setText] = useState({ inputPeak: String(price.inputPeak), cacheHitPeak: String(price.cacheHitPeak), outputPeak: String(price.outputPeak) })
  const commit = (bucket: 'inputPeak' | 'cacheHitPeak' | 'outputPeak'): void => {
    const value = Number(text[bucket])
    if (Number.isFinite(value) && value >= 0) onPrice(bucket, value)
    else setText({ ...text, [bucket]: String(price[bucket]) })
  }
  return (
    <div className={css.modelRow}>
      <span className={css.modelName}>{id}</span>
      {(['inputPeak', 'cacheHitPeak', 'outputPeak'] as const).map(bucket => (
        <label key={bucket} className={css.bucket}>
          <span>{t(`model.${bucket === 'inputPeak' ? 'input' : bucket === 'cacheHitPeak' ? 'cacheHit' : 'output'}`)}</span>
          <input
            type="number"
            min="0"
            step="0.1"
            disabled={disabled}
            value={text[bucket]}
            onChange={(event) => { setText({ ...text, [bucket]: event.target.value }) }}
            onBlur={() => { commit(bucket) }}
          />
        </label>
      ))}
      {!disabled
        ? (
          <button type="button" className={css.removeModel} onClick={onRemove}>×</button>
        )
        : null}
    </div>
  )
}

/** One day's row: the label, the follow control, and the timeline. */
function DayRow(props: {
  day: Weekday
  segments: { start: string; end: string; multiplier: number }[]
  followedBy: string | null
  disabled: boolean
  t: (key: PricingKey, params?: Record<string, string>) => string
  onChange(segments: { start: string; end: string; multiplier: number }[]): void
  onLink(followed: Weekday): void
  onUnlink(): void
}) {
  const { day, segments, followedBy, disabled, t, onChange, onLink, onUnlink } = props
  return (
    <div className={css.dayRow}>
      <div className={css.dayHead}>
        <span className={css.dayName}>{t(`day.${day}`)}</span>
        {followedBy !== null
          ? <span className={css.follows}>{t('link.follows', { day: t(`day.${followedBy as Weekday}`) })}</span>
          : null}
        {!disabled
          ? (
            <select
              className={css.followSelect}
              value={followedBy ?? ''}
              onChange={(event) => {
                const value = event.target.value
                if (value === '') onUnlink()
                else onLink(value as Weekday)
              }}
            >
              <option value="">{t('link.self')}</option>
              {WEEKDAYS.filter(other => other !== day).map(other => (
                <option key={other} value={other}>{t('link.follows', { day: t(`day.${other}`) })}</option>
              ))}
            </select>
          )
          : null}
      </div>
      <DayTimeline segments={segments} disabled={disabled} onChange={onChange} />
    </div>
  )
}

/**
 * Render the pricing card. The card owns its chrome: a disclosure header,
 * the model price table, and one draggable timeline per day of the week.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function PricingCard(props: PricingCardProps) {
  const { t } = props
  const state = props.usePricingCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [newModel, setNewModel] = useState('')
  if (!state.available) return null
  const blocked = !state.dirty || state.saving
  return (
    <li className={clsx(css.card, open && css.cardOpen)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('card.title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('card.title')}</span>
          <span className={css.description}>{t('card.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{t('unsaved')}</span> : null}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
            {/* Model prices */}
            <section className={css.section}>
              <h3 className={css.sectionTitle}>{t('section.models')}</h3>
              <p className={css.hint}>{t('section.models.hint')}</p>
              {state.modelsStatus === 'loading' ? <p className={css.loading}>…</p> : null}
              {state.modelsStatus === 'error' ? <p className={css.loading}>{t('models.unavailable')}</p> : null}
              {state.modelsStatus === 'ready'
                ? (
                  <div className={css.models}>
                    {Object.entries(state.models).map(([id, price]) => (
                      <ModelRow
                        key={id}
                        id={id}
                        price={price}
                        disabled={!state.writable}
                        t={t}
                        onPrice={(bucket, value) => { props.editModelPrice(id, bucket, value) }}
                        onRemove={() => { props.removeModel(id) }}
                      />
                    ))}
                  </div>
                )
                : null}
              {!state.writable
                ? null
                : (
                  <div className={css.addModel}>
                    <input
                      placeholder="model-id"
                      value={newModel}
                      onChange={(event) => { setNewModel(event.target.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && newModel.trim() !== '') {
                          props.addModel(newModel.trim())
                          setNewModel('')
                        }
                      }}
                    />
                    <button
                      type="button"
                      disabled={newModel.trim() === ''}
                      onClick={() => { props.addModel(newModel.trim()); setNewModel('') }}
                    >
                      {t('model.add')}
                    </button>
                  </div>
                )}
            </section>
            {/* Per-day timelines */}
            <section className={css.section}>
              <h3 className={css.sectionTitle}>{t('section.days')}</h3>
              <p className={css.hint}>{t('section.days.hint')}</p>
              {WEEKDAYS.map(day => (
                <DayRow
                  key={day}
                  day={day}
                  segments={effectiveDaySchedule(state.dayLinks, state.days, day).segments}
                  followedBy={state.dayLinks[day] ?? null}
                  disabled={!state.writable}
                  t={t}
                  onChange={(segments) => { props.editDaySegments(day, segments) }}
                  onLink={(followed) => { props.linkDay(day, followed) }}
                  onUnlink={() => { props.unlinkDay(day) }}
                />
              ))}
            </section>
            <div className={css.footer}>
              {state.failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving}
                onClick={props.discard}
              >
                {t('discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={blocked}
                onClick={props.save}
              >
                {t(state.saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
