import { useTranslation } from '../i18n/TranslatorProvider';

// i18n-exempt: SVG path data (assets/logo-mark.svg, kept intact)
const MARK_PATH = 'M13.98 42.62A22 22 0 1 1 32 52L10 57Z M18 27.5a3.5 3.5 0 0 1 7 0v5a3.5 3.5 0 0 1-7 0Z M28.5 21.5a3.5 3.5 0 0 1 7 0v17a3.5 3.5 0 0 1-7 0Z M39 25.5a3.5 3.5 0 0 1 7 0v9a3.5 3.5 0 0 1-7 0Z';

const LETTER_PATHS: readonly string[] = [
  'M107 27V53', // i18n-exempt: SVG path data
  'M134 34H148A7 7 0 1 0 146.4 38.5', // i18n-exempt: SVG path data
  'M160 27V41M160 34A7 7 0 0 1 174 34V41', // i18n-exempt: SVG path data
  'M198.2 21A5.5 5.5 0 1 0 194 30A5.5 5.5 0 1 1 189.8 39', // i18n-exempt: SVG path data
  'M210 19V41', // i18n-exempt: SVG path data
  'M222 19V41M222 19H227A6 6 0 0 1 227 31H221' // i18n-exempt: SVG path data
];

interface MarkProps {
  readonly size?: number;
  /** True when the mark sits beside the product name, so it adds nothing for assistive tech. */
  readonly decorative?: boolean;
}

function MarkShape(): JSX.Element {
  return <path className="logo-mark" fillRule="evenodd" d={MARK_PATH} />;
}

export function Mark({ size = 32, decorative = false }: MarkProps): JSX.Element {
  const { t } = useTranslation();
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': t('app.title') };
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} focusable="false" {...a11y}>
      <MarkShape />
    </svg>
  );
}

/** Mark plus lettering. The lettering follows the theme through --logo-ink. */
export function Wordmark({ height = 30 }: { readonly height?: number }): JSX.Element {
  const { t } = useTranslation();
  return (
    <svg viewBox="0 0 240 64" width={(height * 240) / 64} height={height} role="img" aria-label={t('app.title')} focusable="false">
      <MarkShape />
      <g className="logo-text">
        <circle cx="82" cy="30" r="11" />
        <circle cx="114" cy="34" r="7" />
        {LETTER_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
