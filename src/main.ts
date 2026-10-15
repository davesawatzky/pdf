import { createApp } from "vue";
import App from "./App.vue";
import { openBytes } from "./store";

const app = createApp(App);
app.mount("#app");

// Dev convenience: `npm run dev` + visit /?demo to auto-load the bundled sample.pdf.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) {
  fetch("./sample.pdf")
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((buf) => openBytes(new Uint8Array(buf), "sample.pdf"))
    .catch(() => console.warn("Could not load sample.pdf for demo mode."));
}
