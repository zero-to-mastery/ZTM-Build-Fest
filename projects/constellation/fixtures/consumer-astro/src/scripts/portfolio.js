import '@constellation/web-component';

const view = document.querySelector('#portfolio');
view.addEventListener('scene-ready', () => { document.querySelector('#status').textContent = 'Projects ready'; }, { once: true });
view.addEventListener('scene-change', () => { document.querySelector('#status').textContent = 'Projects ready'; }, { once: true });
view.addEventListener('error', () => { document.querySelector('#status').textContent = 'The project map could not be loaded.'; }, { once: true });
fetch('/scene.json').then(response => {
  if (!response.ok) throw new Error(`Unable to load portfolio scene (${response.status}).`);
  return response.json();
}).then(scene => { view.scene = scene; }).catch(() => {
  document.querySelector('#status').textContent = 'The project map could not be loaded.';
});
