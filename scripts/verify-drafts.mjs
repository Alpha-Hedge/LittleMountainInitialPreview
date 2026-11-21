import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

// Launch an isolated app, close the browser and process, then reopen the same database.
// Use --dev to run this check before the production build is available.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--dev') ? 'dev' : 'start';
const port = 3102;
const base = `http://127.0.0.1:${port}`;
const nextCli = fileURLToPath(new URL("./web.mjs", import.meta.url));
const outputBase = path.join(root, '.test-results');
await mkdir(outputBase, {recursive:true});
const run = await mkdtemp(path.join(outputBase, 'drafts-'));
const fixtureDir = path.join(root, 'fixtures', 'drawings');
const png = path.join(fixtureDir, 'mounting-plate-preview.png');
const pdf = path.join(fixtureDir, 'bracket-set-incomplete.pdf');
const browserPath = process.env.CHROME_PATH ||
  [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(p => p && existsSync(p));

let server;
let browser;
let logs = '';

async function startServer() {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise(resolve => probe.close(resolve));
  const env = {...process.env, LMM_DATA_DIR:path.join(run, 'data'), NEXT_TELEMETRY_DISABLED:'1'};
  if (mode === 'dev') env.LMM_DIST_DIR = '.test-results/next-dev';
  server = spawn(process.execPath, [nextCli, mode, '--hostname', '127.0.0.1', '--port', String(port)],
    {cwd:root, env, stdio:['ignore','pipe','pipe'], windowsHide:true, detached:process.platform !== 'win32'});
  for (const stream of [server.stdout,server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-4000); });
  const end = Date.now() + 90000;
  while (Date.now() < end && server.exitCode === null) {
    try { if ((await fetch(base + '/api/quotes', {signal:AbortSignal.timeout(5000)})).ok) return; } catch {}
    await delay(250);
  }
  throw new Error('Isolated Next.js server did not start. ' + logs);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {stdio:'ignore', windowsHide:true});
  else process.kill(-server.pid, 'SIGTERM');
  await exited;
  server = undefined;
}

async function openBrowser() {
  browser = await chromium.launch({headless:true, executablePath:browserPath || undefined});
  const page = await browser.newPage({viewport:{width:1440,height:1024}});
  page.setDefaultTimeout(15000);
  return page;
}

async function save(page) {
  const response = page.waitForResponse(result => result.url().includes('/api/quotes') && !result.url().endsWith('/calculate') &&
    ['PUT','POST'].includes(result.request().method()));
  await page.getByRole('button', {name:'Save changes',exact:true}).click();
  const result = await response;
  assert.equal(result.ok(), true, 'Draft save succeeds');
  await expect(page.getByText('All changes saved', {exact:true})).toBeVisible();
  return result.json();
}

async function drawingState(quoteId) {
  const res = await fetch(`${base}/api/drawings/${quoteId}`);
  assert.equal(res.status, 200);
  return res.json();
}

