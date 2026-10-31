// Local review only: public reads, synthetic private balances, no signing or broadcasts.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createServer as createViteServer } from 'vite';
import { createSafeJsonRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import { WalletSchema } from '@aztec-labs/aztec.js/wallet';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
const deployment=JSON.parse(readFileSync('deployments/testnet.json','utf8'));
const root=resolve('web'), appOrigin='http://127.0.0.1:5270',walletOrigin='http://127.0.0.1:5271';
const accounts=[{alias:'Unfunded review account',item:AztecAddress.fromStringUnsafe('0x2c46030c63f29f10ceba21efc4da59f53e66cf9ffcfc569e4aca3ffaa563a6f2')},{alias:'Funded review account',item:AztecAddress.fromStringUnsafe('0x0cbc0200fc4ce9655ce4817ca99acf7ab2c50d3aa0a505586161cb51bd63693a')}];
const wallet=new Proxy({getAccounts:async()=>accounts,getChainInfo:async()=>({chainId:new Fr(deployment.chainId),version:new Fr(deployment.rollupVersion)}),registerContract:async()=>{},registerContractClass:async()=>{},
 executeUtility:async(_call,options)=>({result:[new Fr(options.scopes?.[0]?.equals(accounts[0].item)?0n:10000000n)],offchainEffects:[],anchorBlockTimestamp:BigInt(Math.floor(Date.now()/1000))}),
},{get:(target,prop)=>prop in target?target[prop]:async()=>{throw new Error('User rejected: review wallet cannot sign or broadcast transactions');}});
const rpc=createSafeJsonRpcServer(wallet,WalletSchema,{corsAllowedOrigins:[walletOrigin],corsAllowedHeaders:['content-type','x-ans-wallet-token'],maxBodySizeBytes:'8mb'});
const http=createServer(rpc.getApp().callback());http.listen(5272,'127.0.0.1');await once(http,'listening');
const cfg={rpc:'http://127.0.0.1:5272',token:'readonly-review',appOrigin,chainId:deployment.chainId,rollupVersion:deployment.rollupVersion};
const walletServer=await createViteServer({root,cacheDir:resolve('node_modules/.vite-experience-wallet'),plugins:[{name:'readonly-review-wallet-config',transformIndexHtml(html,ctx){return ctx.path.includes('external-wallet')?html.replace('<script type="module"',`<script>window.__ANS_WALLET_TEST_CONFIG__=${JSON.stringify(cfg)}</script><script type="module"`):html;}}],server:{host:'127.0.0.1',port:5271,strictPort:true,headers:{'Cross-Origin-Resource-Policy':'cross-origin'}}});await walletServer.listen();
Object.assign(process.env,{VITE_NODE_URL:deployment.nodeUrl,VITE_REGISTRY:deployment.registry,VITE_WEB_WALLET_URLS:walletOrigin+'/scripts/fixtures/external-wallet.html',VITE_PROVER_ENABLED:'true',VITE_DEVELOPMENT_WALLET:'false',VITE_CHAIN_ID:deployment.chainId,VITE_ROLLUP_VERSION:deployment.rollupVersion,VITE_SPONSORED_FPC:deployment.sponsoredFpc,VITE_RELEASE:'experience-preview'});
const app=await createViteServer({root,cacheDir:resolve('node_modules/.vite-experience-app'),plugins:[{name:'experience-downloads-and-history',configureServer(server){server.middlewares.use((req,res,next)=>{
 if(req.url?.startsWith('/downloads/sdk/')){const name=basename(req.url.split('?')[0]);if(!/^(manifest\.json|ans-(sdk|consumer)-[a-zA-Z0-9.-]+\.(tgz|zip))$/.test(name))return next();try{const body=readFileSync(resolve('web/dist/downloads/sdk',name));res.setHeader('Content-Type',name.endsWith('.json')?'application/json':'application/octet-stream');res.end(body);return;}catch{return next();}}
 if(req.url==='/api/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({checkedAt:Date.now(),release:'experience-preview',checks:[{name:'rpc',ok:true,detail:'Local review fixture'}],open:[],metrics:[],incidents:[{name:'rpc',kind:'recovered',at:Date.now()-60000},{name:'rpc',kind:'alert',at:Date.now()-120000}]}));return;}next();});}}],server:{host:'127.0.0.1',port:5270,strictPort:true}});await app.listen();console.log('READY '+appOrigin+'; synthetic balances, no signing');
async function close(){await app.close();await walletServer.close();http.close();process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
