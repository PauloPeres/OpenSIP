import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TranslatorProvider } from './i18n/TranslatorProvider';
import './styles.css';

const container = document.getElementById('root');
// i18n-exempt: developer error, never shown to users
if (container === null) throw new Error('root element missing');

createRoot(container).render(
  <StrictMode>
    <TranslatorProvider>
      <App />
    </TranslatorProvider>
  </StrictMode>
);
