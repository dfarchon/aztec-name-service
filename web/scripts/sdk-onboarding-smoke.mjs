import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require=createRequire(import.meta.url), puppeteer=require('puppeteer-core');
const base=process.env.BASE??'http://127.0.0.1:5277', name=process.env.NAME??'ans-v4-mv2n77ji';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});
const page=await browser.newPage();let broadcasts=0;const errors=[];
await page.setRequestInterception(true);page.on('request',r=>{if(/(?:aztec|node)_sendTx/.test(r.postData()??'')){broadcasts++;void r.abort();}else void r.continue();});
page.on('pageerror',e=>errors.push(e.message));
try {
 await page.goto(`${base}/#/name/${name}`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.body.innerText.includes('Registered · Active'),{timeout:90000});
 await page.evaluate(async()=>{
  const appSource=await(await fetch('/src/App.tsx')).text();
  const sessionPath=appSource.match(/from\s*["']([^"']*session\.ts[^"']*)["']/)[1];
  const session=await import(sessionPath);
  const source=await(await fetch(sessionPath)).text();
  const addressSource=await(await fetch('/src/config.ts')).text();
  const addressPath=addressSource.match(/from\s*["']([^"']*addresses[^"']*)["']/)[1];
  const fieldPath=source.match(/from\s*["']([^"']*fields[^"']*)["']/)[1];
  const {AztecAddress}=await import(addressPath), {Fr}=await import(fieldPath);
  const reader=session.getSession().reader, registered=new Set();
  const account=AztecAddress.fromStringUnsafe('0x0cbc0200fc4ce9655ce4817ca99acf7ab2c50d3aa0a505586161cb51bd63693a');
  const wallet=new Proxy({getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }), getAccounts:async()=>[{alias:'Read-only review fixture',item:account}],getContractMetadata:async()=>({}),registerContract:async(instance)=>{registered.add(instance.address.toString());},
   executeUtility:async(call)=>{if(!registered.has(call.to.toString()))throw new Error(`No contract instance found for address ${call.to}`);return{result:[new Fr(100000000000000000000n)],offchainEffects:[],anchorBlockTimestamp:BigInt(Math.floor(Date.now()/1000))};}},
   {get:(target,prop)=>prop in target?target[prop]:async()=>{throw new Error('Review cannot sign or broadcast');}});
  window.review={session,reader,registered,wallet,getConfig:reader.getConfig.bind(reader),AztecAddress};
  await session.connectExternal(wallet,{disconnect:async()=>{},onDisconnect:()=>()=>{}});
  location.hash='/register/review-alice';
 });
 await page.waitForFunction(()=>document.querySelector('button')&&[...document.querySelectorAll('button')].some(b=>b.textContent==='Start registration'&&!b.disabled),{timeout:90000});
 await page.evaluate(()=>{window.review.reader.getConfig=async()=>{throw new Error('Temporary network error: injected quote read failure');};});
 await page.select('main select','2');
 await page.waitForFunction(()=>document.body.innerText.includes('Unable to read the network'),{timeout:20000});
 await page.evaluate(()=>{window.review.reader.getConfig=window.review.getConfig;});
 await page.evaluate(()=>window.review.session.boot());
 const failedQuote=await page.evaluate(()=>({error:document.body.innerText.includes('Unable to read the network'),startDisabled:[...document.querySelectorAll('button')].find(b=>b.textContent==='Start registration').disabled,buttons:[...document.querySelectorAll('main button')].map(b=>b.textContent)}));
 assert.equal(failedQuote.startDisabled,true);assert.equal(failedQuote.error,true);
 await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Retry fee quote').click());
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Start registration'&&!b.disabled),{timeout:90000});
 await page.evaluate(()=>{const{reader,getConfig,AztecAddress}=window.review;reader.getConfig=async snap=>({...await getConfig(snap),registrar:AztecAddress.fromStringUnsafe('0x0d85501f69a2296704688cf0261b4390a795fca6a8d27b5aee9680aeb986a921'),feeToken:AztecAddress.fromStringUnsafe('0x212913baa4d8f6dd37e8e050c6cf02c43e4fbf7374994af0a3b5d016fb5c9e14'),annualPrice:1000000000000000000n,priceVersion:2});});
 await page.select('main select','3');
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Start registration'&&!b.disabled)&&window.review.registered.has('0x212913baa4d8f6dd37e8e050c6cf02c43e4fbf7374994af0a3b5d016fb5c9e14'),{timeout:90000});
 const changedToken=await page.evaluate(()=>({balanceError:document.body.innerText.includes('Balance could not be checked'),startDisabled:[...document.querySelectorAll('button')].find(b=>b.textContent==='Start registration').disabled,newTokenRegistered:window.review.registered.has('0x212913baa4d8f6dd37e8e050c6cf02c43e4fbf7374994af0a3b5d016fb5c9e14')}));
 assert.equal(changedToken.newTokenRegistered,true);assert.equal(changedToken.startDisabled,false);assert.equal(changedToken.balanceError,false);
 const form=await page.evaluate(()=>({name:document.querySelector('main input').value,years:document.querySelector('main select').value}));assert.equal(form.name,'review-alice');assert.equal(form.years,'3');
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Start registration'&&!b.disabled),{timeout:90000});
 const recovered=await page.evaluate(()=>({newTokenRegistered:window.review.registered.has('0x212913baa4d8f6dd37e8e050c6cf02c43e4fbf7374994af0a3b5d016fb5c9e14'),startDisabled:[...document.querySelectorAll('button')].find(b=>b.textContent==='Start registration').disabled}));
 assert.equal(recovered.newTokenRegistered,true);assert.equal(broadcasts,0);assert.deepEqual(errors,[]);
 const dir=process.env.ANS_REVIEW_OUTPUT??'/tmp/ans-sdk-onboarding-review';mkdirSync(dir,{recursive:true});
 const result={checkedAt:new Date().toISOString(),method:'Actual frontend and public RPC reads, read-only wallet and synthetic quote failure/module switch; no governance change',failedQuote,changedToken,recovered,form,broadcasts,errors};
 writeFileSync(`${dir}/readiness-browser.json`,`${JSON.stringify(result,null,2)}\n`);console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
