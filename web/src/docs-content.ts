import deployment from '../../deployments/testnet-v6.json';
import pricing from '../../deployments/aztec-pricing.json';
import { formatUnits } from './usability';
import {
  configurationExample,
  connectionExample,
  profileExample,
  registrationExample,
} from './docs-examples';
const aztecAnnualPrice = formatUnits(BigInt(pricing.annualPrice), pricing.decimals);
const aztecPrice3 = formatUnits(BigInt(pricing.lengthPrices['3']), pricing.decimals);
const aztecPrice4 = formatUnits(BigInt(pricing.lengthPrices['4']), pricing.decimals);
/** The fee the active test Registrar charges today, so readers do not have to wait for the Register quote. */
const testAnnualPrice = formatUnits(BigInt(deployment.annualPrice), deployment.feeDecimals);
const testPrice3 = formatUnits(BigInt(deployment.lengthPrices['3']), deployment.feeDecimals);
const testPrice4 = formatUnits(BigInt(deployment.lengthPrices['4']), deployment.feeDecimals);
/** "128 / 32 / 1 mAZTEC" style summary of the active test Registrar's length tiers. */
const testTiers = [
  `${testPrice3} ${deployment.feeSymbol} (3 characters)`,
  `${testPrice4} ${deployment.feeSymbol} (4 characters)`,
  `${testAnnualPrice} ${deployment.feeSymbol} (5+ characters)`,
].join(', ');
const testTiersZh = `3 个字符 ${testPrice3} ${deployment.feeSymbol}、4 个字符 ${testPrice4} ${deployment.feeSymbol}、5 个字符及以上 ${testAnnualPrice} ${deployment.feeSymbol}`;
const testSymbol = deployment.feeSymbol;
export type Article = {
  id: string;
  group: 'guide' | 'developer' | 'help';
  title: [string, string];
  body: [string, string][];
  code?: string;
};
export const articles: Article[] = [
  {
    id: 'getting-started',
    group: 'guide',
    title: ['Register your first name', '注册第一个名字'],
    body: [
      [
        'Search for a name, connect an Aztec wallet, and review the lease and exact fee. Root labels use 3–31 ASCII letters, digits or hyphens; no leading or trailing hyphen, no "--" and no "0x" prefix.',
        '搜索名字、连接 Aztec 钱包，然后核对租期与费用。顶级标签使用 3–31 个英文字母、数字或连字符，首尾不能是连字符，不能包含连续的 --，也不能以 0x 开头。',
      ],
      [
        `You need a desktop browser with an Aztec wallet extension; Azguard currently offers one for Chrome (mobile wallets are not supported yet). Install it in the same browser, unlock it and select Testnet. If the wallet asks for network details, enter: node ${deployment.nodeUrl}, chain ID ${deployment.chainId} and rollup version ${deployment.rollupVersion}. The chain ID identifies Ethereum Sepolia, the public test network that Aztec Testnet settles on; the rollup version identifies the current Aztec Testnet release. Both must match exactly, otherwise ANS stops before any transaction so nothing is sent to the wrong network.`,
        `需要使用桌面浏览器并安装 Aztec 钱包扩展；目前 Azguard 提供 Chrome 扩展（暂不支持手机钱包）。在当前浏览器安装后解锁，并选择 Testnet。如钱包要求填写网络信息，请填：节点 ${deployment.nodeUrl}，chain ID ${deployment.chainId}，rollup 版本 ${deployment.rollupVersion}。chain ID 表示 Aztec 测试网所依托的以太坊 Sepolia 测试网；rollup 版本表示当前 Aztec 测试网的版本。两者必须完全一致，否则 ANS 会在发送任何交易前停止，避免发到错误的网络。`,
      ],
      [
        'Use a test account funded in the exact payment token and quote shown on Register. AZTEC is the selected pricing currency; mAZTEC is a clearly labeled 18-decimal test stand-in with no official backing. See “Which token do I need?” for the difference between AZTEC, mAZTEC, ANSF and Fee Juice. Network fees are paid by a shared sponsor contract, so you do not need Fee Juice.',
        '请使用已持有注册页所示支付 Token 的测试账户，并核对链上准确报价。已选择 AZTEC 计价；mAZTEC 是明确标注、无官方资产背书的 18 位测试币。AZTEC、mAZTEC、ANSF 与 Fee Juice 的区别见「我需要哪种代币？」。网络手续费由共享的代付合约支付，你无需持有 Fee Juice。',
      ],
      [
        'Registration has two transactions: first a commit (a sealed fingerprint that hides which name you want, so nobody can grab it first), then the registration after about one minute. Keep the registration plan until the second transaction is confirmed. If interrupted, open Register again and resume the saved plan.',
        '注册分两笔交易：先提交一笔“预约”（commit，只记录一个加密指纹，别人看不出你要注册哪个名字），等待约 1 分钟后再正式注册。第二笔交易确认前请保留注册计划；中断后回到注册页继续即可。',
      ],
      [
        'After registration, open Manage, set an Aztec address, then connect that address’s wallet to confirm its primary name. Registration alone does not set a receiving address.',
        '注册后进入管理页，设置 Aztec 地址，再用该地址的钱包确认主名字。注册本身不会自动设置收款地址。',
      ],
    ],
  },
  {
    id: 'pricing',
    group: 'guide',
    title: ['Pricing and payment assets', '价格与支付资产'],
    body: [
      [
        `Registration and renewal will be priced in AZTEC. Shorter names cost more: the provisional annual rate is ${aztecPrice3} AZTEC for 3 characters, ${aztecPrice4} AZTEC for 4 characters and ${aztecAnnualPrice} AZTEC for 5 or more, for one to five whole years. Renewals use the same tier. This is the target policy; AZTEC collection is not active on this test deployment. Today the test deployment charges the same tiers in ${testSymbol} per year: ${testTiers}; the Register page always shows the exact on-chain quote before you pay.`,
        `注册与续费改用 AZTEC 计价，名字越短越贵：暂定年费为 3 个字符 ${aztecPrice3} AZTEC、4 个字符 ${aztecPrice4} AZTEC、5 个字符及以上 ${aztecAnnualPrice} AZTEC，租期为 1–5 个整年，续费按同一档位收取。这是目标定价，当前测试部署尚未启用 AZTEC 收款。当前测试部署按同样档位以 ${testSymbol} 收取年费：${testTiersZh}；付款前注册页会显示链上准确报价。`,
      ],
      [
        'AZTEC is the official 18-decimal Ethereum token. Fee Juice is network fee credit obtained by depositing AZTEC; it cannot be transferred to a registration treasury. ANSF is an older project test token from earlier deployments. Receiving Fee Juice does not fund any registration payment; see “Which token do I need?”.',
        'AZTEC 是以太坊上的官方代币，精度为 18 位。Fee Juice 是存入 AZTEC 后获得的网络手续费余额，不能转给注册费金库。ANSF 是早期部署使用的项目测试币。领取 Fee Juice 不会获得任何注册费余额，详见「我需要哪种代币？」。',
      ],
      [
        'The payment asset must be verified on the connected network before AZTEC collection can start. A website update or a token with the same symbol cannot change the active Registrar. The payment screen continues to show the current on-chain quote and token address.',
        '启用 AZTEC 收款前须核验当前网络上的支付资产。更新网站或创建同名代币都不会改变当前注册器。支付页面继续显示链上实际报价与 Token 地址。',
      ],
      [
        'The administrator selects the active Registrar directly. A confirmed change takes effect immediately. Review the current token, treasury and exact quote before authorizing payment; prepare a new plan if its policy changed.',
        '管理员直接配置当前 Registrar，交易确认后立即生效。授权付款前核对当前 Token、金库及准确报价；费用策略变化后重新准备计划。',
      ],
    ],
  },
  {
    id: 'tokens',
    group: 'guide',
    title: ['Which token do I need?', '我需要哪种代币？'],
    body: [
      [
        `To register on this test deployment you need ${testSymbol} only, per year: ${testTiers}, held as a private balance in the wallet account that registers. The Register page shows the exact token address and quote; a token you create yourself with the same symbol will not work.`,
        `在当前测试部署上注册，只需要 ${testSymbol}，年费为${testTiersZh}，并且要作为私有余额存在用于注册的钱包账户中。注册页会显示准确的代币地址和报价；自己创建的同名代币不能使用。`,
      ],
      [
        `${testSymbol} is a test stand-in for AZTEC with 18 decimals and no value or official backing. AZTEC is the official token and the planned pricing currency, but it is not accepted here yet. ANSF is an older 6-decimal ANS test token used by earlier deployments; it cannot pay the current Registrar. Fee Juice is Aztec network fee credit; you do not need it because a shared sponsor contract pays network fees, and it can never pay a registration fee.`,
        `${testSymbol} 是 AZTEC 的测试替身，18 位精度，没有价值，也没有官方背书。AZTEC 是官方代币和计划中的计价币，但目前这里还不收。ANSF 是早期部署使用的 6 位精度 ANS 测试币，不能支付当前注册费。Fee Juice 是 Aztec 网络手续费余额；你不需要它，因为网络手续费由共享的代付合约支付，而且它永远不能用来付注册费。`,
      ],
      [
        `There is currently no public self-serve faucet or published public request channel for this deployment. Test balances are arranged by the testnet operator; ordinary users cannot obtain them through this site. The V6 acceptance runner funds its test account through an administrator-authorized mint_to_private call on the deployed token. This is an operator test procedure, not a public faucet. The testnet-v6 manifest identifies ${testSymbol} at ${deployment.feeToken} (${deployment.feeDecimals} decimals). Verify this exact address and your private balance on Register; tokens from older rollups or with the same symbol cannot pay here.`,
        `当前部署没有公开自助水龙头，也没有已公布的公开申请渠道。测试余额由测试网维护者安排，普通用户无法通过本站领取。V6 验收脚本通过管理员授权的 mint_to_private 调用，为测试账户铸造已部署代币的私有余额；这是维护者测试流程，并非公共水龙头。testnet-v6 清单中的 ${testSymbol} 地址为 ${deployment.feeToken}（${deployment.feeDecimals} 位精度）。请在注册页核对该准确地址和私有余额；旧 rollup 的币或同名代币不能在这里支付。`,
      ],
    ],
  },
  {
    id: 'glossary',
    group: 'help',
    title: ['Plain-language glossary', '术语速查'],
    body: [
      [
        'Name: your readable ANS name, like alice. It is not an internet domain or website address. Primary name: the one name your account shows by default; it is only shown when the name also points back to your address, so nobody can claim to be you.',
        '名字：你在 ANS 上的可读名字，例如 alice。它不是互联网域名或网址。主名字：你的账户默认展示的名字；只有当该名字同时指向你的地址时才会显示，防止别人冒充你。',
      ],
      [
        'Commit: the first registration step. It records a sealed fingerprint of your request so nobody can see or front-run the name; after about one minute you send the actual registration.',
        '预约（commit）：注册的第一步。它只记录请求的加密指纹，别人看不到你要注册的名字，也无法抢先注册；约 1 分钟后再发送正式注册。',
      ],
      [
        'Sponsored fee payer (FPC): a shared contract that pays Aztec network fees for you, so you do not need Fee Juice. It does not pay the registration fee.',
        '代付合约（FPC）：一个共享合约，替你支付 Aztec 网络手续费，所以你不需要 Fee Juice。它不支付注册费。',
      ],
      [
        'Registrar: the contract that takes the registration fee and creates or renews names. Resolver: the contract that stores where a name points, such as its Aztec address and profile records.',
        '注册器（Registrar）：收取注册费、创建或续期名字的合约。解析器（Resolver）：保存名字指向哪里的合约，例如 Aztec 地址和资料记录。',
      ],
      [
        'Generation and revision: internal counters ANS uses so an old or stale action cannot change a name. Generation changes when a name is registered again; revision changes whenever its records or roles change. If you see a mismatch, reload and try again.',
        '代次（generation）与修订号（revision）：ANS 内部用来防止过期操作改动名字的计数器。名字被重新注册时代次变化；记录或角色变化时修订号变化。看到不一致提示时，刷新后重试即可。',
      ],
      [
        'Generating proof: Aztec transactions are private, so your browser builds a cryptographic proof before sending. This can take a minute and uses a lot of CPU; keep the tab open. Dropped by network: the network discarded the transaction; nothing was charged, and you can retry.',
        '生成证明：Aztec 交易是隐私交易，浏览器发送前要先生成一个密码学证明，可能需要一分钟左右并占用较多 CPU，请保持页面打开。被网络丢弃：网络没有接收这笔交易，不会扣费，可以重试。',
      ],
    ],
  },
  {
    id: 'manage',
    group: 'guide',
    title: ['Renewals and primary names', '续期与主名字'],
    body: [
      [
        'My names shows your current holdings, expiry dates and renewal controls. Search or filter the list and export an expiry calendar. Browser reminders work only while this page is open; a calendar app can remind you when it is closed.',
        '我的名字展示持有名字、到期日和续期入口，可搜索、筛选和导出到期日历。浏览器提醒仅在页面打开时工作；页面关闭后可使用日历提醒。',
      ],
      [
        'A root name can be renewed by its owner while active or during the grace period. An expired name does not resolve during grace. Subname leases are controlled by the parent owner.',
        '顶级名字可由持有人在有效期或宽限期内续期。宽限期内不再解析；子名字租期由父名字持有人管理。',
      ],
      [
        'A primary name is verified in both directions. Changing the address or resolver, transferring ownership, expiry or a parent change can invalidate it. Reconfirm from the resolved address after changes.',
        '主名字必须双向验证。修改地址或解析器、转移、到期或父名字变化都可能使其失效；变更后需用解析地址重新确认。',
      ],
    ],
  },
  {
    id: 'profile',
    group: 'guide',
    title: ['Profiles and multi-chain addresses', '资料与多链地址'],
    body: [
      [
        'V5 supports public text records such as description, url, avatar, com.github and com.twitter. Each registration generation permits 64 distinct keys and 248 UTF-8 bytes per value. Deleting a value does not reclaim its key slot.',
        'V5 支持 description、url、avatar、com.github、com.twitter 等公开记录。每代注册最多 64 个不同键，每个值最多 248 字节 UTF-8；删除值不释放键配额。',
      ],
      [
        'Use address:eip155:1 for Ethereum or address:eip155:8453 for Base. These are destination records, not cross-chain transfers. Validate the chain and address in the sending application. Empty values remove records.',
        'Ethereum 使用 address:eip155:1，Base 使用 address:eip155:8453。这些是目标地址记录，不执行跨链转账。发送应用须核对链与地址，留空可删除记录。',
      ],
      [
        'All owners, addresses and profile records are public. Never put secrets or recovery phrases in a record. A shared profile QR contains a link to this site, not a payment instruction.',
        '持有人、地址和资料记录均公开。不要填写密钥或助记词。资料二维码包含网站链接，不是付款指令。',
      ],
    ],
  },
  {
    id: 'permissions',
    group: 'guide',
    title: ['Ownership and editor permissions', '所有权与编辑权限'],
    body: [
      [
        'Only the owner can renew, choose a resolver, assign an editor, issue subnames or offer a transfer. One editor may change the default address and public records. Remove the editor to revoke future writes.',
        '只有持有人能续期、选择解析器、指定编辑者、签发子名字或发起转移。可指定一名编辑者修改默认地址及公开记录，移除后立即撤销后续写入权限。',
      ],
      [
        'Transfers require the recipient to accept within seven days. Until acceptance, the owner may cancel or replace the offer. Acceptance starts a fresh generation: previous addresses, records, editor access and primary confirmations no longer apply, and descendants become inactive.',
        '转移需接收方在七天内确认，确认前持有人可取消或替换邀请。确认后进入新代：旧地址、资料、编辑权限与主名字确认不再有效，所有后代子名字失效。',
      ],
    ],
  },
  {
    id: 'subnames',
    group: 'guide',
    title: ['Create and manage subnames', '创建与管理子名字'],
    body: [
      [
        'A parent owner can issue team.alice to another address, for a lease no longer than the parent’s. Up to four subname levels are supported. Every label follows the root label rules.',
        '父名字持有人可将 team.alice 签发给另一地址，租期不得超过父名字，最多支持四层子名字，每层遵循同样的标签规则。',
      ],
      [
        'Parent owners retain revocation and reissue rights. Revoking, transferring or re-registering a parent invalidates its descendants; reissuing the same name cannot revive old descendant records. Subnames do not use paid root registration or root renewal.',
        '父名字持有人保留撤销和重新签发权。撤销、转移或重新注册父名字使后代失效，重新签发同名子名字不会恢复旧后代记录。子名字不使用顶级名字的付费注册及续期流程。',
      ],
    ],
  },
  {
    id: 'sdk',
    group: 'developer',
    title: ['SDK setup and name resolution', 'SDK 接入与名字解析'],
    body: [
      [
        'Use Node 24.12 or newer. Download and extract the starter below; it includes the SDK package, example code and public testnet configuration. The SDK is distributed as a versioned download and is not published on public npm.',
        '使用 Node 24.12 及以上版本。下载并解压下方示例，其中包含 SDK 包、示例代码和公开测试网配置。SDK 通过版本化下载交付，尚未发布到公共 npm。',
      ],
      [
        'Keep the Aztec 6.0.0 dependency versions and overrides in the application’s root package.json. Overrides from the SDK package do not apply to your application. Audit the installed dependencies after integration.',
        '在应用根 package.json 中保留 Aztec 6.0.0 依赖版本和 overrides。SDK 包中的 overrides 不会传递给应用；接入后需检查实际安装的依赖。',
      ],
      [
        'Import public read APIs from @ans/sdk/read; no wallet connection or proving runtime is required. Keep wallet execution imports behind user actions. resolveAddress returns the address and the block snapshot used for the read. Pass that snapshot to resolvePrimary to verify both directions at the same block.',
        '从 @ans/sdk/read 导入公开读取接口，无需连接钱包或加载证明运行库。钱包执行接口在用户操作时加载。resolveAddress 返回解析地址及本次读取的区块快照；将该快照传给 resolvePrimary，可在同一区块完成双向验证。',
      ],
    ],
    code: `import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { RegistryReader, resolveAddress, resolvePrimary } from '@ans/sdk/read';

const reader = await RegistryReader.connect(
  createAztecNodeClient('${deployment.nodeUrl}', { maxBatchSize: 3 }),
  AztecAddress.fromStringUnsafe('${deployment.registry}'),
);
const result = await resolveAddress(reader, 'alice');
if (result.status === 'resolved') {
  const primary = await resolvePrimary(reader, result.address, result.snapshot);
  console.log(result.address.toString(), primary);
}`,
  },
  {
    id: 'sdk-write',
    group: 'developer',
    title: ['Wallet integration and registration', '钱包接入与注册'],
    body: [
      [
        'Confirm the wallet’s secure channel and select an authorized account, then call connectAns. It checks the chain, rollup, registry, account authorization and sponsor contract class, and registers the required contract artifacts with the wallet. It returns an AnsContext for subsequent writes.',
        '核对钱包连接图案并选择授权账户后，调用 connectAns。它校验 chain、rollup、注册表、账户授权和赞助手续费合约类，并向钱包注册所需合约信息，返回后续写入使用的 AnsContext。',
      ],
      [
        'Record updates use the AnsContext returned by connectAns. The SDK reads the current registration generation and revision before each write: generation identifies the current registration, and revision identifies its latest changes. If either changed before submission, re-read the record before retrying.',
        '记录修改使用 connectAns 返回的 AnsContext。SDK 在写入前读取当前注册代和修订号：注册代标识本次注册，修订号标识该代内的最新修改。提交前发生变化时，需重新读取记录再重试。',
      ],
    ],
    code: profileExample,
  },
  {
    id: 'deployments',
    group: 'developer',
    title: ['Networks, versions and migration', '网络、版本与迁移'],
    body: [
      [
        'A deployment is identified by its chain, rollup, registry address and contract class. Check these values on Status before connecting a wallet. The table below lists supported features by protocol version.',
        '部署由 chain、rollup、注册表地址和合约类共同标识。接入钱包前，先在状态页核对这些配置；下表按协议版本列出支持的功能。',
      ],
      [
        'V6 preserves name transfers, editors, subnames and profile records on Aztec 6. Module configuration takes effect after confirmation; administrator handover requires nomination and acceptance. This fresh testnet deployment has no legacy registry and imports or reserves no old names.',
        'V6 在 Aztec 6 上保留名字转移、编辑者、子名字和资料记录。模块配置确认后生效；管理员交接需要提名并由被提名者接受。本次测试网为全新部署，没有旧注册表，不导入或预留旧名字。',
      ],
      [
        'The values below are read from the connected node: registry, contract class and protocol features. Protocol features identifies the ANS contract version verified by class ID, separately from the Aztec rollup version. The SDK connects only to recognized contract classes. For an unknown class, verify the deployment and SDK version before continuing.',
        '下方展示从当前节点读取的注册表、合约类与协议功能。「协议功能」表示按合约类核验的 ANS 合约版本，与 Aztec rollup 版本分别标识。SDK 仅连接已识别的合约类；出现未知合约类时，需核对部署与 SDK 版本再继续。',
      ],
    ],
  },
  {
    id: 'recovery',
    group: 'help',
    title: ['Interrupted registration or pending transaction', '注册中断或交易待确认'],
    body: [
      [
        'Open Register with the same wallet and resume the saved plan. Keep encrypted recovery exports safe. If a transaction hash exists, check its receipt before retrying; never create a replacement payment just because the page timed out.',
        '使用同一钱包打开注册页并恢复保存的计划，妥善保管加密恢复文件。存在交易哈希时先查回执，不能因页面超时而直接重复付款。',
      ],
      [
        'If the fee policy changed, remove the obsolete unconsumed plan and prepare a new one. A network error means availability is unknown, not that the name is free.',
        '费用策略变化时删除未消费的旧计划后重新准备。网络错误表示可用性未知，不表示名字可注册。',
      ],
    ],
  },
  {
    id: 'troubleshooting',
    group: 'help',
    title: ['Wallet, resolution and service issues', '钱包、解析与服务问题'],
    body: [
      [
        'For connection problems, open Status and reconnect. Confirm the wallet uses the same node, chain and registry. If another account is selected, switch to the owner or assigned editor before editing.',
        '连接异常时打开状态页并重连，核对钱包的节点、链和注册表。选错账户时，切换到持有人或编辑者再修改记录。',
      ],
      [
        'If a name does not resolve, check its lease, forward address and parent state. If primary verification fails, confirm from the wallet at the current resolved address. An expired, transferred or revoked parent makes a subname inactive.',
        '无法解析时检查租期、正向地址及父名字状态。主名字验证失败时，用当前解析地址的钱包重新确认。父名字到期、转移或被撤销都会使子名字失效。',
      ],
      [
        'Service notifications and expiry reminders require browser permission and an open page. Favorites stay in this browser and are scoped to the registry. Clearing browser data removes them.',
        '服务通知与到期提醒需要浏览器授权及打开页面。收藏按注册表隔离并保存在当前浏览器，清理浏览器数据会移除。',
      ],
    ],
  },
];

