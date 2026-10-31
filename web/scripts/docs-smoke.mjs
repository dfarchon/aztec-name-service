import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const base=process.env.BASE ?? 'http://127.0.0.1:5274';
const feeLabel=process.env.ANS_FEE_LABEL ?? '1 mAZTEC';
const output=process.env.ANS_DOCS_REPORT_DIR ?? '/tmp/ans-docs-review';
await mkdir(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
const page=await browser.newPage(), errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
let broadcasts=0;
await page.setRequestInterception(true);
page.on('request',request=>{if(/(?:aztec|node)_sendTx/.test(request.postData() ?? '')){broadcasts++;void request.abort();}else void request.continue();});
const pass=name=>{checks.push(name);console.log(`PASS ${name}`);};
const wait=text=>page.waitForFunction(text=>document.body?.innerText.includes(text) ?? false,{timeout:90000},text);
const route=async id=>{await page.evaluate(id=>{location.hash=`/docs/${id}`;},id);await page.waitForSelector('.doc-article h1');await page.waitForFunction(id=>document.querySelector('.doc-sidebar a[aria-current=page]')?.getAttribute('href')===`#/docs/${id}`,{},id);};
try {
 await page.setViewport({width:1440,height:1000});
 await page.goto(`${base}/#/docs`,{waitUntil:'domcontentloaded'});
 await wait('Register your first name');
 await page.type('.doc-sidebar input[type=search]','SDK');
 assert.equal(await page.$('.doc-category-links a[href="#/docs/subnames"]'),null);await wait('SDK setup and name resolution');
 await page.$eval('.doc-sidebar input',input=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.evaluate(()=>{location.hash='/docs/getting-started';});await wait('Complete registration');
 await page.evaluate(()=>{location.hash='/docs';});await wait('Your name. Your next step.');
 pass('Search filters the index and navigation without a wallet');
 await page.screenshot({path:`${output}/docs-desktop.png`,fullPage:true});
 const ids=['getting-started','pricing','tokens','glossary','manage','profile','permissions','subnames','sdk','sdk-write','deployments','recovery','troubleshooting'];
 for(const locale of ['en','zh-CN']){
  await page.select('.language-select',locale);
  for(const id of ids){
   await route(id);
   assert.equal(await page.$$eval('main h1',items=>items.length),1);
   assert.doesNotMatch(await page.$eval('.doc-article',e=>e.innerText),/governance|治理|timelock/i);
   assert.ok(await page.$$eval('.doc-section h2',items=>items.every(h=>h.textContent.trim())));
   assert.ok(await page.$$eval('.doc-section',items=>items.length>=2));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${locale}/${id} desktop overflow`);
  }
 }
 pass(`All ${ids.length} articles have a single title and structured chapters in both languages`);
 await page.select('.language-select','en');await route('sdk');await wait('RegistryReader.connect');
 await page.evaluate(()=>{window.__copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}});});
 await page.click('.doc-code .doc-copy');await wait('Copied');assert.match(await page.evaluate(()=>window.__copied),/RegistryReader.connect/);
 await page.click('.doc-article-tools .doc-copy');assert.match(await page.evaluate(()=>window.__copied),/```typescript/);
 const destination=await page.$eval('.doc-toc nav button:last-child',button=>button.textContent);await page.click('.doc-toc nav button:last-child');
 await page.waitForFunction(title=>document.activeElement?.querySelector('h2')?.textContent===title,{},destination);
 pass('Code and Markdown copy preserve the content; chapter navigation moves keyboard focus');
 await page.screenshot({path:`${output}/sdk-desktop.png`,fullPage:true});
 await route('pricing');await wait(feeLabel);pass('Pricing displays the verified live token and quote');
 await page.screenshot({path:`${output}/pricing-desktop.png`,fullPage:true});
 await page.setViewport({width:390,height:844});await page.select('.language-select','zh-CN');
 for(const id of ids){await route(id);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${id} mobile overflow`);}
 await route('getting-started');await page.click('.doc-mobile-navigation > summary');await page.click('.doc-mobile-navigation a[href="#/docs/profile"]');await wait('公开资料记录');
 pass('All articles fit a 390px screen and the mobile directory navigates');
 await route('getting-started');await page.screenshot({path:`${output}/guide-zh-mobile.png`,fullPage:true});
 await page.emulateMediaType('print');assert.equal(await page.$eval('.app-header',e=>getComputedStyle(e).display),'none');assert.equal(await page.$eval('.doc-mobile-navigation',e=>getComputedStyle(e).display),'none');await page.emulateMediaType(null);
 pass('Print view removes application chrome and retains the article');
 await page.evaluate(()=>{location.hash='/docs/unknown';});await wait('未找到这篇文章');pass('Unknown article links have a recovery path');
 assert.equal(broadcasts,0);assert.deepEqual(errors,[]);pass('Documentation is wallet-free and never broadcasts transactions');
 await writeFile(`${output}/browser.json`,JSON.stringify({base,checkedAt:new Date().toISOString(),checks,broadcasts,errors},null,2)+'\n');
} finally {await browser.close();}
