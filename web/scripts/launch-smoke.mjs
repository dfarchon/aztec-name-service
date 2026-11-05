import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {installLaunchFixture} from './fixtures/launch.mjs';
const base=process.env.BASE??'http://127.0.0.1:5193';
assert.equal(new URL(base).hostname,'127.0.0.1','Local smoke only');
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/chromium',headless:true});
const page=await browser.newPage(),errors=[];let broadcasts=0,count=0;
page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
page.on('request',r=>{if(r.postData()?.includes('sendTx')){broadcasts++;void r.abort();}else void r.continue();});
const wait=text=>page.waitForFunction(text=>document.body.innerText.includes(text),{timeout:60000},text);
const registerButton=()=>page.$$eval('button',buttons=>buttons.some(b=>b.textContent.trim()==='Register name'));
const pass=name=>console.log(`PASS ${++count}: ${name}`);
try {
 await page.goto(`${base}/#/name/launchbootstrap`);await page.waitForSelector('.status-badge',{timeout:60000});
 await installLaunchFixture(page);await wait('Registration fee: Free');assert(await registerButton());pass('open launch name shows Free');
 await page.evaluate(()=>{location.hash='/name/sixsix';});await wait('Not yet available');assert.equal(await registerButton(),false);pass('short name cannot register');
 await page.evaluate(()=>{window.launchFixture.reserved=true;location.hash='/name/reserve';});await wait('Reserved');assert.equal(await registerButton(),false);pass('reserved name cannot register');
 await page.evaluate(()=>{window.launchFixture.launch.paused=true;location.hash='/name/pausedname';});await wait('Public registration is paused');assert.equal(await registerButton(),false);pass('paused registration cannot proceed');
 await page.evaluate(()=>{window.launchFixture.launch.paused=false;window.launchFixture.reserved=false;location.hash='/register/seventh';});await wait('1 year (365 days)');await wait('Free');
 assert.equal(await page.$$eval('select option',options=>options.some(o=>/[2-5] years/.test(o.textContent))),false);
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('Private payment balance:')),false);
 assert.equal(await page.$$eval('button',buttons=>buttons.some(b=>/token approval/i.test(b.textContent))),false);pass('free registration fixes one year and omits token approval and balance');
 assert(await page.evaluate(()=>/Network fees|network fees/.test(document.body.innerText)));pass('network fee guidance remains');
 await page.evaluate(async()=>{
   const f=window.launchFixture,ctx=f.session.getSession().ctx;
   const snap=await f.reader.snapshot();
   f.launch.maxRenewAhead=31536000n;
   f.reader.getName=async()=>({generation:1,revision:0,expiresAt:snap.timestamp+31536000n+1000n,owner:ctx.account});
   location.hash='/manage/seventh';
 });
 await wait('Renewable from');
 const renewDisabled=()=>page.$$eval('button',buttons=>buttons.find(b=>b.textContent.trim()==='Confirm renewal')?.disabled);
 assert.equal(await renewDisabled(),true);pass('early capped renewal is disabled with its availability date');
 await page.evaluate(()=>{window.launchFixture.launch.maxRenewAhead=0n;});
 await page.$$eval('button',buttons=>buttons.find(b=>b.textContent.trim()==='Refresh').click());
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Confirm renewal'&&!b.disabled));
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('Renewable from')),false);pass('refreshing an uncapped quote enables renewal without signing');
 await page.evaluate(()=>{
   const f=window.launchFixture;
   f.reader.inspectResolver=async()=>({address:f.reader.registry,verified:false,isDefault:false,reason:'unknown_class'});
   location.hash='/status';
 });
 await wait('Contract modules');await page.evaluate(()=>{location.hash='/manage/seventh';});
 await wait('Go to resolver controls');
 assert.equal(await page.$$eval('button',buttons=>buttons.find(b=>b.textContent.trim()==='Set primary name')?.disabled),true);
 await page.$$eval('button',buttons=>buttons.find(b=>b.textContent.trim()==='Go to resolver controls').click());
 assert(['use-default-resolver','resolver-controls'].includes(await page.evaluate(()=>document.activeElement?.id)));
 pass('unverified resolver disables primary and recovery guidance focuses resolver controls');
 await page.evaluate(()=>{
  const f=window.launchFixture;
  f.reader.inspectResolver=async()=>({address:f.reader.registry,verified:true,isDefault:false});
  f.reader.getAddress=async()=>({present:true,addr:f.session.getSession().ctx.account,bindingVersion:1});
  location.hash='/status';
 });
 await wait('Contract modules');await page.evaluate(()=>{location.hash='/manage/seventh';});
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Set primary name'&&!b.disabled));
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('Go to resolver controls')),false);
 pass('verified resolver with matching address enables primary');
 // Keep unresolved reads pending so loading cannot accidentally be treated as unverified.
 await page.evaluate(()=>{
  const f=window.launchFixture;
  f.reader.inspectResolver=()=>document.getElementById('resolver-controls') ? new Promise(()=>{}) : Promise.resolve({address:f.reader.registry,verified:true,isDefault:false});
  location.hash='/status';
 });
 await wait('Contract modules');await page.evaluate(()=>{location.hash='/manage/seventh';});
 await wait('Resolver');
 assert.equal(await page.$$eval('button',buttons=>buttons.find(b=>b.textContent.trim()==='Set primary name')?.disabled),true);
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('Go to resolver controls')),false);
 pass('pending resolver verification disables primary without premature switch guidance');
 await page.evaluate(()=>{window.launchFixture.reader.inspectResolver=async()=>{throw Error('fixture resolver unavailable');};location.hash='/status';});
 await wait('Contract modules');await page.evaluate(()=>{location.hash='/manage/seventh';});
 await wait('Refresh contract status');
 assert.equal(await page.$$eval('button',buttons=>buttons.find(b=>b.textContent.trim()==='Set primary name')?.disabled),true);
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('Go to resolver controls')),false);
 pass('resolver RPC failure remains unknown and does not recommend a disabled switch');
 await page.evaluate(()=>{
  const f=window.launchFixture;
  f.reader.inspectResolver=async()=>({address:f.reader.registry,verified:false,isDefault:false,reason:'unknown_class'});
  f.reader.getName=async()=>({generation:1,revision:0,expiresAt:(await f.reader.snapshot()).timestamp+1000n,owner:f.reader.registry.constructor.ZERO});
  location.hash='/status';
 });
 await wait('Contract modules');await page.evaluate(()=>{location.hash='/manage/seventh';});
 await wait('Owner');
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('Go to resolver controls')),false);
 pass('non-holder receives no resolver recovery link');
 await page.evaluate(()=>{
  const f=window.launchFixture;
  f.reader.getName=async()=>({generation:1,revision:0,expiresAt:(await f.reader.snapshot()).timestamp-1n,owner:f.session.getSession().ctx.account});
  location.hash='/status';
 });
 await wait('Contract modules');await page.evaluate(()=>{location.hash='/manage/seventh';});
 await wait('Expired · Renewable');
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('Go to resolver controls')),false);
 pass('grace holder receives no resolver recovery link');
 await page.evaluate(()=>{
  const f=window.launchFixture;
  f.reader.getName=async()=>({generation:1,revision:0,expiresAt:(await f.reader.snapshot()).timestamp-31n*86400n,owner:f.session.getSession().ctx.account});
  location.hash='/status';
 });
 await wait('Contract modules');await page.evaluate(()=>{location.hash='/manage/seventh';});
 await wait('Available to register again');
 assert.equal(await page.evaluate(()=>document.body.innerText.includes('Go to resolver controls')),false);
 pass('expired holder receives no resolver recovery link');

 await page.setViewport({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(broadcasts,0);assert.deepEqual(errors,[]);pass('mobile layout, no runtime errors or broadcasts');
 console.log(`ALL ${count} LAUNCH UI CHECKS PASSED`);
} finally {await browser.close();}
