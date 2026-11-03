import { Fragment } from 'react';
import { cx } from './cx';

/** Break opportunities sit after `.`, so a hostname splits at its labels and never inside one. */
const AFTER_DOT = /(?<=\.)/;
const AFTER_AT = /(?<=@)/;

interface BreakableProps {
  readonly text: string;
  readonly className?: string;
  /** Repeat the full value as a tooltip; the text itself is unchanged. */
  readonly titled?: boolean;
}

function Labels({ text }: { readonly text: string }): JSX.Element {
  return (
    <>
      {text.split(AFTER_DOT).map((part, index) => (
        <Fragment key={`${index}:${part}`}>
          {index > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/**
 * An address wraps after `@` first, so the host moves to the next line whole; it only splits at a dot
 * when the host alone is wider than its container. Plain sentences (log messages) wrap at dots and spaces.
 */
export function Breakable({ text, className, titled = false }: BreakableProps): JSX.Element {
  const chunks = text.includes('@') ? text.split(AFTER_AT) : [text];
  return (
    <span className={cx('breakable', className)} title={titled ? text : undefined}>
      {chunks.map((chunk, index) => (
        <span key={`${index}:${chunk}`} className={chunks.length > 1 ? 'breakable-chunk' : undefined}>
          <Labels text={chunk} />
        </span>
      ))}
    </span>
  );
}
