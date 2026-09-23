/** The pricing plugin's configuration page on the Plugins page. */

import { useState } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the plugins.row.config SlotMap merge declared by the Plugins page.
// Cross-plugin collaboration goes through the slot system, never a value import
// (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { WEEKDAYS, type Weekday } from '../pricing.ts'
import type { PricingCardFace } from './pricing-form.ts'
import type { PricingKey } from './locales.ts'
import { DayTimeline } from './DayTimeline.tsx'
import css from './PricingCard.module.css'

/** Props the renderer binds for the pricing row page. */
export type PricingCardProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<'pricing'>
  & InjectFace<PricingCardFace>

/** The editable text of one row's three buckets (empty while unpriced). */
function textOfPrice(price: { inputPeak: number; cacheHitPeak: number; outputPeak: number } | undefined): {
  inputPeak: string
  cacheHitPeak: string
  outputPeak: string
} {
  return price === undefined
    ? { inputPeak: '', cacheHitPeak: '', outputPeak: '' }
    : {
        inputPeak: String(price.inputPeak),
        cacheHitPeak: String(price.cacheHitPeak),
        outputPeak: String(price.outputPeak),
      }
}

/**
 * One model row: the three price buckets over one entry of the Host model
 * list. A model the section does not price yet renders with empty inputs and
 * an "unpriced" marker; typing any bucket writes the entry, and removing one
 * clears it again.
 */
function ModelRow(props: {
  id: string
  price: { inputPeak: number; cacheHitPeak: number; outputPeak: number } | undefined
  disabled: boolean
  t: (key: PricingKey) => string
  onPrice(bucket: 'inputPeak' | 'cacheHitPeak' | 'outputPeak', value: number): void
  onRemove(): void
}) {
  const { id, price, disabled, t, onPrice, onRemove } = props
  const [text, setText] = useState(() => textOfPrice(price))
  const commit = (bucket: 'inputPeak' | 'cacheHitPeak' | 'outputPeak'): void => {
    const raw = text[bucket].trim()
    if (raw === '') return
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) onPrice(bucket, value)
    else setText({ ...text, [bucket]: textOfPrice(price)[bucket] })
  }
  return (
    <div className={css.modelRow}>
      <span className={css.modelName}>{id}</span>
      {price === undefined ? <span className={css.modelState}>{t('model.unpriced')}</span> : null}
      {(['inputPeak', 'cacheHitPeak', 'outputPeak'] as const).map(bucket => (
        <label key={bucket} className={css.bucket}>
          <span>{t(`model.${bucket === 'inputPeak' ? 'input' : bucket === 'cacheHitPeak' ? 'cacheHit' : 'output'}`)}</span>
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder={price === undefined ? '0' : undefined}
            disabled={disabled}
            value={text[bucket]}
            onChange={(event) => { setText({ ...text, [bucket]: event.target.value }) }}
            onBlur={() => { commit(bucket) }}
          />
        </label>
      ))}
      {!disabled && price !== undefined
        ? (
          <button type="button" className={css.removeModel} aria-label={t('model.remove')} onClick={onRemove}>×</button>
        )
        : null}
    </div>
  )
}

/** The day-exception picker: toggle a weekday's override on or off. */
function DayOverrideToggle(props: {
  day: Weekday
  enabled: boolean
  disabled: boolean
  t: (key: PricingKey) => string
  onToggle(enabled: boolean): void
}) {
  const { day, enabled, disabled, t, onToggle } = props
  return (
    <button
      type="button"
      className={clsx(css.dayToggle, enabled && css.dayToggleOn)}
      disabled={disabled}
      aria-pressed={enabled}
      onClick={() => { onToggle(!enabled) }}
    >
      {t(`day.${day}`)}
    </button>
  )
}

