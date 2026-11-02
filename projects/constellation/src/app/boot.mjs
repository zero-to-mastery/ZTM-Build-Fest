// Load the Studio, or explain clearly why it can't start. Importing the app
// pulls in the Rust/WASM engine, which fails in browsers that block WebAssembly.
try {
  const { startStudio } = await import('./main.mjs');
  startStudio();
} catch (error) {
  const status = document.querySelector('#status');
  if (status) {
    status.setAttribute('role', 'alert');
    status.textContent = 'The map engine couldn’t start in this browser.';
  }
  const engine = document.querySelector('#engine-status');
  if (engine) {
    engine.hidden = false;
    engine.textContent = 'Constellation draws your map with a small WebAssembly engine, and this browser blocked it. Try an up-to-date Chrome, Edge, Firefox or Safari, or turn off the policy that blocks WebAssembly.';
  }
  document.querySelector('#open-studio')?.setAttribute('disabled', '');
  console.error(error);
}
