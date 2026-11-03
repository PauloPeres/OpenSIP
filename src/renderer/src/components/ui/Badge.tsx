import { cx } from './cx';

export function Badge({ tone, label }: { readonly tone: string; readonly label: string }): JSX.Element {
  return <span className={cx('badge', `badge-${tone}`)}>{label}</span>;
}

/** Account identity: a tinted initial, with an optional registration-state dot. */
export function Avatar({ name, hue, tone }: { readonly name: string; readonly hue: number; readonly tone?: string }): JSX.Element {
  return (
    <span className={cx('avatar', `hue-${hue % 4}`)} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase()}
      {tone ? <span className={cx('avatar-dot', `dot-${tone}`)} /> : null}
    </span>
  );
}
