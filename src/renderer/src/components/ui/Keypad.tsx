import type { DtmfDigit } from '../../../../shared/api';

const KEYS: readonly DtmfDigit[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

interface KeypadProps {
  readonly label: string;
  readonly onDigit: (digit: DtmfDigit) => void;
}

export function Keypad({ label, onDigit }: KeypadProps): JSX.Element {
  return (
    <div className="keypad" role="group" aria-label={label}>
      {KEYS.map((key) => (
        <button key={key} type="button" className="key" onClick={() => onDigit(key)}>
          {key}
        </button>
      ))}
    </div>
  );
}