async function upload(page, file, label, attachmentId) {
  await page.getByRole('button', {name:'Add drawing',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="file"]').setInputFiles(file);
  if (attachmentId) await dialog.getByLabel('Which drawing is this?').selectOption(attachmentId);
  await dialog.getByLabel('Revision on the drawing').fill(label);
  await dialog.getByRole('button',{name:'Use this drawing'}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.dp-revision')).toHaveText('Rev ' + label);
}

try {
  await startServer();
  let page = await openBrowser();
  await page.goto(base + '/quotes/demo-mounting-plate');
  await expect(page.getByRole('heading', {name:'Mounting plate assembly'})).toBeVisible();
  await expect(page.getByTestId('selling-price')).toHaveText('$266.67');
  await expect(page.locator('.summary-row strong')).toHaveText('$200.00');
  await expect(page.locator('.row-cost')).toHaveText(['$80.00','$90.00','$30.00']);
  await expect(page.locator('#drawings img')).toBeVisible();
  await page.locator('#drawings img').evaluate(img => img.decode());
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path:path.join(run,'demo-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(run,'demo-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile view fits');
  await page.setViewportSize({width:1440,height:1024});
  await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
  const firstQuote = await (await fetch(base+'/api/quotes/demo-mounting-plate')).json();
  await page.goto(base + '/quotes/' + firstQuote.id);
  await page.getByLabel('Quantity',{exact:true}).first().fill('11');
  await expect(page.getByTestId('selling-price')).toHaveText('$277.33');
  await page.getByText('Change profit margin',{exact:true}).click();
  await page.getByLabel('Target gross margin (%)',{exact:true}).fill('20');
  await expect(page.getByTestId('selling-price')).toHaveText('$260.00');
  const savedDemo = await save(page);
  assert.equal(savedDemo.totals.estimatedCost, 208);
  await page.reload();
  await expect(page.getByLabel('Quantity',{exact:true}).first()).toHaveValue('11');
  await page.getByText('Change profit margin',{exact:true}).click();
  await expect(page.getByLabel('Target gross margin (%)',{exact:true})).toHaveValue('20');
  await page.getByText('Customer & job details',{exact:true}).click();
  const saveEndpoint = '**/api/quotes/' + firstQuote.id;
  const pending = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route(saveEndpoint, async route => {
    const response = await route.fetch();
    pending.resolve();
    await release.promise;
    await route.fulfill({response});
  });
  await page.getByLabel(/^Customer notes/).fill('First note');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await pending.promise;
  await page.getByLabel(/^Customer notes/).fill('Manual edit while saving');
  release.resolve();
  await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeEnabled();
  await expect(page.getByLabel(/^Customer notes/)).toHaveValue('Manual edit while saving');
  await expect(page.getByText('Unsaved changes',{exact:true})).toBeVisible();
  await page.unroute(saveEndpoint);
  assert.equal((await save(page)).notes, 'Manual edit while saving');
  console.log('Demo verified: row costs $80, $90 and $30; $200.00 cost and $266.67 selling price. Quantity/margin edits saved and reopened.');

  await page.goto(base + '/quotes/new');
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('heading',{name:'Parts & work'})).toHaveCount(0);
  await page.getByText('Start without a drawing',{exact:true}).click();
  const manualStart = page.locator('.qe-manual');
  await page.getByLabel('Customer name',{exact:true}).fill('Workshop test');
  await page.getByLabel('Job name',{exact:true}).fill('Cooling rack');
  const note = 'Deliver the parts together on Friday.';
  await manualStart.getByLabel(/^Customer notes/).fill(note);
  await page.getByRole('button',{name:'Save & add work'}).click();
  await expect(page.getByRole('heading',{name:'Parts & work'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Part or service',exact:true})).toHaveValue('Cooling rack');
  await page.getByRole('textbox',{name:'Part or service',exact:true}).fill('Folded channel');
  await page.getByLabel('Quantity',{exact:true}).fill('3');
  await page.getByRole('button', {name:'Add a cost'}).click();
  await page.getByRole('button', {name:'Material',exact:true}).click();
  await page.getByLabel('What is this cost?',{exact:true}).fill('Cold-rolled material');
  await page.getByLabel('Cost per unit ($)',{exact:true}).fill('8.75');
  await page.getByRole('button',{name:'Done editing cost'}).click();
  await page.getByRole('button', {name:'Add a cost'}).click();
  await page.getByRole('button', {name:'Other cost',exact:true}).click();
  const nextCost = page.locator('.qe-cost[open]');
  await nextCost.getByLabel('What is this cost?',{exact:true}).fill('Setup charge');
  await nextCost.getByLabel('Cost per unit ($)',{exact:true}).fill('15');
  await nextCost.getByRole('combobox',{name:'Count this cost',exact:true}).selectOption('batch');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Phone cost entry fits');
  await expect(page.getByTestId('selling-price')).toHaveText('$55.00');
  const created = await save(page);
  await expect(page).toHaveURL(base + '/quotes/' + created.id);
  await upload(page, png, 'A');
  const withImage = await drawingState(created.id);
  const firstRev = withImage.selectedRevisionId;
  await upload(page, pdf, 'B', withImage.attachments[0].id);
  const secondRev = (await drawingState(created.id)).selectedRevisionId;
  await upload(page, png, 'Reference');
  const thirdRev = (await drawingState(created.id)).selectedRevisionId;
  await page.getByRole('button', {name:'Files & revisions'}).click();
  await page.getByRole('button',{name:/^Rev A /}).click();
  await page.getByRole('button',{name:'Use this revision for quote'}).click();
  await expect(page.locator('.dp-rev-row.viewed small')).toHaveText('Used by quote');
  await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
  assert.equal((await drawingState(created.id)).selectedRevisionId, firstRev);
  await browser.close();
  await stopServer();

  await startServer();
  page = await openBrowser();
  await page.goto(base + '/quotes');
  await page.getByRole('link',{name:/Cooling rack/i}).first().click();
  await page.getByText('Customer & job details',{exact:true}).click();
  await expect(page.getByLabel(/^Customer notes/)).toHaveValue(note);
  await expect(page.getByTestId('selling-price')).toHaveText('$55.00');
  await expect(page.locator('.dp-revision')).toHaveText('Rev A');
  const state = await drawingState(created.id);
  assert.equal(state.attachments.length, 2);
  assert.equal(state.attachments.flatMap(a => a.revisions).length, 3);
  assert.equal(state.selectedRevisionId, firstRev);
  for (const [id,file] of [[firstRev,png],[secondRev,pdf],[thirdRev,png]]) {
    const original = await fetch(`${base}/api/drawings/${created.id}/${id}`);
    assert.ok(original.ok);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()),await readFile(file));
  }
  await page.getByRole('button', {name:'Files & revisions'}).click();
  await page.getByRole('button',{name:/^Rev B /}).click();
  await expect(page.locator('.dp-revision')).toHaveText('Rev B');
  assert.equal((await drawingState(created.id)).selectedRevisionId, firstRev, 'Opening a file preserves the selected revision');
  await page.getByLabel('Quantity',{exact:true}).first().fill('4');
  await page.getByRole('button',{name:'Save & review quote'}).click();
  await expect(page).toHaveURL(base+'/quotes/'+created.id+'/approval');
  const submitted = await (await fetch(base+'/api/quotes/'+created.id)).json();
  assert.equal(submitted.totals.sellingPrice,66.67,'Review opens the newly saved price');
  await page.goto(base+'/quotes/'+created.id);
  await page.getByRole('button',{name:'Use a shop template'}).click();
  await expect(page).toHaveURL(base+'/quotes/'+created.id+'/estimate');
  assert.equal((await (await fetch(base+'/api/quotes/'+created.id)).json()).version,submitted.version,'Opening tools on a saved quote preserves its version');
  console.log('Created and reopened a separate draft. After an actual server restart and new browser session, the customer notes, totals, chosen revision, two attachments, and all three originals matched. Earlier and alternate revisions reopened.');
  console.log('Screenshots and isolated test database:', run);
} finally {
  if (browser?.isConnected()) await browser.close();
  await stopServer();
}
