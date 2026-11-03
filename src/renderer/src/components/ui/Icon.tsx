export type IconName =
  | 'phone'
  | 'hangup'
  | 'mic'
  | 'micOff'
  | 'pause'
  | 'play'
  | 'keypad'
  | 'backspace'
  | 'sliders'
  | 'users'
  | 'list';

// i18n-exempt: SVG path data
const HANDSET = 'M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z';

const PATHS: Readonly<Record<IconName, string>> = {
  phone: HANDSET,
  hangup: HANDSET,
  // i18n-exempt: SVG path data
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8',
  // i18n-exempt: SVG path data
  micOff: 'M2 2l20 20M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6M17 16.9A7 7 0 0 1 5 12v-2m14 0v2c0 .4 0 .8-.1 1.2M12 19v3M8 22h8',
  // i18n-exempt: SVG path data
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  // i18n-exempt: SVG path data
  play: 'M6 4l14 8-14 8V4z',
  // i18n-exempt: SVG path data
  keypad: 'M5 5h.01M12 5h.01M19 5h.01M5 12h.01M12 12h.01M19 12h.01M5 19h.01M12 19h.01M19 19h.01',
  // i18n-exempt: SVG path data
  backspace: 'M21 5H8l-6 7 6 7h13a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zM17 9l-6 6M11 9l6 6',
  // i18n-exempt: SVG path data
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  // i18n-exempt: SVG path data
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  // i18n-exempt: SVG path data
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'
};

export function Icon({ name }: { readonly name: IconName }): JSX.Element {
  return (
    <svg className={`icon icon-${name}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
