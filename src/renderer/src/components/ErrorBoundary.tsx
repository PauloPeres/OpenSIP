import { Component } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../i18n/TranslatorProvider';

interface BoundaryProps {
  readonly children: ReactNode;
  /** The element the notice is drawn as, so it stays valid HTML where the failed child would have been. */
  readonly as?: 'p' | 'li';
}

interface BoundaryState {
  readonly failed: boolean;
}

function FailureNotice({ as: Tag = 'p' }: Pick<BoundaryProps, 'as'>): JSX.Element {
  const { t } = useTranslation();
  return <Tag className="notice" role="alert">{t('error.unexpected')}</Tag>;
}

/**
 * Contains a render failure to the subtree it wraps, so one bad panel or row never blanks the window.
 * Remount it (change its `key`) to try again.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? <FailureNotice {...(this.props.as ? { as: this.props.as } : {})} /> : this.props.children;
  }
}
