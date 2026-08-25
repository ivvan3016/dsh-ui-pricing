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
import type { PricingCardFace } from './pricing-form.ts'
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
 * Render the pricing card. The card owns its chrome: a disclosure header,
 * the model price table, the default 24-hour timeline, and the per-day
 * exception toggles (each enabled day shows its own override timeline).
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
  const overrideDays = WEEKDAYS.filter(day => state.overrides[day] !== undefined)
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
            {/* Manual spend correction */}
            <section className={css.section}>
              <h3 className={css.sectionTitle}>{t('field.manualSpend')}</h3>
              <p className={css.hint}>{t('field.manualSpend.hint')}</p>
              <div className={css.manualSpend}>
                <span className={css.manualSpendCurrency}>{state.currency}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  disabled={!state.writable}
                  value={state.manualSpend > 0 ? state.manualSpend : ''}
                  placeholder="0.00"
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    props.editManualSpend(Number.isFinite(value) && value >= 0 ? value : 0)
                  }}
                />
              </div>
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
        : null}
    </li>
  )
}
