import "./styles.css";
import { FlashApp } from "./app";

const app = new FlashApp();
app.start().catch((error: unknown) => {
  const ui = document.getElementById("ui");
  if (ui) {
    ui.innerHTML = `
      <div class="screen compact">
        <h2>Could not start the game</h2>
        <p class="subtitle">${String(error instanceof Error ? error.message : error)}</p>
        <p class="tiny">This build needs WebGL. Try a current Chrome, Edge, Firefox or Safari.</p>
      </div>
    `;
  }
});
