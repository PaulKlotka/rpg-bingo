import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Verify the production CSS and actual embed markup inside fixed-size iframes.
const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
assert.ok(chrome, 'Set CHROME_PATH to a Chromium browser executable.');
const css = readdirSync('dist/assets').filter(name => name.endsWith('.css')).map(name => readFileSync(`dist/assets/${name}`, 'utf8')).join('\n');
const source = readFileSync('src/embedded.ts', 'utf8');
const markup = source.split('root.innerHTML = `')[1].split('`;')[0];
assert.ok(css.includes('.embed-shell'), 'Run npm run build before checking the layout.');
const sizes = [[1200,700], [1024,600], [900,500], [800,400], [640,320], [568,320], [390,600], [375,500], [320,480]];
const cases = sizes.flatMap(([width,height]) => ['playing','review','retry'].map(state => ({width,height,state})));
const temp = mkdtempSync(path.join(tmpdir(), 'bingo-layout-'));
try {
  const html = `<!doctype html><html><body><script>
  const cases = ${JSON.stringify(cases)};
  const content = ${JSON.stringify(`<html class="embedded-page"><head><style>${css}</style></head><body><div id="app">${markup}</div></body></html>`)};
  Promise.all(cases.map(config => new Promise(resolve => {
    const frame = document.createElement('iframe'); frame.style.width = config.width+'px'; frame.style.height = config.height+'px';
    frame.onload = () => {
      const doc = frame.contentDocument;
      const set = (id,text) => doc.getElementById(id).textContent = text;
      doc.getElementById('embed-game').hidden = false;
      doc.getElementById('embed-undo').hidden = false;
      set('embed-pattern', 'Two Lines');
      set('embed-help', 'Complete any two rows, columns, or diagonals. The free center counts.');
      set('embed-reward', 'A Small but Timely Advantage');
      set('embed-benefit', 'After a qualifying ability check, add a bonus to the result before the outcome is decided.');
      set('embed-roll', 'Last roll: 20 · 999 rolls');
      set('embed-message', config.state === 'review' ? 'Bingo: Alpha, Beta, Gamma. Reward recorded. Between Turns will choose the next game.' : config.state === 'retry' ? 'Bingo is unavailable. Try again.' : 'Complete the pattern to win.');
      doc.getElementById('embed-retry').hidden = config.state !== 'retry';
      for(let i=0;i<25;i++) {
        const cell=doc.createElement('button'); cell.className='cell pattern-target'; cell.textContent=i===12?'FREE':String(i%20+1); doc.getElementById('embed-card').append(cell);
      }
      setTimeout(() => {
        const errors=[];
        for (const el of doc.querySelectorAll('h1, #embed-message, #embed-retry, .embed-details, .cell, .embed-controls, .embed-instructions')) {
          if(el.hidden) continue;
          const r=el.getBoundingClientRect();
          if(r.left < -1 || r.top < -1 || r.right > config.width+1 || r.bottom > config.height+1 || !r.width || !r.height) errors.push(el.id || el.className || el.tagName);
        }
        for(const el of [doc.documentElement,doc.body,doc.getElementById('embed-game')]) {
          if(el.scrollHeight > el.clientHeight+1 || el.scrollWidth > el.clientWidth+1) errors.push('overflow:'+el.tagName);
        }
        resolve({...config,errors,cellSize:doc.querySelector('.cell').getBoundingClientRect().height});
      }, 50);
    };
    frame.srcdoc=content; document.body.append(frame);
  }))).then(results => { const pre=document.createElement('pre'); pre.id='results'; pre.textContent=JSON.stringify(results); document.body.replaceChildren(pre); });
  </script></body></html>`;
  const fixture = path.join(temp,'fixture.html'); writeFileSync(fixture,html);
  const result = spawnSync(chrome, ['--headless','--no-sandbox','--disable-gpu','--no-first-run',`--user-data-dir=${path.join(temp,'profile')}`,'--dump-dom','--timeout=15000','--virtual-time-budget=5000',pathToFileURL(fixture).href], {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr || result.error?.message);
  const match=result.stdout.match(/<pre id="results">(.*?)<\/pre>/s);
  assert.ok(match, 'Browser did not finish layout checks.');
  const results=JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&amp;','&'));
  for(const result of results) { assert.deepEqual(result.errors,[],JSON.stringify(result)); assert.ok(result.cellSize >= 24, 'Card cells too small: '+JSON.stringify(result)); }
  console.log(`Passed ${results.length} iframe layout checks, including undo, winner announcements, and retry states.`);
} finally {
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}