/**
 * Render the pricing row's configuration as the Plugins page asks for it: the
 * one-liner for `summary`, the form with its own save control for `page`. The
 * page owns the row's head, so the form is the whole body: the model price
 * table, the default 24-hour timeline, and the per-day exception toggles (each
 * enabled day shows its own override timeline).
 * @param props - the view asked for, locale copy, the card snapshot, and its form actions.
 * @returns the one-liner, or nothing when the namespace is unavailable.
 */
export function PricingCard(props: PricingCardProps) {
  const { t } = props
  const state = props.usePricingCard(snapshot => snapshot)
  const [newModel, setNewModel] = useState('')
  if (props.view === 'summary') return t('card.description')
  if (!state.available) return null
  const blocked = !state.dirty || state.saving
  const overrideDays = WEEKDAYS.filter(day => state.overrides[day] !== undefined)
  // The table is the client's model list first, then any priced model the list
  // does not carry (a retired route, a subagent-only model) in section order.
  const modelRows = [...state.modelIds, ...Object.keys(state.models).filter(id => !state.modelIds.includes(id))]
  return (
    <div className={css.body}>
      {!state.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
      {/* Model prices */}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('section.models')}</h3>
        <p className={css.hint}>{t('section.models.hint')}</p>
        {state.modelsStatus === 'loading' ? <p className={css.loading}>…</p> : null}
        {state.modelsStatus === 'error' ? <p className={css.loading}>{t('models.unavailable')}</p> : null}
        {state.modelsStatus === 'ready' && state.modelIds.length === 0
          ? <p className={css.loading}>{t('models.empty')}</p>
          : null}
        {modelRows.length > 0
          ? (
            <div className={css.models}>
              {modelRows.map(id => {
                const price = state.models[id]
                return (
                  <ModelRow
                    // The row's text is local state seeded from the price, so a
                    // committed or rebased value remounts it onto that value.
                    key={`${id}:${price === undefined ? 'unpriced' : `${price.inputPeak}/${price.cacheHitPeak}/${price.outputPeak}`}`}
                    id={id}
                    price={price}
                    disabled={!state.writable}
                    t={t}
                    onPrice={(bucket, value) => { props.editModelPrice(id, bucket, value) }}
                    onRemove={() => { props.removeModel(id) }}
                  />
                )
              })}
            </div>
          )
          : null}
        {!state.writable
          ? null
          : (
            <div className={css.addModel}>
              <input
                placeholder={t('model.add.placeholder')}
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
      {/* Default timeline */}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('section.default')}</h3>
        <p className={css.hint}>{t('section.default.hint')}</p>
        <DayTimeline
          segments={state.defaultSchedule.segments}
          disabled={!state.writable}
          onChange={(segments) => { props.editDefaultSegments(segments) }}
        />
      </section>
      {/* Per-day exceptions */}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('section.overrides')}</h3>
        <p className={css.hint}>{t('section.overrides.hint')}</p>
        <div className={css.dayToggles}>
          {WEEKDAYS.map(day => (
            <DayOverrideToggle
              key={day}
              day={day}
              enabled={state.overrides[day] !== undefined}
              disabled={!state.writable}
              t={t}
              onToggle={(enabled) => {
                if (enabled) props.addOverride(day)
                else props.removeOverride(day)
              }}
            />
          ))}
        </div>
        {overrideDays.length > 0
          ? (
            <div className={css.overrideList}>
              {overrideDays.map(day => (
                <div key={day} className={css.overrideRow}>
                  <div className={css.overrideHead}>
                    <span className={css.overrideName}>{t(`day.${day}`)}</span>
                    <button
                      type="button"
                      className={css.removeOverride}
                      disabled={!state.writable}
                      onClick={() => { props.removeOverride(day) }}
                    >
                      {t('override.remove')}
                    </button>
                  </div>
                  <DayTimeline
                    segments={state.overrides[day]!.segments}
                    disabled={!state.writable}
                    onChange={(segments) => { props.editOverrideSegments(day, segments) }}
                  />
                </div>
              ))}
            </div>
          )
          : null}
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
}