export const summaries: Record<string, [string, string]> = {
  tokens: [
    'The current payment token, private balance requirements and the role of network fee credit.',
    '当前支付代币、私有余额要求与网络手续费余额的区别。',
  ],
  glossary: [
    'Definitions of names, registration commitments, contract modules and transaction states.',
    '名字、注册预约、合约模块与交易状态的含义。',
  ],
  'getting-started': ['Search, register and set up your name.', '搜索、注册并完成名字设置。'],
  pricing: [
    'AZTEC denomination, current fees and payment availability.',
    'AZTEC 计价、当前费用与收款状态。',
  ],
  manage: [
    'Keep your name active and confirm its primary address.',
    '保持名字有效并确认主名字地址。',
  ],
  profile: ['Publish a profile and addresses for other chains.', '发布资料与其他链的地址。'],
  permissions: ['Delegate record editing or transfer your name.', '委派记录编辑权限或转移名字。'],
  subnames: [
    'Issue, replace and revoke names under your domain.',
    '签发、替换和撤销父名字下的名字。',
  ],
  sdk: ['Environment, example files and public read APIs.', '接入环境、示例文件与公开读取接口。'],
  'sdk-write': [
    'Wallet connection, payment checks and registration recovery.',
    '钱包连接、支付检查与注册恢复。',
  ],
  deployments: [
    'Compare contract capabilities and migration requirements.',
    '查看各版本能力与升级要求。',
  ],
  recovery: ['Resume registration and check transaction receipts.', '恢复注册并核对交易回执。'],
  troubleshooting: [
    'Diagnose connection, expiry and resolution issues.',
    '排查连接、到期和解析问题。',
  ],
};

