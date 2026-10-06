/**
 * The default theme, plus the one component the Markdown needs to render as it
 * does on GitHub: Mermaid diagrams (../diagrams.ts), and a few style
 * corrections (./style.css).
 */
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';

import Mermaid from './Mermaid.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Mermaid', Mermaid);
  },
} satisfies Theme;
