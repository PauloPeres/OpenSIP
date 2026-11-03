import { MAX_CONCURRENT_CALLS } from '@core/sip';
import { useTranslation } from '../i18n/TranslatorProvider';
import type { LinesModel } from '../state/useLines';
import { FocusedLine, LineRow } from './Lines';
import type { LineEnv } from './Lines';
import { Icon } from './ui/Icon';
import { cx } from './ui/cx';

function LampStrip({ model }: { readonly model: LinesModel }): JSX.Element {
  const slots = Array.from({ length: MAX_CONCURRENT_CALLS }, (_, i) => i + 1);
  return (
    <span className="lamp-strip" aria-hidden="true">
      {slots.map((slot) => {
        const line = model.lines.find((l) => l.slot === slot);
        return <span key={slot} className={cx('lamp', line && `lamp-${line.view.call.state}`)} />;
      })}
    </span>
  );
}

function Empty(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="empty">
      <Icon name="phone" />
      <p>{t('calls.none')}</p>
    </div>
  );
}

function LineItems({ model, env }: { readonly model: LinesModel; readonly env: LineEnv }): JSX.Element {
  return (
    <ul className="line-list">
      {model.lines.map((line) =>
        line === model.focused ? (
          <FocusedLine key={line.view.call.id} line={line} env={env} />
        ) : (
          <LineRow key={line.view.call.id} line={line} env={env} onSelect={model.focus} />
        )
      )}
    </ul>
  );
}

export function LinesPanel({ model, env }: { readonly model: LinesModel; readonly env: LineEnv }): JSX.Element {
  const { t } = useTranslation();
  return (
    <section className="panel lines" aria-labelledby="lines-title">
      <h2 id="lines-title" className="panel-title">
        {t('nav.calls')}
        <LampStrip model={model} />
      </h2>
      {model.lines.length === 0 ? <Empty /> : <LineItems model={model} env={env} />}
    </section>
  );
}
