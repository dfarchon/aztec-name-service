// Development-wallet regression only: commit secret persistence across reload and account switch.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base = process.env.BASE ?? 'http://localhost:5180';
const browser = await puppeteer.launch({executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true});
const page = await browser.newPage();
const wait=s=>page.waitForFunction(s=>document.body.innerText.includes(s),{timeout:180000},s);
const click=async label=>{
  await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.disabled),{timeout:180000},label);
  for(const button of await page.$$('button')) {
    if(await button.evaluate((b,label)=>b.textContent.trim()===label,label)){await button.click();return;}
  }
  throw new Error(`Missing button ${label}`);
};
const name=`web-${Date.now().toString(36)}`;
let n=0;const pass=s=>console.log(`PASS ${++n}: ${s}`);
try {
  await page.goto(`${base}/#/account`); await page.waitForSelector('input[type=password]');
  for(const input of await page.$$('input[type=password]')) await input.type('local-smoke-passphrase');
  await click('Create'); await wait('Create account'); pass('development wallet starts');
  await click('Create account'); await wait('Current'); pass('account created');
  await page.goto(`${base}/#/register/${name}`); await wait('1000000');
  await click('Start registration'); await wait('Commit transaction'); pass('browser commit hash persisted');
  const encrypted=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('ans:v2:')));
  assert.ok(encrypted.length>0 && encrypted.every(([,v])=>!v.includes('commitment') && !v.includes('secret')));pass('plan encrypted at rest');
  await page.reload(); await page.goto(`${base}/#/account`); await page.waitForSelector('input[type=password]');
  await page.type('input[type=password]','local-smoke-passphrase'); await click('Unlock'); await wait('Current');
  await page.goto(`${base}/#/register`); await wait(name); pass('pending plan restored after reload');
  await page.goto(`${base}/#/account`); await click('Create account');
  await page.waitForFunction(()=>document.querySelectorAll('.accounts li').length===2 && document.querySelectorAll('.accounts li')[1].classList.contains('on'),{timeout:180000});
  await page.goto(`${base}/#/register`); await wait('Registration details');
  assert.ok(!(await page.evaluate(()=>document.body.innerText)).includes(name));pass('another account cannot inherit pending plan');
  console.log(`ALL ${n} RECOVERY CHECKS PASSED`);
} catch(e) { console.log((await page.evaluate(()=>document.body.innerText)).slice(-1200)); throw e; } finally { await browser.close(); }
