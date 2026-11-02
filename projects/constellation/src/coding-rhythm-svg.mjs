export const codingRhythmCSS = `.coding-rhythm{color:var(--sky-accent);pointer-events:none}.coding-rhythm path,.coding-rhythm ellipse{fill:none;stroke:currentColor}.coding-rhythm text{fill:var(--sky-foreground);font-size:9px;text-anchor:middle;opacity:.5}.coding-rhythm-day,.coding-rhythm-peak,.coding-rhythm-marker{fill:currentColor}@media(prefers-reduced-motion:reduce){.coding-rhythm-marker{display:none}}`;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const hourLabel = hour => `${String(hour).padStart(2, '0')}:00`;
export function rhythmDescription(data, settings) {
  if (!settings.codingRhythm || settings.codingRhythmStyle === 'hidden') return '';
  if (!data?.peakWindow) return ' Not enough recent public activity to describe a coding rhythm.';
  return ` Recent public coding activity is most concentrated around ${hourLabel(data.peakWindow.start)}–${hourLabel(data.peakWindow.end)} (${data.timezone}), based on available events in the last ${Number.parseInt(data.window)} days.`;
}

export function renderCodingRhythm(data, settings, { centerY, spreadY, height, legend }) {
  if (!settings.codingRhythm || settings.codingRhythmStyle === 'hidden' || !data?.eventCount) return '';
  const rx = 410, ry = spreadY + 12;
  const point = (hour, extra = 0) => { const angle = hour / 24 * Math.PI * 2 - Math.PI / 2; return [450 + (rx + extra) * Math.cos(angle), centerY + (ry + extra) * Math.sin(angle)].map(value => value.toFixed(1)); };
  const arc = (start, end) => `M${point(start).join(' ')} A${rx} ${ry} 0 ${end - start > 12 ? 1 : 0} 1 ${point(end).join(' ')}`;
  const sparse = !data.peakWindow;
  let markup = `<ellipse cx="450" cy="${centerY}" rx="${rx}" ry="${ry}" opacity=".07" stroke-width=".6"/>`;
  if (settings.codingRhythmCelestialMarkers) markup += `<path d="${arc(6, 18)}" style="stroke:var(--sky-star)" opacity=".08" stroke-width="3"/><path d="${arc(18, 30)}" opacity=".08" stroke-width="3"/>`;
  if (settings.codingRhythmStyle === 'active-arc' && !sparse) markup += `<path class="coding-rhythm-hour" d="${arc(data.peakWindow.start, data.peakWindow.start + 4)}" stroke-width="2" opacity=".48"/>`;
  else markup += data.hourly.map((value, hour) => `<path class="coding-rhythm-hour" d="${arc(hour + .08, hour + .92)}" stroke-width="${settings.codingRhythmStyle === 'halo' ? 5 : 1.3}" opacity="${((.035 + value * .42) * (sparse ? .2 : 1)).toFixed(3)}"/>`).join('');
  if (settings.codingRhythmLabels !== 'none') markup += [0, 6, 12, 18].map((hour, i) => { const [x, y] = point(hour, 9); return `<text x="${x}" y="${Number(y) + 3}">${settings.codingRhythmLabels === 'cardinal' ? ['Midnight', 'Morning', 'Noon', 'Evening'][i] : String(hour).padStart(2, '0')}</text>`; }).join('');
  if (settings.codingRhythmDays !== 'off') markup += data.weekday.map((value, day) => { const [x, y] = point(8 + day * 1.3, -10); return `<circle class="coding-rhythm-day" cx="${x}" cy="${y}" r="1.5" opacity="${((.1 + value * .45) * (sparse ? .2 : 1)).toFixed(3)}"/>${settings.codingRhythmDays === 'full' ? `<text x="${x}" y="${Number(y) - 6}">${'MTWTFSS'[day]}</text>` : ''}`; }).join('');
  if (!sparse) { const [x, y] = point(data.peakHour + .5); markup += `<circle class="coding-rhythm-peak" cx="${x}" cy="${y}" r="2" opacity=".65"/>`; }
  if (settings.codingRhythmAnimate && !sparse) markup += `<circle class="coding-rhythm-marker" r="2"><animateMotion path="${arc(0, 12)} A${rx} ${ry} 0 0 1 ${point(24).join(' ')}" dur="48s" repeatCount="indefinite"/><animate attributeName="opacity" values="${[...data.hourly, data.hourly[0]].map(value => (.1 + value * .55).toFixed(2)).join(';')}" dur="48s" repeatCount="indefinite"/></circle>`;
  const label = [legend ? `Coding rhythm · last ${Number.parseInt(data.window)} days · ${data.timezone}` : '', settings.codingRhythmPeakLabel && !sparse ? `Peak activity · ${hourLabel(data.peakWindow.start)}–${hourLabel(data.peakWindow.end)}` : ''].filter(Boolean).join(' · ');
  if (label) markup += `<text x="450" y="${height - 45}">${escape(label)}</text>`;
  return `<g class="coding-rhythm" aria-hidden="true">${markup}</g>`;
}
