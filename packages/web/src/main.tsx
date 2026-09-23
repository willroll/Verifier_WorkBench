import './styles/fonts.css';
import './styles/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { detectBackend } from './backend';
import { applyTheme } from './theme';

applyTheme();
void detectBackend();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