// One bilingual content source powers the reading view and its Markdown export.
export type Localized = [string, string];
export type DocBlock =
  | { type: 'paragraph'; text: Localized }
  | { type: 'steps' | 'list'; items: Localized[] }
  | { type: 'table'; headers: Localized[]; rows: Localized[][] }
  | { type: 'callout'; title: Localized; text: Localized }
  | { type: 'code'; title: Localized; language: string; value: string }
  | { type: 'links'; items: { title: Localized; href: string }[] }
  | { type: 'downloads' | 'deployment' | 'fees' };
export type DocSection = { id: string; title: Localized; blocks: DocBlock[] };
export const groups: { id: Article['group']; title: Localized; description: Localized }[] = [
  {
    id: 'guide',
    title: ['Using ANS', '使用 ANS'],
    description: ['Register, manage and share your name.', '注册、管理和分享你的名字。'],
  },
  {
    id: 'developer',
    title: ['Build with ANS', '开发者接入'],
    description: ['Resolve names and connect your application.', '解析名字，将 ANS 接入应用。'],
  },
  {
    id: 'help',
    title: ['Help and recovery', '帮助与恢复'],
    description: ['Check receipts and recover interrupted work.', '核对回执，恢复中断的操作。'],
  },
];
const headings: Record<string, Localized[]> = {
  tokens: [
    ['The token you need', '你需要的代币'],
    ['AZTEC, test tokens and Fee Juice', 'AZTEC、测试币与 Fee Juice'],
    ['Getting test tokens', '获取测试币'],
  ],
  glossary: [
    ['Names', '名字'],
    ['Commit', '预约（commit）'],
    ['Sponsored fees', '手续费代付'],
    ['Registrar and resolver', '注册器与解析器'],
    ['Generation and revision', '代次与修订号'],
    ['Proofs and dropped transactions', '证明与被丢弃的交易'],
  ],
  'getting-started': [
    ['Choose a name', '选择名字'],
    ['Set up your wallet', '配置钱包'],
    ['Prepare the payment', '准备支付余额'],
    ['Complete registration', '完成注册'],
    ['Set your receiving address', '设置收款地址'],
  ],
  pricing: [
    ['Annual pricing', '年度定价'],
    ['Understand the assets', '区分支付资产'],
    ['Activation requirements', '启用条件'],
    ['Deployment configuration', '部署配置'],
  ],
  manage: [
    ['Find your names', '查看持有名字'],
    ['Renew a lease', '续期规则'],
    ['Confirm a primary name', '确认主名字'],
  ],
  profile: [
    ['Public profile records', '公开资料记录'],
    ['Addresses for other chains', '其他链的地址'],
    ['Sharing and visibility', '分享与公开范围'],
  ],
  permissions: [
    ['Owner and editor roles', '持有人与编辑者'],
    ['Transfer a name', '转移名字'],
  ],
  subnames: [
    ['Issue a subname', '签发子名字'],
    ['Parent control and revocation', '父名字控制与撤销'],
  ],
  sdk: [
    ['Environment and startup', '环境与启动'],
    ['Example files and dependencies', '示例文件与依赖'],
    ['Name resolution', '名字解析'],
  ],
  'sdk-write': [
    ['Wallet connection', '钱包连接'],
    ['Record updates', '记录修改'],
  ],
  deployments: [
    ['Network and capabilities', '网络与功能'],
    ['Configuration and migration', '配置与迁移'],
    ['Connected deployment', '当前连接的部署'],
  ],
  recovery: [
    ['Resume a saved plan', '恢复已保存的计划'],
    ['Handle policy changes', '处理费用策略变化'],
  ],
  troubleshooting: [
    ['Wallet connection', '钱包连接'],
    ['Name resolution', '名字解析'],
    ['Reminders and browser storage', '提醒与浏览器存储'],
  ],
};

