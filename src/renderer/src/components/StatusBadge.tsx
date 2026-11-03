import type { ReactNode } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'danger';

export function StatusBadge({ tone, label }: { readonly tone: string; readonly label: string }): JSX.Element {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

interface ActionButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly variant?: ButtonVariant;
  readonly submit?: boolean;
}

/** Shared button primitive; the caller supplies the already-translated label. */
export function ActionButton({ label, onClick, variant = 'default', submit = false }: ActionButtonProps): JSX.Element {
  return (
    <button type={submit ? 'submit' : 'button'} className={`btn btn-${variant}`} onClick={onClick}>
      {label}
    </button>
  );
}

export function Section({ title, children }: { readonly title: string; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
