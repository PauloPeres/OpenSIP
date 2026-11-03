import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TranslatorProvider } from './i18n/TranslatorProvider';
import { applyTheme, readTheme } from './state/theme';
import './styles.css';

const container = document.getElementById('root');
// i18n-exempt: developer error, never shown to users
if (container === null) throw new Error('root element missing');

// Before the first render, so a saved choice never flashes the other theme.
applyTheme(readTheme());

createRoot(container).render(
  <StrictMode>
    <TranslatorProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </TranslatorProvider>
  </StrictMode>
);