export function sectionsFor(article: Article): DocSection[] {
  const sections: DocSection[] = article.body.map((text, i) => ({
    id: `section-${i + 1}`,
    title: headings[article.id][i],
    blocks: [{ type: 'paragraph', text }],
  }));
  if (article.id === 'getting-started') {
    sections[0].blocks.push({
      type: 'table',
      headers: [
        ['Rule', '规则'],
        ['Allowed', '允许范围'],
      ],
      rows: [
        [
          ['Length', '长度'],
          ['3–31 characters', '3–31 个字符'],
        ],
        [
          ['Characters', '字符'],
          ['ASCII letters, digits and hyphens', '英文字母、数字、连字符'],
        ],
        [
          ['Hyphens', '连字符'],
          ['Never at the start or end, never two in a row', '不能位于首尾，不能连续出现'],
        ],
        [
          ['Prefix', '前缀'],
          [
            'Cannot start with 0x, so names never look like addresses',
            '不能以 0x 开头，避免名字看起来像地址',
          ],
        ],
      ],
    });
    sections[1].blocks.push({
      type: 'links',
      items: [
        {
          title: ['Install Azguard for Chrome', '安装 Azguard Chrome 扩展'],
          href: 'https://azguardwallet.io/help/azguard-wallet/introducing',
        },
        {
          title: ['Wallet network setup', '钱包网络配置'],
          href: 'https://azguardwallet.io/help/wallet-setup',
        },
      ],
    });
    sections[2].blocks.push({
      type: 'links',
      items: [
        {
          title: ['Check current pricing and payment token', '查看当前价格与支付 Token'],
          href: '#/docs/pricing',
        },
      ],
    });
    sections[3].blocks = [
      {
        type: 'steps',
        items: [
          [
            'Review the duration, exact quote and token address. Keep your saved registration plan.',
            '核对租期、准确报价和 Token 地址，保存注册计划。',
          ],
          [
            'Approve the commit transaction in your wallet and wait for its receipt.',
            '在钱包确认承诺交易，并等待回执。',
          ],
          ['Wait for the registration window shown on the page.', '等待页面显示的可注册时间。'],
          [
            'Approve payment and registration, then wait for confirmation.',
            '确认付款与注册交易，等待确认后完成。',
          ],
        ],
      },
      {
        type: 'callout',
        title: ['If interrupted', '操作中断时'],
        text: [
          'Return to Register with the same wallet and resume the saved plan. Check an existing transaction hash before retrying.',
          '使用同一钱包返回注册页，恢复已保存的计划；重试前先核对已有交易哈希。',
        ],
      },
    ];
  }
  if (article.id === 'pricing') {
    sections[0].blocks.push({
      type: 'table',
      headers: [
        ['Name length', '名字长度'],
        ['Target price per year', '目标年费'],
        ['Five years', '五年'],
      ],
      rows: (
        [
          [['3 characters', '3 个字符'], pricing.lengthPrices['3']],
          [['4 characters', '4 个字符'], pricing.lengthPrices['4']],
          [['5+ characters', '5 个字符及以上'], pricing.annualPrice],
        ] as [[string, string], string][]
      ).map(([length, price]) => {
        const year = `${formatUnits(BigInt(price), pricing.decimals)} AZTEC`;
        const five = `${formatUnits(BigInt(price) * 5n, pricing.decimals)} AZTEC`;
        return [length, [year, year], [five, five]];
      }),
    });
    sections.splice(1, 0, {
      id: 'active-fees',
      title: ['Current on-chain fees', '当前链上费用'],
      blocks: [{ type: 'fees' }],
    });
    sections[2].blocks.push({
      type: 'table',
      headers: [
        ['Asset', '资产'],
        ['Purpose', '用途'],
      ],
      rows: [
        [
          ['AZTEC', 'AZTEC'],
          [
            'Official Ethereum token; target registration currency',
            '官方以太坊代币，目标注册计价币',
          ],
        ],
        [
          ['mAZTEC', 'mAZTEC'],
          [
            '18-decimal test stand-in, if enabled; no official AZTEC backing',
            '启用后用于流程验证的 18 位测试币，不代表官方 AZTEC',
          ],
        ],
        [
          ['ANSF', 'ANSF'],
          ['Original 6-decimal ANS test payment token', '原有 6 位 ANS 测试支付币'],
        ],
        [
          ['Fee Juice', 'Fee Juice'],
          [
            'Network gas credit; cannot pay the registration treasury',
            '网络手续费余额，不能支付给注册费金库',
          ],
        ],
      ],
    });
    sections.push({
      id: 'sources',
      title: ['Official references', '官方参考'],
      blocks: [
        {
          type: 'links',
          items: [
            { title: ['AZTEC token', 'AZTEC 代币'], href: pricing.referenceAsset.source },
            {
              title: ['Aztec network fees', 'Aztec 网络费用'],
              href: 'https://docs.aztec.network/participate/basics/fees',
            },
          ],
        },
      ],
    });
  }
  if (article.id === 'profile')
    sections[0].blocks.push({
      type: 'table',
      headers: [
        ['Key', '键'],
        ['Value', '内容'],
      ],
      rows: [
        [
          ['description', 'description'],
          ['A short public introduction', '简短公开介绍'],
        ],
        [
          ['url / avatar', 'url / avatar'],
          ['Website or image URL', '网站或图片链接'],
        ],
        [
          ['com.github / com.twitter', 'com.github / com.twitter'],
          ['Public social identifier', '公开社交账号标识'],
        ],
        [
          ['address:eip155:1', 'address:eip155:1'],
          ['Ethereum receiving address', 'Ethereum 收款地址'],
        ],
        [
          ['address:eip155:8453', 'address:eip155:8453'],
          ['Base receiving address', 'Base 收款地址'],
        ],
      ],
    });
  if (article.id === 'permissions') {
    sections[0].blocks.push({
      type: 'table',
      headers: [
        ['Action', '操作'],
        ['Owner', '持有人'],
        ['Editor', '编辑者'],
      ],
      rows: [
        [
          ['Address and profile records', '地址与资料记录'],
          ['Yes', '可以'],
          ['Yes', '可以'],
        ],
        [
          ['Renew, resolver, editor and subnames', '续期、解析器、编辑者与子名字'],
          ['Yes', '可以'],
          ['No', '不可以'],
        ],
        [
          ['Offer or cancel a transfer', '发起或取消转移'],
          ['Yes', '可以'],
          ['No', '不可以'],
        ],
        [
          ['Accept a transfer', '接收转移'],
          ['Offered recipient only', '仅受邀接收方'],
          ['Offered recipient only', '仅受邀接收方'],
        ],
      ],
    });
    sections[1].blocks.push({
      type: 'callout',
      title: ['Acceptance resets records', '接收后需重新设置'],
      text: [
        'The new owner must set addresses, records, editors and primary-name consent again. Descendants remain inactive.',
        '新持有人需重新设置地址、资料、编辑者并确认主名字；旧后代子名字保持失效。',
      ],
    });
  }
  if (article.id === 'sdk') {
    sections[2].blocks.push({
      type: 'paragraph',
      text: [
        'For repeated primary-name display, import Resolver from @ans/sdk/read. The memory cache deduplicates concurrent queries and checks cached block hashes for reorgs. Its default TTL is 30 seconds, capped by the name’s expiry. Invalidate it when switching accounts or deployments; payment checks use fresh chain reads. Owned-name pagination cursors include the chain and rollup version. Restart discovery without a cursor if an older saved cursor lacks that identity.',
        '重复展示主名字时，从 @ans/sdk/read 导入 Resolver。内存缓存会合并并发查询，并检查缓存区块是否发生重组。默认缓存 30 秒，最长不超过名字到期时间；切换账户或部署时需清空缓存，支付检查仍读取最新链上状态。持有名字的分页游标包含 chain 和 rollup 版本，旧游标缺少网络身份时需不带游标重新查询。',
      ],
    });
    sections[0].blocks.push({
      type: 'table',
      headers: [
        ['Command', '命令'],
        ['Result', '结果'],
      ],
      rows: [
        [
          ['npm install', 'npm install'],
          ['Install the bundled SDK and pinned dependencies', '安装随包 SDK 及指定版本的依赖'],
        ],
        [
          ['npm run check', 'npm run check'],
          ['Check TypeScript types in the example', '检查示例的 TypeScript 类型'],
        ],
        [
          ['npm run doctor', 'npm run doctor'],
          [
            'Read network identity, payment token, sponsor and contract modules',
            '读取网络身份、支付 Token、赞助合约与合约模块',
          ],
        ],
        [
          ['npm run read', 'npm run read'],
          ['Resolve the example name and verify its primary name', '解析示例名字并验证主名字'],
        ],
        [
          ['npm run dev', 'npm run dev'],
          [
            'Start the browser example for wallet connection and registration',
            '启动钱包连接与注册的浏览器示例',
          ],
        ],
        [
          ['npm run build', 'npm run build'],
          ['Build the browser example for hosting', '生成可部署的浏览器示例'],
        ],
      ],
    });
    sections[0].blocks.push({ type: 'downloads' });
    sections[1].blocks.push(
      {
        type: 'table',
        headers: [
          ['File', '文件'],
          ['Purpose', '用途'],
        ],
        rows: [
          [
            ['deployment.json', 'deployment.json'],
            [
              'RPC, registry, chain, rollup and sponsor configuration',
              'RPC、注册表、chain、rollup 与赞助合约配置',
            ],
          ],
          [
            ['pricing.json', 'pricing.json'],
            ['Pricing policy at the time of release', '发布时的定价方案'],
          ],
          [
            ['read.ts / doctor.ts', 'read.ts / doctor.ts'],
            ['Public resolution example and deployment diagnostics', '公开解析示例与部署诊断'],
          ],
          [
            ['wallet-connection.ts / registration.ts', 'wallet-connection.ts / registration.ts'],
            [
              'Wallet discovery, channel confirmation and registration API wrapper',
              '钱包发现、连接确认与注册接口封装',
            ],
          ],
          [
            ['plan-store.ts', 'plan-store.ts'],
            [
              'Encrypt and save registration plans in browser localStorage',
              '加密注册计划并保存到浏览器 localStorage',
            ],
          ],
          [
            ['browser/main.ts', 'browser/main.ts'],
            [
              'Connect the form, wallet approvals and saved plans',
              '连接表单、钱包确认与已保存计划',
            ],
          ],
          [
            ['README.md / README.zh-CN.md', 'README.md / README.zh-CN.md'],
            ['English and Chinese integration instructions', '英文与中文接入说明'],
          ],
        ],
      },
      {
        type: 'paragraph',
        text: [
          'Configuration files are release snapshots. Read the active Registrar and fee quote from the chain before payment.',
          '配置文件记录发布时的状态；付款前需从链上读取当前注册器与报价。',
        ],
      },
      {
        type: 'paragraph',
        text: [
          'The initial browser page imports @ans/sdk/read. Wallet discovery and registration load on user actions. The shared bundle-budget.ts build check limits initial JavaScript to 400 kB gzip and rejects eagerly loaded ANS execution artifacts; the build writes its measurements to bundle-budget.json.',
          '浏览器首屏使用 @ans/sdk/read，钱包发现与注册代码在用户操作时加载。示例和网站共用 bundle-budget.ts 构建检查：首屏 JavaScript 上限为 gzip 400 kB，禁止提前加载 ANS 合约执行代码；测量结果写入 bundle-budget.json。',
        ],
      },
    );
    sections[2].blocks.push(
      {
        type: 'table',
        headers: [
          ['API or field', '接口或字段'],
          ['Meaning', '含义'],
        ],
        rows: [
          [
            ['RegistryReader.connect', 'RegistryReader.connect'],
            [
              'Connect to the node and validate the registry contract class',
              '连接节点并校验注册表合约类',
            ],
          ],
          [
            ['resolveAddress', 'resolveAddress'],
            [
              'Resolve a name to an Aztec address; use the address only when status is resolved',
              '将名字解析为 Aztec 地址；仅在 status 为 resolved 时使用地址',
            ],
          ],
          [
            ['result.snapshot', 'result.snapshot'],
            [
              'Block used for this result; reuse it for related reads',
              '本次结果对应的区块，关联读取复用同一快照',
            ],
          ],
          [
            ['resolvePrimary', 'resolvePrimary'],
            [
              'Verify that the primary name resolves to this address in the current registration generation',
              '校验主名字在当前注册代内正向解析到该地址',
            ],
          ],
        ],
      },
      {
        type: 'code',
        title: ['Address and primary-name lookup', '地址与主名字查询'],
        language: 'typescript',
        value: article.code!,
      },
      {
        type: 'links',
        items: [
          {
            title: ['Wallet integration and registration', '钱包接入与注册'],
            href: '#/docs/sdk-write',
          },
          {
            title: ['Networks, versions and migration', '网络、版本与迁移'],
            href: '#/docs/deployments',
          },
        ],
      },
    );
  }
  if (article.id === 'sdk-write') {
    sections[0].blocks.push({
      type: 'paragraph',
      text: [
        'Private balance reads, fee authorization and transaction submission recheck the wallet’s chainId and rollup version inside its execution queue. A mismatch returns wrong_deployment before that operation proceeds. Reconnect after switching networks; a network error means the read is unavailable and must not be treated as a zero balance or free registration.',
        '私有余额读取、费用授权与交易提交在钱包执行队列内，再次核对钱包的 chainId 和 rollup 版本。不匹配时在操作继续前返回 wrong_deployment。切换网络后需重新连接；network 错误表示读取失败，不能视为零余额或免费注册。',
      ],
    });
    sections[0].blocks.push({
      type: 'steps',
      items: [
        [
          'Discover a compatible wallet in the current browser. Compare the connection symbols with the wallet and confirm the secure channel.',
          '在当前浏览器发现兼容钱包，核对页面与钱包中的连接图案，确认连接。',
        ],
        [
          'Select an account returned by wallet.getAccounts and pass it to connectAns with the deployment configuration. The SDK checks the wallet’s chainId and rollup version against the reader before registering contracts.',
          '从 wallet.getAccounts 返回的授权账户中选择一个，与部署配置一起传给 connectAns。SDK 在注册合约信息前，核对钱包与读取器的 chainId 和 rollup 版本。',
        ],
        [
          'Keep one registration flow active per account. When switching accounts or networks, create a new context and load plans for that account and deployment.',
          '每个账户保留一个活动注册流程。切换账户或网络后，重新建立上下文，并读取对应账户与部署的计划。',
        ],
      ],
    });
    sections[1].blocks.push(
      {
        type: 'table',
        headers: [
          ['Action', '操作'],
          ['API', '接口'],
        ],
        rows: [
          [
            ['Public profile and chain addresses', '公开资料与链地址'],
            ['setTextRecord / setChainAddress', 'setTextRecord / setChainAddress'],
          ],
          [
            ['Editor assignment', '编辑者设置'],
            ['setManager', 'setManager'],
          ],
          [
            ['Transfer offer and acceptance', '转移发起与接收'],
            ['offerTransfer / acceptTransfer', 'offerTransfer / acceptTransfer'],
          ],
          [
            ['Subname issuance and revocation', '子名字签发与撤销'],
            ['issueSubname / revokeSubname', 'issueSubname / revokeSubname'],
          ],
        ],
      },
      {
        type: 'code',
        title: ['Profile and chain-address updates', '资料与链地址修改'],
        language: 'typescript',
        value: article.code!,
      },
      {
        type: 'links',
        items: [
          {
            title: ['Ownership and editor permissions', '所有权与编辑权限'],
            href: '#/docs/permissions',
          },
        ],
      },
    );
    sections.splice(
      1,
      0,
      {
        id: 'registration-data',
        title: ['Registration data', '注册数据'],
        blocks: [
          {
            type: 'table',
            headers: [
              ['Object', '对象'],
              ['Contents and use', '内容与用途'],
              ['Storage', '保存位置'],
            ],
            rows: [
              [
                ['RegistryReader', 'RegistryReader'],
                [
                  'Node connection and verified registry; reads public state',
                  '节点连接与已校验注册表，读取公开状态',
                ],
                ['Application memory', '应用内存'],
              ],
              [
                ['AnsContext', 'AnsContext'],
                [
                  'Reader, wallet and authorized account; submits writes',
                  '读取器、钱包与授权账户，提交写入',
                ],
                ['Application memory', '应用内存'],
              ],
              [
                ['FeeQuote', 'FeeQuote'],
                [
                  'Duration, amount, token and fee policy read from the chain',
                  '从链上读取的租期、金额、Token 与费用策略',
                ],
                [
                  'Application memory; accepted values enter the plan',
                  '应用内存；接受后的报价写入计划',
                ],
              ],
              [
                ['RegistrationPlan', 'RegistrationPlan'],
                [
                  'Account, name, registration secret, accepted fee and transaction hashes',
                  '账户、名字、注册秘密值、已接受费用与交易哈希',
                ],
                [
                  'Encrypted by the application before store.save',
                  '由应用加密后调用 store.save 保存',
                ],
              ],
              [
                ['RegistrationPlanStore', 'RegistrationPlanStore'],
                [
                  'Application-provided load and save methods; restore a plan by key',
                  '应用提供 load 与 save 方法，按键保存和恢复计划',
                ],
                [
                  'Example: encrypted browser localStorage',
                  '示例：浏览器 localStorage 中的加密数据',
                ],
              ],
              [
                ['Registration flow', '注册流程'],
                [
                  'createRegistrationFlow coordinates plan storage and transactions',
                  'createRegistrationFlow 串行处理计划保存与交易',
                ],
                ['Application memory; recreate after reload', '应用内存；刷新后重新建立'],
              ],
            ],
          },
        ],
      },
      {
        id: 'payment-readiness',
        title: ['Payment checks', '支付检查'],
        blocks: [
          {
            type: 'paragraph',
            text: [
              'Read a fresh quote with flow.quote(duration, name), with duration in seconds; 31536000n is one year. The price depends on the name length, so pass the name to register and quote again when it changes. Call flow.readiness(quote) to check the selected account’s private balance. Display the quote and the following fields before asking the user to accept payment.',
              '通过 flow.quote(duration, name) 读取新报价，duration 使用秒，31536000n 表示一年。价格按名字长度分档，需传入要注册的名字，名字改变后重新报价。调用 flow.readiness(quote) 检查当前账户的私有余额；用户接受付款前，应用需展示报价及以下字段。',
            ],
          },
          {
            type: 'table',
            headers: [
              ['Field', '字段'],
              ['Meaning', '含义'],
            ],
            rows: [
              [
                ['ready', 'ready'],
                ['Whether the private balance covers this quote', '私有余额是否足以支付本次报价'],
              ],
              [
                ['balance', 'balance'],
                [
                  'Private balance in the quoted token’s smallest units',
                  '报价 Token 的私有余额，使用最小单位',
                ],
              ],
              [
                ['shortfall', 'shortfall'],
                ['Additional amount needed, in the same units', '还需补充的金额，使用同一单位'],
              ],
              [
                ['token', 'token'],
                [
                  'Payment token address, symbol and decimals; omitted for a free quote',
                  '支付 Token 地址、符号与精度；免费报价不返回此项',
                ],
              ],
            ],
          },
          {
            type: 'paragraph',
            text: [
              'For direct calls, use getFeeReadiness(ctx, quote) or getPrivateFeeBalance(ctx, token). The SDK registers the exact payment-token artifact before private reads and paid authorization, including after a Registrar change. Read failures return errors rather than a zero balance.',
              '直接调用时可使用 getFeeReadiness(ctx, quote) 或 getPrivateFeeBalance(ctx, token)。SDK 在读取私有余额和授权付款前注册对应支付 Token 的合约信息，注册器切换后也会重新核对。读取失败返回错误。',
            ],
          },
          {
            type: 'callout',
            title: ['Test-token funding', '测试币获取'],
            text: [
              'Current test payment tokens have no self-serve faucet. Obtain private balance in the exact quoted token from the testnet operator. Fee Juice pays network fees; it cannot pay the registration treasury. doctor checks public configuration, while readiness checks the selected account’s balance.',
              '当前测试支付币没有自助水龙头，需向测试网维护者获取报价 Token 对应的私有余额。Fee Juice 支付网络手续费，不能支付注册费。doctor 检查公开配置；readiness 检查所选账户的余额。',
            ],
          },
          {
            type: 'links',
            items: [
              { title: ['Pricing and payment assets', '价格与支付资产'], href: '#/docs/pricing' },
              { title: ['Which token do I need?', '我需要哪种代币？'], href: '#/docs/tokens' },
            ],
          },
        ],
      },
      {
        id: 'registration-flow',
        title: ['Registration process', '注册流程'],
        blocks: [
          {
            type: 'steps',
            items: [
              [
                'Show the name, duration, token address and amount. Ask the user to accept the current quote.',
                '展示名字、租期、Token 地址与金额，由用户接受当前报价。',
              ],
              [
                'Call prepare with that quote. It rechecks the fee policy and saves the registration plan before returning.',
                '将已接受报价传给 prepare；它重新核对费用策略，保存注册计划后返回。',
              ],
              [
                'Call commit and ask the user to approve the first transaction in the wallet. Save and track its hash.',
                '调用 commit，由用户在钱包确认第一笔交易，保存并跟踪哈希。',
              ],
              [
                'Call check again while waiting. It reads chain time and returns ready_to_register when the registration window opens.',
                '等待期间再次调用 check；它读取链上时间，可注册时返回 ready_to_register。',
              ],
              [
                'Call finish and ask the user to approve payment and registration. Complete the flow after the receipt reaches checkpointed.',
                '调用 finish，由用户确认付款与注册交易；回执进入 checkpointed 后完成流程。',
              ],
            ],
          },
          {
            type: 'code',
            title: ['Connection and payment checks', '连接与支付检查'],
            language: 'typescript',
            value: connectionExample,
          },
          {
            type: 'paragraph',
            text: [
              'connectRegistration takes a connected reader, confirmed wallet, authorized account and recovery passphrase. It returns flow, store, quote and readiness without submitting a transaction. When readiness.ready is true, show the quote and ask the user to accept it before calling commitAcceptedPlan.',
              'connectRegistration 接收已连接的读取器、已确认连接的钱包、授权账户与恢复口令，返回 flow、store、quote 和 readiness，不提交交易。readiness.ready 为 true 时，展示报价并取得用户确认，再调用 commitAcceptedPlan。',
            ],
          },
          {
            type: 'code',
            title: ['Commit and registration', '承诺与注册'],
            language: 'typescript',
            value: registrationExample,
          },
          {
            type: 'paragraph',
            text: [
              'commitAcceptedPlan returns the saved plan after commit confirmation. finishReadyPlan returns the unchanged plan while waiting; call check again to display the remaining time. Once ready, it submits registration; an existing registerTx is tracked. onUpdate receives TxUpdate for transaction progress. These functions are application examples, not additional SDK APIs.',
              'commitAcceptedPlan 在承诺交易确认后返回已保存计划。等待期间 finishReadyPlan 返回原计划，可再次调用 check 展示剩余时间；可注册时提交注册，存在 registerTx 时跟踪原交易。onUpdate 接收 TxUpdate，展示交易进度。这两个函数是应用接入示例。',
            ],
          },
        ],
      },
    );
    sections.push(
      {
        id: 'registration-recovery',
        title: ['Plan storage and recovery', '计划保存与恢复'],
        blocks: [
          {
            type: 'paragraph',
            text: [
              'The example encrypts each plan with seal/unseal and a recovery passphrase of at least eight characters before writing localStorage. Plans contain registration secrets; keep them out of URLs and logs. To resume after a reload, reconnect the same account, unlock the same store and load the plan before recreating the flow.',
              '示例使用至少八位的恢复口令，通过 seal/unseal 加密计划后写入 localStorage。计划含注册秘密值，不能写入 URL 或日志。刷新后需重新连接同一账户，用原口令解锁存储、读取计划并重新建立流程。',
            ],
          },
          {
            type: 'list',
            items: [
              [
                'Keep the recovery passphrase and encrypted browser data. Clearing localStorage removes the saved plans.',
                '保留恢复口令与浏览器中的加密数据；清理 localStorage 会移除已保存计划。',
              ],
              [
                'commit and finish load the latest saved plan and track an existing hash before submitting anything new. Even an older in-memory plan reuses the saved hash.',
                'commit 与 finish 先读取最新保存的计划，存在哈希时跟踪原交易；传入旧计划副本也会复用已保存哈希。',
              ],
              [
                'If hash persistence fails after submission, unknown_tx_state carries the hash. Track it and repair storage before continuing.',
                '提交后保存哈希失败时，unknown_tx_state 会携带哈希；先查询交易并恢复保存，再继续。',
              ],
              [
                'commit only broadcasts while no commitment exists and the name, Registrar and quote still match; otherwise it throws without sending. If the wallet returns no hash, including when it disconnects mid-request, the plan records broadcastUnknown. Inspect wallet activity before explicitly clearing and saving the flag, then recreate the flow. Call flow.recover(plan, kind, options), where kind is "commitTx" or "registerTx", to check a known receipt without broadcasting. Verified dropped or reverted outcomes, during recovery or right after sending, clear and save that hash, then throw the corresponding error. Timeouts preserve the hash; old plan copies use the latest saved progress.',
                'commit 仅在链上尚无承诺且名字、Registrar 与报价仍匹配时广播，否则直接报错、不发送。钱包未返回哈希时（包括请求中途断开），计划记录 broadcastUnknown；检查钱包活动后才能明确清除并保存标记，再重新建立流程。调用 flow.recover(plan, kind, options) 查询已知回执；kind 为 "commitTx" 或 "registerTx"，对应承诺和注册交易。该操作不广播交易。确认丢弃或回滚后（恢复时或刚发送后），流程清除并保存对应哈希，再抛出相应错误。超时保留哈希；旧计划副本使用最新保存的进度。',
              ],
              [
                'Multiple tabs or application instances need a shared storage lease to prevent concurrent submission. The example serializes actions within one tab.',
                '多个标签页或应用实例需共享存储租约，避免并发提交；示例仅串行处理同一标签页内的操作。',
              ],
            ],
          },
        ],
      },
      {
        id: 'sdk-errors',
        title: ['Error handling', '异常处理'],
        blocks: [
          {
            type: 'table',
            headers: [
              ['Code', '错误码'],
              ['Action', '处理方式'],
            ],
            rows: [
              [
                ['network', 'network'],
                [
                  'Retry the read and retain form data and saved plans',
                  '重试读取，保留表单与已保存计划',
                ],
              ],
              [
                ['not_administrator', 'not_administrator'],
                [
                  'Reconnect with the current administrator account; do not retry the same unauthorized request',
                  '使用当前管理员账户重新连接，不能重试同一个无权限请求',
                ],
              ],
              [
                ['fee_changed', 'fee_changed'],
                [
                  'Read and display a fresh quote; prepare a new plan after user acceptance',
                  '重新读取并展示报价，用户接受后准备新计划',
                ],
              ],
              [
                ['unknown_tx_state', 'unknown_tx_state'],
                [
                  'Check the stored hash or broadcastUnknown as described in Plan storage and recovery',
                  '按「计划保存与恢复」核对已保存哈希或 broadcastUnknown',
                ],
              ],
              [
                ['wallet_rejected', 'wallet_rejected'],
                [
                  'Retain the plan and let the user retry wallet approval',
                  '保留计划，由用户重试钱包确认',
                ],
              ],
              [
                ['unsupported / wrong_deployment', 'unsupported / wrong_deployment'],
                [
                  'Verify the network, contract class and SDK version before signing',
                  '签名前核对网络、合约类与 SDK 版本',
                ],
              ],
            ],
          },
        ],
      },
    );
  }
  if (article.id === 'deployments') {
    sections[0].blocks.push({
      type: 'table',
      headers: [
        ['Version', '版本'],
        ['Capabilities', '能力'],
      ],
      rows: [
        [
          ['V2', 'V2'],
          [
            'Root names, Aztec addresses and verified primary names',
            '顶级名字、Aztec 地址与主名字验证',
          ],
        ],
        [
          ['V3', 'V3'],
          ['Registrar, Resolver and holder migration', '注册器、解析器与持有人迁移'],
        ],
        [
          ['V4', 'V4'],
          [
            'Profiles, accepted transfers, editors and subnames',
            '资料、双向确认转移、编辑者与子名字',
          ],
        ],
        [
          ['V5', 'V5'],
          [
            'All V4 name features; direct administrator configuration and holder migration',
            '全部 V4 名字功能；管理员即时配置与持有人迁移',
          ],
        ],
        [
          ['V6', 'V6'],
          [
            'Aztec 6 name features and tiered pricing; fresh deployment with no imported or reserved legacy names',
            'Aztec 6 名字功能与分档定价；全新部署，不导入或预留旧名字',
          ],
        ],
      ],
    });
    sections[1].blocks = [
      {
        type: 'list',
        items: [
          [
            'The current administrator calls configureModules to select Registrar and default Resolver, effective after confirmation. V5 uses setAdministrator for direct handover. V6 requires nominate_administrator and accept_administrator through the V6 bindings; the SDK setAdministrator helper rejects V6.',
            '当前管理员通过 configureModules 配置注册器与默认解析器，交易确认后生效。V5 通过 setAdministrator 直接移交权限。V6 需通过 V6 绑定调用 nominate_administrator 和 accept_administrator；SDK 的 setAdministrator 会拒绝 V6。',
          ],
          [
            'Payment changes preserve name records but invalidate obsolete quotes and unconsumed plans. A new default Resolver applies to subsequent names; existing names retain their selected Resolver.',
            '费用变更保留名字记录，但使旧报价和未消费计划失效。新默认解析器用于后续名字，既有名字保留自己的解析器。',
          ],
          [
            'A new implementation has a new contract address. The current V6 deployment starts fresh with legacy set to zero; names on the old rollup are not migrated, reserved or snapshotted.',
            '新实现使用新合约地址。当前 V6 部署的 legacy 为零，从空状态开始；旧 rollup 名字不迁移、不预留，也不导入快照。',
          ],
          [
            'For historical deployments with an explicitly configured legacy registry, holders may migrate root names during their lease or 30-day grace period, preserving owner, expiry and default address. Configure editors, profiles and subnames on the destination and confirm reverse consent again. These legacy migration rules do not apply to the fresh V6 testnet.',
            '对于明确配置了旧注册表的历史部署，持有人可在租期或 30 天宽限期内迁移顶级名字，保留持有人、到期时间和默认地址。编辑者、资料和子名字需在目标部署配置，主名字需重新确认。这些历史迁移规则不适用于本次全新的 V6 测试网。',
          ],
          [
            'A website release does not change the active contract class.',
            '发布网站不会改变链上正在生效的合约类。',
          ],
        ],
      },
    ];
    sections[1].blocks.push({
      type: 'code',
      language: 'typescript',
      title: ['Configure modules as the current administrator', '使用当前管理员配置模块'],
      value: configurationExample,
    });
    sections[2].blocks.push({ type: 'deployment' });
  }
  if (article.id === 'recovery')
    sections[0].blocks.push({
      type: 'steps',
      items: [
        ['Reconnect the original wallet and account.', '重新连接原钱包与账户。'],
        [
          'Open Register and restore the saved or encrypted plan.',
          '打开注册页，恢复已保存或加密导出的计划。',
        ],
        ['Check the receipt of every existing hash.', '核对每个已有哈希的交易回执。'],
        ['Continue only the next unconfirmed step.', '仅继续下一步尚未确认的操作。'],
      ],
    });
  return sections;
}

