// Browser acceptance uses real V5 reads and read-only wallet fixtures; broadcasts are prohibited.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base=process.env.BASE??'http://127.0.0.1:5196',name=process.env.NAME??'modular-name',secondName=process.env.SECOND_NAME??'aztec-pricing';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage(),errors=[];let broadcasts=0,count=0;
page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);page.on('request',r=>{if(r.postData()?.includes('sendTx')){broadcasts++;void r.abort();}else void r.continue();});
const wait=t=>page.waitForFunction(t=>document.body.innerText.includes(t),{timeout:90000},t);
const click=async(t,selector='button')=>{for(const el of await page.$$(selector))if(await el.evaluate((e,t)=>e.textContent.trim()===t,t)){await el.click();return;}throw new Error(`Missing ${t}`);};
const pass=t=>console.log(`PASS ${++count}: ${t}`);
try{
 await page.goto(`${base}/#/docs`);await wait('Register your first name');assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
 await page.type('input[type=search]','SDK');await wait('SDK setup and name resolution');assert.ok(!(await page.evaluate(()=>document.body.innerText)).includes('Create and manage subnames'));pass('English-first searchable docs work without a wallet');
 await page.goto(`${base}/#/docs/sdk`);await wait('RegistryReader.connect');await page.select('.language-select','zh-CN');await wait('SDK 接入与名字解析');await page.select('.language-select','en');pass('SDK examples and Chinese article translations available');
 await page.goto(`${base}/#/help`);await wait('Interrupted registration or pending transaction');await page.goto(`${base}/#/changelog`);await wait('Product updates');pass('help and changelog routes are reachable');
 assert.equal((await fetch(`${base}/llms.txt`)).status,200);
 await page.goto(`${base}/#/name/${name}`);await wait('Registered · Active');await click('Save favorite');await wait('Remove favorite');await click('Share name','summary');await page.waitForSelector('.share-card img[src^="data:image/png"]');assert.ok(await page.$eval('.share-card',(e,name)=>e.innerText.includes(`#/name/${name}`),name));pass('real V5 lookup, persisted favorite and locally generated share QR');
 await page.goto(`${base}/#/names`);await wait(name);await wait('Wallet not connected');pass('favorites available without connecting wallet');
 await page.evaluate(async(name)=>{
   const source=await(await fetch('/src/App.tsx')).text(),path=source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
   const session=await import(path);window.testSession=session;
   const reader=session.getSession().reader;
   const sdkSource=await(await fetch('/src/pages/Register.tsx')).text(),sdkPath=sdkSource.match(/from\s*["']([^"']*(?:ans_sdk|sdk\/dist\/index\.js)[^"']*)["']/)?.[1];
   const sdk=await import(sdkPath);window.testSdk=sdk;
   const holding=await sdk.getName(reader,name),account=holding.record.owner;
   window.extensionFixture={reader,account,holding,getManager:reader.getManager.bind(reader),getName:reader.getName.bind(reader),getTransfer:reader.getTransfer.bind(reader)};
   await session.connectExternal({getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }), getAccounts:async()=>[{alias:'Read-only name fixture',item:account}],getContractMetadata:async()=>({}),registerContract:async()=>{}},{disconnect:async()=>{},onDisconnect:()=>()=>{}});
   location.hash=`/manage/${name}`;
 },name);
 await wait('Profile and address records');await wait('Primary name set');assert.equal(await page.$$eval('.setup-checklist li[data-complete=true]',e=>e.length),3);pass('owner management and three setup steps read actual chain state');
 await click('Editor permissions','summary');await wait('Assign editor');await click('Transfer ownership','summary');await wait('Offer transfer');assert.equal(await page.$$eval('button',buttons=>buttons.find(b=>b.textContent.trim()==='Offer transfer')?.disabled),true);pass('transfer action requires recipient and explicit review');
 await click('Subnames','summary');await wait(`team.${name}`);await wait('Issue subname');pass('subname discovery includes current revoked or inactive descendants');
 await page.goto(`${base}/#/names`);await wait('Owned names');await wait(name);await page.type('input[type=search]','not-owned');await wait('No names match these filters.');await page.click('input[type=search]',{clickCount:3});await page.keyboard.press('Backspace');
 await page.select('select[aria-label="Filter names"]','favorites');await wait('Export expiry calendar');await wait(name);pass('portfolio search, filters and expiry tools visible');
 await page.evaluate(()=>{window.expiryNotices=[];class TestNotification{static permission='granted';static async requestPermission(){return 'granted';}constructor(title,opts){window.expiryNotices.push({title,...opts});}}window.Notification=TestNotification;const f=window.extensionFixture;f.reader.getName=async(n,s)=>{const r=await f.getName(n,s);return n===f.holding.node?{...r,expiresAt:s.timestamp+86400n}:r;};});
 await click('Refresh list');await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Refresh list')?.disabled);assert.equal(await page.evaluate(()=>expiryNotices.length),0);pass('expiry notifications stay silent before explicit opt-in');
 await click('Enable expiry reminders');await wait('Disable expiry reminders');await click('Refresh list');await page.waitForFunction(()=>expiryNotices.length===1);await click('Refresh list');await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Refresh list')?.disabled);assert.equal(await page.evaluate(()=>expiryNotices.length),1);await click('Disable expiry reminders');pass('fresh near-expiry records notify once and reminders can be disabled');
 await page.evaluate(()=>{const f=window.extensionFixture;f.reader.getName=f.getName;});
 await page.evaluate(name=>{const f=window.extensionFixture;f.reader.getName=async(n,s)=>({...await f.getName(n,s),owner:f.reader.registry});f.reader.getManager=async()=>f.account;location.hash=`/manage/${name}`;},name);
 await wait('Save address');await wait('Profile and address records');assert.ok(!(await page.evaluate(()=>document.body.innerText)).includes('Transfer ownership'));assert.ok(!(await page.evaluate(()=>document.body.innerText)).includes('Renew name'));pass('editor gets record controls without ownership or renewal controls');
 await page.evaluate(secondName=>{const f=window.extensionFixture;f.reader.getManager=async()=>f.account.constructor.ZERO;f.reader.getTransfer=async()=>({recipient:f.account,expiresAt:f.holding.snapshot.timestamp+999999999n});location.hash=`/manage/${secondName}`;},secondName);await wait('Incoming transfer');await wait('Accept transfer');pass('recipient can accept from a non-owner wallet');
 for(const locale of ['en','zh-CN']){await page.select('.language-select',locale);for(const width of [1280,390,320]){await page.setViewport({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${locale} ${width} overflow`);}}
 await page.select('.language-select','en');await page.setViewport({width:1280,height:900});await page.goto(`${base}/#/docs`);await wait('Register your first name');await page.screenshot({path:'/tmp/ans-v5-docs.png',fullPage:true});pass('both locales fit desktop and narrow mobile layouts');
 assert.equal(broadcasts,0);assert.deepEqual(errors,[]);pass('zero wallet broadcasts and uncaught runtime errors');
 console.log(`ALL ${count} EXTENSION UI CHECKS PASSED`);
}catch(error){console.error(await page.evaluate(()=>document.body.innerText).catch(()=>''));throw error;}finally{await browser.close();}
