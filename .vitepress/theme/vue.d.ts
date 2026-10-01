/** Lets TypeScript import single-file components; Vite compiles them. */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
