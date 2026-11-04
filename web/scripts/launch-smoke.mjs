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
 await page.setViewport({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(broadcasts,0);assert.deepEqual(errors,[]);pass('mobile layout, no runtime errors or broadcasts');
 console.log(`ALL ${count} LAUNCH UI CHECKS PASSED`);
} finally {await browser.close();}