export function articleToMarkdown(article: Article, lang: 0 | 1): string {
  const tableCell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`# ${article.title[lang]}`, '', summaries[article.id][lang], ''];
  for (const section of sectionsFor(article)) {
    lines.push(`## ${section.title[lang]}`, '');
    for (const block of section.blocks) {
      switch (block.type) {
        case 'paragraph':
          lines.push(block.text[lang]);
          break;
        case 'steps':
        case 'list':
          lines.push(
            ...block.items.map(
              (item, i) => `${block.type === 'steps' ? `${i + 1}.` : '-'} ${item[lang]}`,
            ),
          );
          break;
        case 'callout':
          lines.push(`> **${block.title[lang]}**`, `> ${block.text[lang]}`);
          break;
        case 'code':
          lines.push(`### ${block.title[lang]}`, '', `\`\`\`${block.language}`, block.value, '```');
          break;
        case 'table':
          lines.push(
            `| ${block.headers.map((h) => tableCell(h[lang])).join(' | ')} |`,
            `| ${block.headers.map(() => '---').join(' | ')} |`,
            ...block.rows.map((row) => `| ${row.map((c) => tableCell(c[lang])).join(' | ')} |`),
          );
          break;
        case 'links':
          lines.push(
            ...block.items.map(
              (link) =>
                `- [${link.title[lang]}](${link.href.startsWith('#/') ? `https://ans-testnet.huantian233.workers.dev/${link.href}` : link.href})`,
            ),
          );
          break;
        case 'downloads':
          lines.push(
            `[${lang ? '下载 SDK 和完整示例' : 'Download SDK and runnable starter'}](https://ans-testnet.huantian233.workers.dev/#/docs/sdk)`,
            '',
            '```sh',
            'npm install',
            'npm run check',
            'npm run doctor',
            'npm run read',
            'npm run dev',
            '```',
          );
          break;
        case 'deployment':
          lines.push(
            `- RPC: ${deployment.nodeUrl}`,
            `- Registry: ${deployment.registry}`,
            `- Chain: ${deployment.chainId}`,
            `- Rollup: ${deployment.rollupVersion}`,
            '',
            lang
              ? '当前合约类与模块请在网站读取链上状态。'
              : 'Read the current contract class and modules on the website.',
          );
          break;
        case 'fees':
          lines.push(
            `[${lang ? '读取当前链上报价与支付 Token' : 'Read the current on-chain quote and payment token'}](https://ans-testnet.huantian233.workers.dev/#/docs/pricing)`,
            '',
            lang
              ? '导出文件不包含实时价格快照，付款前请以链上报价为准。'
              : 'This export has no live price snapshot. Check the on-chain quote before paying.',
          );
          break;
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
