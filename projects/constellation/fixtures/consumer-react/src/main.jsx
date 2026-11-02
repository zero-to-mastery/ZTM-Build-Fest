import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@constellation/web-component';
import { createScene } from '@constellation/core';

const scene = createScene('react-demo', [
  { name: 'compiler', full_name: 'react-demo/compiler', language: 'Rust' },
  { name: 'studio', full_name: 'react-demo/studio', language: 'JavaScript' },
], { projectFamilies: { tools: { label: 'Tools', members: ['react-demo/compiler', 'react-demo/studio'] } } });

function Portfolio() {
  const viewRef = useRef(null);
  const [status, setStatus] = useState('Loading projects…');
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;
    const ready = () => { window.statusUpdateCount = (window.statusUpdateCount || 0) + 1; setStatus('Projects ready'); };
    const failed = () => { window.statusUpdateCount = (window.statusUpdateCount || 0) + 1; setStatus('The project map could not be loaded.'); };
    view.addEventListener('scene-ready', ready);
    view.addEventListener('scene-change', ready);
    view.addEventListener('error', failed);
    view.scene = scene;
    return () => {
      view.removeEventListener('scene-ready', ready);
      view.removeEventListener('scene-change', ready);
      view.removeEventListener('error', failed);
    };
  }, []);
  return <section aria-label="Interactive project map"><p id="status" role="status">{status}</p><constellation-view id="portfolio" ref={viewRef} style={{ display: 'block', width: '100%', minHeight: 420 }} /></section>;
}

let renderRoot = createRoot(document.getElementById('root'));
renderRoot.render(<Portfolio />);
window.unmountPortfolio = () => renderRoot.unmount();
window.mountPortfolio = () => {
  renderRoot = createRoot(document.getElementById('root'));
  renderRoot.render(<Portfolio />);
};
