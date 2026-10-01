<script setup lang="ts">
/**
 * Draws one Mermaid diagram in the browser (see ../diagrams.ts). Mermaid is
 * loaded on first use, so pages without a diagram never download it, and it
 * is bundled with the site: no diagram is sent anywhere to be drawn.
 */
import { onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

const props = defineProps<{ source: string }>();
const { isDark } = useData();

const svg = ref('');
const failed = ref(false);
const code = decodeURIComponent(props.source);

let rendered = 0;

async function draw(): Promise<void> {
  const { default: mermaid } = await import('mermaid');
  // `strict` keeps a diagram from carrying script or click handlers into the page.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark.value ? 'dark' : 'default',
  });
  try {
    rendered += 1;
    const id = `mermaid-${Math.random().toString(36).slice(2)}-${rendered}`;
    svg.value = (await mermaid.render(id, code)).svg;
    failed.value = false;
  } catch {
    // An invalid diagram stays readable as its source rather than vanishing.
    failed.value = true;
  }
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
  <div v-if="!failed" class="mermaid-diagram" v-html="svg" />
  <pre v-else class="mermaid-source"><code>{{ code }}</code></pre>
</template>

<style scoped>
.mermaid-diagram {
  margin: 16px 0;
  overflow-x: auto;
  text-align: center;
}
.mermaid-source {
  overflow-x: auto;
}
</style>
