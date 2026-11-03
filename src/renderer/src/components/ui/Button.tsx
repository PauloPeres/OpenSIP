import { cx } from './cx';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'success' | 'ghost';

export interface ButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly variant?: ButtonVariant;
  readonly icon?: IconName;
  readonly iconOnly?: boolean;
  /** Stacked icon-over-label layout, used for in-call controls. */
  readonly tile?: boolean;
  readonly large?: boolean;
  readonly pressed?: boolean;
  readonly submit?: boolean;
  readonly disabled?: boolean;
}

function buttonClass(p: ButtonProps): string {
  return cx('btn', `btn-${p.variant ?? 'default'}`, p.tile && 'btn-tile', p.large && 'btn-lg', p.iconOnly && 'btn-icon');
}

/** Shared button primitive; the caller supplies the already-translated label. */
export function Button(props: ButtonProps): JSX.Element {
  const { label, onClick, icon, iconOnly, pressed, disabled } = props;
  return (
    <button
      type={props.submit ? 'submit' : 'button'}
      className={buttonClass(props)}
      onClick={onClick}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      aria-pressed={pressed}
      disabled={disabled}
    >
      {icon ? <Icon name={icon} /> : null}
      {iconOnly ? null : <span>{label}</span>}
    </button>
  );
}
