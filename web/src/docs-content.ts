import deployment from '../../deployments/testnet-v6.json';
import pricing from '../../deployments/aztec-pricing.json';
import { formatUnits } from './usability';
import {
  configurationExample,
  launchExample,
  connectionExample,
  profileExample,
  resolverTrustExample,
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
const testSymbol = deployment.feeSymbol;
export type Article = {
  id: string;
  group: 'guide' | 'developer' | 'help';
  title: string;
  body: string[];
  code?: string;
};
export const articles: Article[] = [
  {
    id: 'core-upgrades-v8',
    group: 'developer',
    title: 'Independent V8 core upgrades',
    body: [
      'V8 is a fresh independent registry awaiting review. Existing V6 has no upgrade entry and old names are not migrated. Mainnet remains blocked; local proof-disabled tests establish no real-proof readiness.',
      'A trusted single administrator may approve exact registered releases and revocable directed edges. Family/sequence labels are attestations, not semantic compatibility proofs; malicious code remains within administrator trust. Placeholder administrators remain blocked. Module configuration remains immediate.',
      'Core execution waits 86400 application seconds, then 86400 protocol seconds. Cancellation after execution is strictly before activation and can only retain the running source class. At or after activation, rollback requires the full ordinary delays and preserves business writes.',
      'SDK and monitoring pin raw application/protocol reads to one canonical block N. Public simulation is a next-block prediction. Unknown classes/edges or mismatches fail closed. Wallet identity and current artifacts refresh inside the shared queue; private proving needs a conservative activation margin.',
    ],
  },
  {
    id: 'getting-started',
    group: 'guide',
    title: 'Register your first name',
    body: [
      'Search for a name, connect an Aztec wallet, and review the lease and exact fee. Root labels use 3–31 ASCII letters, digits or hyphens; no leading or trailing hyphen, no "--" and no "0x" prefix.',
      `You need a desktop browser with an Aztec wallet extension; Azguard currently offers one for Chrome (mobile wallets are not supported yet). Install it in the same browser, unlock it and select Testnet. If the wallet asks for network details, enter: node ${deployment.nodeUrl}, chain ID ${deployment.chainId} and rollup version ${deployment.rollupVersion}. The chain ID identifies Ethereum Sepolia, the public test network that Aztec Testnet settles on; the rollup version identifies the current Aztec Testnet release. Both must match exactly, otherwise ANS stops before any transaction so nothing is sent to the wrong network.`,
      'Use a test account funded in the exact payment token and quote shown on Register. AZTEC is the selected pricing currency; mAZTEC is a clearly labeled 18-decimal test stand-in with no official backing. See “Which token do I need?” for the difference between AZTEC, mAZTEC, ANSF and Fee Juice. Network fees are paid by a shared sponsor contract, so you do not need Fee Juice.',
      'Registration has two transactions: first a commit (a sealed fingerprint that hides which name you want, so nobody can grab it first), then the registration after about one minute. Keep the registration plan until the second transaction is confirmed. If interrupted, open Register again and resume the saved plan.',
      'After registration, open Manage, set an Aztec address, then connect that address’s wallet to confirm its primary name. Registration alone does not set a receiving address.',
    ],
  },
  {
    id: 'pricing',
    group: 'guide',
    title: 'Pricing and payment assets',
    body: [
      `Registration and renewal will be priced in AZTEC. Shorter names cost more: the provisional annual rate is ${aztecPrice3} AZTEC for 3 characters, ${aztecPrice4} AZTEC for 4 characters and ${aztecAnnualPrice} AZTEC for 5 or more, for one to five whole years. Renewals use the same tier. This is the target policy; AZTEC collection is not active on this test deployment. Today the test deployment charges the same tiers in ${testSymbol} per year: ${testTiers}; the Register page always shows the exact on-chain quote before you pay.`,
      'AZTEC is the official 18-decimal Ethereum token. Fee Juice is network fee credit obtained by depositing AZTEC; it cannot be transferred to a registration treasury. ANSF is an older project test token from earlier deployments. Receiving Fee Juice does not fund any registration payment; see “Which token do I need?”.',
      'The payment asset must be verified on the connected network before AZTEC collection can start. A website update or a token with the same symbol cannot change the active Registrar. The payment screen continues to show the current on-chain quote and token address.',
      'When the connected module is NameRegistrarLaunch, public registration uses a live minimum length (initial default 7), reserved-name list and pause switch. A launch lease and each renewal are exactly 365 days. Free means no registration-token transfer or authorization; Fee Juice or sponsorship still pays network fees. Short names show Not yet available, reserved names show Reserved, and a pause blocks only public registration. This does not announce a deployment or change the current testnet fees.',
      'The administrator selects the active Registrar directly. A confirmed change takes effect immediately. Review the current token, treasury and exact quote before authorizing payment; prepare a new plan if its policy changed.',
    ],
  },
  {
    id: 'tokens',
    group: 'guide',
    title: 'Which token do I need?',
    body: [
      `To register on this test deployment you need ${testSymbol} only, per year: ${testTiers}, held as a private balance in the wallet account that registers. The Register page shows the exact token address and quote; a token you create yourself with the same symbol will not work.`,
      `${testSymbol} is a test stand-in for AZTEC with 18 decimals and no value or official backing. AZTEC is the official token and the planned pricing currency, but it is not accepted here yet. ANSF is an older 6-decimal ANS test token used by earlier deployments; it cannot pay the current Registrar. Fee Juice is Aztec network fee credit; you do not need it because a shared sponsor contract pays network fees, and it can never pay a registration fee.`,
      `There is currently no public self-serve faucet or published public request channel for this deployment. Test balances are arranged by the testnet operator; ordinary users cannot obtain them through this site. The V6 acceptance runner funds its test account through an administrator-authorized mint_to_private call on the deployed token. This is an operator test procedure, not a public faucet. The testnet-v6 manifest identifies ${testSymbol} at ${deployment.feeToken} (${deployment.feeDecimals} decimals). Verify this exact address and your private balance on Register; tokens from older rollups or with the same symbol cannot pay here.`,
    ],
  },
  {
    id: 'glossary',
    group: 'help',
    title: 'Plain-language glossary',
    body: [
      'Name: your readable ANS name, like alice. It is not an internet domain or website address. Primary name: the one name your account shows by default; it is only shown when the name also points back to your address, so nobody can claim to be you.',
      'Commit: the first registration step. It records a sealed fingerprint of your request so nobody can see or front-run the name; after about one minute you send the actual registration.',
      'Sponsored fee payer (FPC): a shared contract that pays Aztec network fees for you, so you do not need Fee Juice. It does not pay the registration fee.',
      'Registrar: the contract that takes the registration fee and creates or renews names. Resolver: the contract that stores where a name points, such as its Aztec address and profile records.',
      'Generation and revision: internal counters ANS uses so an old or stale action cannot change a name. Generation changes on registration or accepted transfer. V7 keeps holder changes and editor writes on separate revision counters; V6 shares one counter. If you see a mismatch, reload and try again.',
      'Generating proof: Aztec transactions are private, so your browser builds a cryptographic proof before sending. This can take a minute and uses a lot of CPU; keep the tab open. Dropped by network: the network discarded the transaction; nothing was charged, and you can retry.',
    ],
  },
  {
    id: 'manage',
    group: 'guide',
    title: 'Renewals and primary names',
    body: [
      'My names shows your current holdings, expiry dates and renewal controls. Search or filter the list and export an expiry calendar. Browser reminders work only while this page is open; a calendar app can remind you when it is closed.',
      'A root name can be renewed by its owner while active or during the grace period. An expired name does not resolve during grace. Subname leases are controlled by the parent owner.',
      'A primary name is verified in both directions. Changing the address or resolver, transferring ownership, expiry or a parent change can invalidate it. Reconfirm from the resolved address after changes.',
    ],
  },
  {
    id: 'profile',
    group: 'guide',
    title: 'Profiles and multi-chain addresses',
    body: [
      'V5 supports public text records such as description, url, avatar, com.github and com.twitter. Each registration generation permits 64 distinct keys and 248 UTF-8 bytes per value. Deleting a value does not reclaim its key slot.',
      'Use address:eip155:1 for Ethereum or address:eip155:8453 for Base. These are destination records, not cross-chain transfers. Validate the chain and address in the sending application. Empty values remove records.',
      'All owners, addresses and profile records are public. Never put secrets or recovery phrases in a record. A shared profile QR contains a link to this site, not a payment instruction.',
    ],
  },
  {
    id: 'permissions',
    group: 'guide',
    title: 'Ownership and editor permissions',
    body: [
      'Only the owner can renew, choose a resolver, assign an editor, issue subnames or offer a transfer. One editor may change the default address and public records. Remove the editor to revoke future writes.',
      'Transfers require the recipient to accept within seven days. Until acceptance, the owner may cancel or replace the offer. Acceptance starts a fresh generation: previous addresses, records, editor access and primary confirmations no longer apply, and descendants become inactive.',
    ],
  },
  {
    id: 'subnames',
    group: 'guide',
    title: 'Create and manage subnames',
    body: [
      'A parent owner can issue team.alice to another address, for a lease no longer than the parent’s. Up to four subname levels are supported. Every label follows the root label rules.',
      'Parent owners retain revocation and reissue rights. Revoking, transferring or re-registering a parent invalidates its descendants; reissuing the same name cannot revive old descendant records. Subnames do not use paid root registration or root renewal.',
    ],
  },
  {
    id: 'sdk',
    group: 'developer',
    title: 'SDK setup and name resolution',
    body: [
      'Use Node 24.12 or newer. Download and extract the starter below; it includes the SDK package, example code and public testnet configuration. The SDK is distributed as a versioned download and is not published on public npm.',
      'Keep the Aztec 6.0.0 dependency versions and overrides in the application’s root package.json. Overrides from the SDK package do not apply to your application. Audit the installed dependencies after integration.',
      'Import public read APIs from @ans/sdk/read; no wallet connection or proving runtime is required. Keep wallet execution imports behind user actions. resolveAddress returns the address and the block snapshot used for the read. Pass that snapshot to resolvePrimary to verify both directions at the same block.',
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
    title: 'Wallet integration and registration',
    body: [
      'Confirm the wallet’s secure channel and select an authorized account, then call connectAns. It checks the chain, rollup, registry, account authorization and sponsor contract class, and registers the required contract artifacts with the wallet. It returns an AnsContext for subsequent writes.',
      'Record updates use the AnsContext returned by connectAns. The SDK reads the current registration generation and revision before each write: generation identifies the current registration, and revision identifies its latest changes. If either changed before submission, re-read the record before retrying.',
    ],
    code: profileExample,
  },
  {
    id: 'deployments',
    group: 'developer',
    title: 'Networks, versions and migration',
    body: [
      'A deployment is identified by its chain, rollup, registry address and contract class. Check these values on Status before connecting a wallet. The table below lists supported features by protocol version.',
      'V6 preserves name transfers, editors, subnames and profile records on Aztec 6. Module configuration takes effect after confirmation; administrator handover requires nomination and acceptance. This fresh testnet deployment has no legacy registry and imports or reserves no old names.',
      'The values below are read from the connected node: registry, contract class and protocol features. Protocol features identifies the ANS contract version verified by class ID, separately from the Aztec rollup version. The SDK connects only to recognized contract classes. For an unknown class, verify the deployment and SDK version before continuing.',
    ],
  },
  {
    id: 'recovery',
    group: 'help',
    title: 'Interrupted registration or pending transaction',
    body: [
      'Open Register with the same wallet and resume the saved plan. Keep encrypted recovery exports safe. If a transaction hash exists, check its receipt before retrying; never create a replacement payment just because the page timed out.',
      'If the fee policy changed, remove the obsolete unconsumed plan and prepare a new one. A network error means availability is unknown, not that the name is free.',
    ],
  },
  {
    id: 'troubleshooting',
    group: 'help',
    title: 'Wallet, resolution and service issues',
    body: [
      'For connection problems, open Status and reconnect. Confirm the wallet uses the same node, chain and registry. If another account is selected, switch to the owner or assigned editor before editing.',
      'If a name does not resolve, check its lease, forward address and parent state. If primary verification fails, confirm from the wallet at the current resolved address. An expired, transferred or revoked parent makes a subname inactive.',
      'Service notifications and expiry reminders require browser permission and an open page. Favorites stay in this browser and are scoped to the registry. Clearing browser data removes them.',
    ],
  },
];

export const summaries: Record<string, string> = {
  'core-upgrades-v8':
    'Exact-class approvals, fixed delays, strict cancellation and compatible rollback for an independent V8 registry.',
  tokens:
    'The current payment token, private balance requirements and the role of network fee credit.',
  glossary:
    'Definitions of names, registration commitments, contract modules and transaction states.',
  'getting-started': 'Search, register and set up your name.',
  pricing: 'AZTEC denomination, current fees and payment availability.',
  manage: 'Keep your name active and confirm its primary address.',
  profile: 'Publish a profile and addresses for other chains.',
  permissions: 'Delegate record editing or transfer your name.',
  subnames: 'Issue, replace and revoke names under your domain.',
  sdk: 'Environment, example files and public read APIs.',
  'sdk-write': 'Wallet connection, payment checks and registration recovery.',
  deployments: 'Compare contract capabilities and migration requirements.',
  recovery: 'Resume registration and check transaction receipts.',
  troubleshooting: 'Diagnose connection, expiry and resolution issues.',
};

// One English content source powers the reading view and its Markdown export.
export type DocBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'steps' | 'list'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'callout'; title: string; text: string }
  | { type: 'code'; title: string; language: string; value: string }
  | { type: 'links'; items: { title: string; href: string }[] }
  | { type: 'downloads' | 'deployment' | 'fees' };
export type DocSection = { id: string; title: string; blocks: DocBlock[] };
export const groups: { id: Article['group']; title: string; description: string }[] = [
  {
    id: 'guide',
    title: 'Using ANS',
    description: 'Register, manage and share your name.',
  },
  {
    id: 'developer',
    title: 'Build with ANS',
    description: 'Resolve names and connect your application.',
  },
  {
    id: 'help',
    title: 'Help and recovery',
    description: 'Check receipts and recover interrupted work.',
  },
];
const headings: Record<string, string[]> = {
  'core-upgrades-v8': [
    'Independent deployment boundary',
    'Administrator trust and approvals',
    'Delays, cancellation and rollback',
    'Pinned reads and wallet execution',
  ],
  tokens: ['The token you need', 'AZTEC, test tokens and Fee Juice', 'Getting test tokens'],
  glossary: [
    'Names',
    'Commit',
    'Sponsored fees',
    'Registrar and resolver',
    'Generation and revision',
    'Proofs and dropped transactions',
  ],
  'getting-started': [
    'Choose a name',
    'Set up your wallet',
    'Prepare the payment',
    'Complete registration',
    'Set your receiving address',
  ],
  pricing: [
    'Annual pricing',
    'Understand the assets',
    'Activation requirements',
    'Launch policy',
    'Deployment configuration',
  ],
  manage: ['Find your names', 'Renew a lease', 'Confirm a primary name'],
  profile: ['Public profile records', 'Addresses for other chains', 'Sharing and visibility'],
  permissions: ['Owner and editor roles', 'Transfer a name'],
  subnames: ['Issue a subname', 'Parent control and revocation'],
  sdk: ['Environment and startup', 'Example files and dependencies', 'Name resolution'],
  'sdk-write': ['Wallet connection', 'Record updates'],
  deployments: ['Network and capabilities', 'Configuration and migration', 'Connected deployment'],
  recovery: ['Resume a saved plan', 'Handle policy changes'],
  troubleshooting: ['Wallet connection', 'Name resolution', 'Reminders and browser storage'],
};

export function sectionsFor(article: Article): DocSection[] {
  const sections: DocSection[] = article.body.map((text, i) => ({
    id: `section-${i + 1}`,
    title: headings[article.id][i],
    blocks: [{ type: 'paragraph', text }],
  }));
  if (article.id === 'sdk-write')
    sections.push({
      id: 'launch-policy',
      title: 'Launch eligibility and free quotes',
      blocks: [
        {
          type: 'paragraph',
          text: 'Before preparing a plan or sending commit, the quote needs at least 300 chain seconds remaining: 60 minimum commit age, 60 reveal margin and 180 proving, inclusion and checkpoint slack. COMMIT_QUOTE_MARGIN is 300n and REVEAL_MARGIN is 60n; insufficient lifetime returns quote_expired before wallet submission. Read config.launch and eligibility(name, snapshot) through @ans/sdk/read. Results are open, too_short, reserved or paused. The SDK rechecks before commit and reveal, and rejects non-year leases. A free quote creates no token AuthWit and reads no token balance. Public policy reads reserve nothing; encrypted recovery stores secrets and transaction hashes, while ownership and policy remain chain state. Unknown RPC or wallet errors never clear a saved transaction hash.',
        },
        {
          type: 'code',
          title: 'Inspect a launch quote',
          language: 'typescript',
          value: launchExample,
        },
      ],
    });
  if (article.id === 'sdk')
    sections.push({
      id: 'resolver-trust',
      title: 'Resolver trust and recovery',
      blocks: [
        {
          type: 'paragraph',
          text: 'inspectResolver(node, generation, snapshot) returns address, verified, isDefault and optional zero, unknown_class or other_registry reason. Network errors still throw. resolveAddress returns untrusted_resolver instead of a payment address for an unverified binding; resolvePrimary returns stale with reason untrusted_resolver. setPrimary refuses an unverified resolver with invalid_argument unless acceptUnverifiedResolver:true explicitly accepts that risk; network, active-lease and forward checks still apply. Only resolveAddress and resolvePrimary validate resolver trust. Raw RegistryReader.getAddress returns public chain records without that guard. Reset checks the target resolver without requiring a verified inherited resolver. AddressChangedV3.revision is the shared name revision on V3–V6 and the record revision on V7; indexers must select by protocol version.',
        },
        {
          type: 'code',
          title: 'Check a receiving address and restore the default resolver',
          language: 'typescript',
          value: resolverTrustExample,
        },
      ],
    });
  if (article.id === 'permissions')
    sections[1].blocks.push({
      type: 'paragraph',
      text: 'On V7, acceptance resets the resolver to the current default and reports resolverReset:true. On V6, acceptTransfer inherits the resolver and refuses an unverified one unless acceptUnverifiedResolver:true is explicit. The inherited V6 resolver can pump the shared revision and prevent reliable recovery. V6 testnet names must not be treated as holding value. Administrator changes to the default resolver apply immediately to future V7 registrations, reissues and accepted transfers (L-02); monitor configure_modules. V7 editor writes advance Holding.recordRevision without changing the holder NameRecord.revision; holder changes can invalidate pending editor writes.',
    });
  if (article.id === 'manage')
    sections[1].blocks.push({
      type: 'paragraph',
      text: 'The mainnet launch template sets maxRenewAhead to 31536000 chain seconds: renewal opens 1 year before expiry. The contract supports a configurable horizon per Registrar; the connected on-chain policy controls the displayed window. Local and testnet scripts retain their existing uncapped default.',
    });
  if (article.id === 'pricing')
    sections[3].blocks.push({
      type: 'paragraph',
      text: 'The v3 content-policy reservation file (schema ans-reserved-labels/1) contains 325 canonical labels, retaining all original v2 276 and adding 49, all at least 7 characters, grouped into Aztec, ANS, system, ecosystem, Noir, corporate, AI, payments and consumer identities. The loader rejects invalid and duplicate labels before hashing the sorted flat list. Support/official compounds are our anti-impersonation policy, not claims of an official company service. Reservation does not imply endorsement, ownership, partnership or trademark rights; Noir ecosystem inclusion does not establish deployment on Aztec. Short public names remain closed. Mainnet admin and treasury hold a placeholder address with an adminPlaceholder marker; a placeholder must be replaced before launch.',
    });
  if (article.id === 'getting-started') {
    sections[0].blocks.push({
      type: 'table',
      headers: ['Rule', 'Allowed'],
      rows: [
        ['Length', '3–31 characters'],
        ['Characters', 'ASCII letters, digits and hyphens'],
        ['Hyphens', 'Never at the start or end, never two in a row'],
        ['Prefix', 'Cannot start with 0x, so names never look like addresses'],
      ],
    });
    sections[1].blocks.push({
      type: 'links',
      items: [
        {
          title: 'Install Azguard for Chrome',
          href: 'https://azguardwallet.io/help/azguard-wallet/introducing',
        },
        {
          title: 'Wallet network setup',
          href: 'https://azguardwallet.io/help/wallet-setup',
        },
      ],
    });
    sections[2].blocks.push({
      type: 'links',
      items: [
        {
          title: 'Check current pricing and payment token',
          href: '#/docs/pricing',
        },
      ],
    });
    sections[3].blocks = [
      {
        type: 'steps',
        items: [
          'Review the duration, exact quote and token address. Keep your saved registration plan.',
          'Approve the commit transaction in your wallet and wait for its receipt.',
          'Wait for the registration window shown on the page.',
          'Approve payment and registration, then wait for confirmation.',
        ],
      },
      {
        type: 'callout',
        title: 'If interrupted',
        text: 'Return to Register with the same wallet and resume the saved plan. Check an existing transaction hash before retrying.',
      },
    ];
  }
  if (article.id === 'pricing') {
    sections[0].blocks.push({
      type: 'table',
      headers: ['Name length', 'Target price per year', 'Five years'],
      rows: (
        [
          ['3 characters', pricing.lengthPrices['3']],
          ['4 characters', pricing.lengthPrices['4']],
          ['5+ characters', pricing.annualPrice],
        ] as [string, string][]
      ).map(([length, price]) => {
        const year = `${formatUnits(BigInt(price), pricing.decimals)} AZTEC`;
        const five = `${formatUnits(BigInt(price) * 5n, pricing.decimals)} AZTEC`;
        return [length, year, five];
      }),
    });
    sections.splice(1, 0, {
      id: 'active-fees',
      title: 'Current on-chain fees',
      blocks: [{ type: 'fees' }],
    });
    sections[2].blocks.push({
      type: 'table',
      headers: ['Asset', 'Purpose'],
      rows: [
        ['AZTEC', 'Official Ethereum token; target registration currency'],
        ['mAZTEC', '18-decimal test stand-in, if enabled; no official AZTEC backing'],
        ['ANSF', 'Original 6-decimal ANS test payment token'],
        ['Fee Juice', 'Network gas credit; cannot pay the registration treasury'],
      ],
    });
    sections.push({
      id: 'sources',
      title: 'Official references',
      blocks: [
        {
          type: 'links',
          items: [
            { title: 'AZTEC token', href: pricing.referenceAsset.source },
            {
              title: 'Aztec network fees',
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
      headers: ['Key', 'Value'],
      rows: [
        ['description', 'A short public introduction'],
        ['url / avatar', 'Website or image URL'],
        ['com.github / com.twitter', 'Public social identifier'],
        ['address:eip155:1', 'Ethereum receiving address'],
        ['address:eip155:8453', 'Base receiving address'],
      ],
    });
  if (article.id === 'permissions') {
    sections[0].blocks.push({
      type: 'table',
      headers: ['Action', 'Owner', 'Editor'],
      rows: [
        ['Address and profile records', 'Yes', 'Yes'],
        ['Renew, resolver, editor and subnames', 'Yes', 'No'],
        ['Offer or cancel a transfer', 'Yes', 'No'],
        ['Accept a transfer', 'Offered recipient only', 'Offered recipient only'],
      ],
    });
    sections[1].blocks.push({
      type: 'callout',
      title: 'Acceptance resets records',
      text: 'The new owner must set addresses, records, editors and primary-name consent again. Descendants remain inactive.',
    });
  }
  if (article.id === 'sdk') {
    sections[2].blocks.push({
      type: 'paragraph',
      text: 'For repeated primary-name display, import Resolver from @ans/sdk/read. The memory cache deduplicates concurrent queries and checks cached block hashes for reorgs. Its default TTL is 30 seconds, capped by the name’s expiry. Invalidate it when switching accounts or deployments; payment checks use fresh chain reads. Owned-name pagination cursors include the chain and rollup version. Restart discovery without a cursor if an older saved cursor lacks that identity.',
    });
    sections[0].blocks.push({
      type: 'table',
      headers: ['Command', 'Result'],
      rows: [
        ['npm install', 'Install the bundled SDK and pinned dependencies'],
        ['npm run check', 'Check TypeScript types in the example'],
        ['npm run doctor', 'Read network identity, payment token, sponsor and contract modules'],
        ['npm run read', 'Resolve the example name and verify its primary name'],
        ['npm run dev', 'Start the browser example for wallet connection and registration'],
        ['npm run build', 'Build the browser example for hosting'],
      ],
    });
    sections[0].blocks.push({ type: 'downloads' });
    sections[1].blocks.push(
      {
        type: 'table',
        headers: ['File', 'Purpose'],
        rows: [
          ['deployment.json', 'RPC, registry, chain, rollup and sponsor configuration'],
          ['pricing.json', 'Pricing policy at the time of release'],
          ['read.ts / doctor.ts', 'Public resolution example and deployment diagnostics'],
          [
            'wallet-connection.ts / registration.ts',
            'Wallet discovery, channel confirmation and registration API wrapper',
          ],
          ['plan-store.ts', 'Encrypt and save registration plans in browser localStorage'],
          ['browser/main.ts', 'Connect the form, wallet approvals and saved plans'],
          ['README.md', 'Integration instructions'],
        ],
      },
      {
        type: 'paragraph',
        text: 'Configuration files are release snapshots. Read the active Registrar and fee quote from the chain before payment.',
      },
      {
        type: 'paragraph',
        text: 'The initial browser page imports @ans/sdk/read. Wallet discovery and registration load on user actions. The shared bundle-budget.ts build check limits initial JavaScript to 400 kB gzip and rejects eagerly loaded ANS execution artifacts; the build writes its measurements to bundle-budget.json.',
      },
    );
    sections[2].blocks.push(
      {
        type: 'table',
        headers: ['API or field', 'Meaning'],
        rows: [
          [
            'RegistryReader.connect',
            'Connect to the node and validate the registry contract class',
          ],
          [
            'resolveAddress',
            'Resolve a name to an Aztec address; use the address only when status is resolved',
          ],
          ['result.snapshot', 'Block used for this result; reuse it for related reads'],
          [
            'resolvePrimary',
            'Verify that the primary name resolves to this address in the current registration generation',
          ],
        ],
      },
      {
        type: 'code',
        title: 'Address and primary-name lookup',
        language: 'typescript',
        value: article.code!,
      },
      {
        type: 'links',
        items: [
          {
            title: 'Wallet integration and registration',
            href: '#/docs/sdk-write',
          },
          {
            title: 'Networks, versions and migration',
            href: '#/docs/deployments',
          },
        ],
      },
    );
  }
  if (article.id === 'sdk-write') {
    sections[0].blocks.push({
      type: 'paragraph',
      text: 'Private balance reads, fee authorization and transaction submission recheck the wallet’s chainId and rollup version inside its execution queue. A mismatch returns wrong_deployment before that operation proceeds. Reconnect after switching networks; a network error means the read is unavailable and must not be treated as a zero balance or free registration.',
    });
    sections[0].blocks.push({
      type: 'steps',
      items: [
        'Discover a compatible wallet in the current browser. Compare the connection symbols with the wallet and confirm the secure channel.',
        'Select an account returned by wallet.getAccounts and pass it to connectAns with the deployment configuration. The SDK checks the wallet’s chainId and rollup version against the reader before registering contracts.',
        'Keep one registration flow active per account. When switching accounts or networks, create a new context and load plans for that account and deployment.',
      ],
    });
    sections[1].blocks.push(
      {
        type: 'table',
        headers: ['Action', 'API'],
        rows: [
          ['Public profile and chain addresses', 'setTextRecord / setChainAddress'],
          ['Editor assignment', 'setManager'],
          ['Transfer offer and acceptance', 'offerTransfer / acceptTransfer'],
          ['Subname issuance and revocation', 'issueSubname / revokeSubname'],
        ],
      },
      {
        type: 'code',
        title: 'Profile and chain-address updates',
        language: 'typescript',
        value: article.code!,
      },
      {
        type: 'links',
        items: [
          {
            title: 'Ownership and editor permissions',
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
        title: 'Registration data',
        blocks: [
          {
            type: 'table',
            headers: ['Object', 'Contents and use', 'Storage'],
            rows: [
              [
                'RegistryReader',
                'Node connection and verified registry; reads public state',
                'Application memory',
              ],
              [
                'AnsContext',
                'Reader, wallet and authorized account; submits writes',
                'Application memory',
              ],
              [
                'FeeQuote',
                'Duration, amount, token and fee policy read from the chain',
                'Application memory; accepted values enter the plan',
              ],
              [
                'RegistrationPlan',
                'Account, name, registration secret, accepted fee and transaction hashes',
                'Encrypted by the application before store.save',
              ],
              [
                'RegistrationPlanStore',
                'Application-provided load and save methods; restore a plan by key',
                'Example: encrypted browser localStorage',
              ],
              [
                'Registration flow',
                'createRegistrationFlow coordinates plan storage and transactions',
                'Application memory; recreate after reload',
              ],
            ],
          },
        ],
      },
      {
        id: 'payment-readiness',
        title: 'Payment checks',
        blocks: [
          {
            type: 'paragraph',
            text: 'Read a fresh quote with flow.quote(duration, name), with duration in seconds; 31536000n is one year. The price depends on the name length, so pass the name to register and quote again when it changes. Call flow.readiness(quote) to check the selected account’s private balance. Display the quote and the following fields before asking the user to accept payment.',
          },
          {
            type: 'table',
            headers: ['Field', 'Meaning'],
            rows: [
              ['ready', 'Whether the private balance covers this quote'],
              ['balance', 'Private balance in the quoted token’s smallest units'],
              ['shortfall', 'Additional amount needed, in the same units'],
              ['token', 'Payment token address, symbol and decimals; omitted for a free quote'],
            ],
          },
          {
            type: 'paragraph',
            text: 'For direct calls, use getFeeReadiness(ctx, quote) or getPrivateFeeBalance(ctx, token). The SDK registers the exact payment-token artifact before private reads and paid authorization, including after a Registrar change. Read failures return errors rather than a zero balance.',
          },
          {
            type: 'callout',
            title: 'Test-token funding',
            text: 'Current test payment tokens have no self-serve faucet. Obtain private balance in the exact quoted token from the testnet operator. Fee Juice pays network fees; it cannot pay the registration treasury. doctor checks public configuration, while readiness checks the selected account’s balance.',
          },
          {
            type: 'links',
            items: [
              { title: 'Pricing and payment assets', href: '#/docs/pricing' },
              { title: 'Which token do I need?', href: '#/docs/tokens' },
            ],
          },
        ],
      },
      {
        id: 'registration-flow',
        title: 'Registration process',
        blocks: [
          {
            type: 'steps',
            items: [
              'Show the name, duration, token address and amount. Ask the user to accept the current quote.',
              'Call prepare with that quote. It rechecks the fee policy and saves the registration plan before returning.',
              'Call commit and ask the user to approve the first transaction in the wallet. Save and track its hash.',
              'Call check again while waiting. It reads chain time and returns ready_to_register when the registration window opens.',
              'Call finish and ask the user to approve payment and registration. Complete the flow after the receipt reaches checkpointed.',
            ],
          },
          {
            type: 'code',
            title: 'Connection and payment checks',
            language: 'typescript',
            value: connectionExample,
          },
          {
            type: 'paragraph',
            text: 'connectRegistration takes a connected reader, confirmed wallet, authorized account and recovery passphrase. It returns flow, store, quote and readiness without submitting a transaction. When readiness.ready is true, show the quote and ask the user to accept it before calling commitAcceptedPlan.',
          },
          {
            type: 'code',
            title: 'Commit and registration',
            language: 'typescript',
            value: registrationExample,
          },
          {
            type: 'paragraph',
            text: 'commitAcceptedPlan returns the saved plan after commit confirmation. finishReadyPlan returns the unchanged plan while waiting; call check again to display the remaining time. Once ready, it submits registration; an existing registerTx is tracked. onUpdate receives TxUpdate for transaction progress. These functions are application examples, not additional SDK APIs.',
          },
        ],
      },
    );
    sections.push(
      {
        id: 'registration-recovery',
        title: 'Plan storage and recovery',
        blocks: [
          {
            type: 'paragraph',
            text: 'The example encrypts each plan with seal/unseal and a recovery passphrase of at least eight characters before writing localStorage. Plans contain registration secrets; keep them out of URLs and logs. To resume after a reload, reconnect the same account, unlock the same store and load the plan before recreating the flow.',
          },
          {
            type: 'list',
            items: [
              'Keep the recovery passphrase and encrypted browser data. Clearing localStorage removes the saved plans.',
              'commit and finish load the latest saved plan and track an existing hash before submitting anything new. Even an older in-memory plan reuses the saved hash.',
              'If hash persistence fails after submission, unknown_tx_state carries the hash. Track it and repair storage before continuing.',
              'commit only broadcasts while no commitment exists and the name, Registrar and quote still match; otherwise it throws without sending. If the wallet returns no hash, including when it disconnects mid-request, the plan records broadcastUnknown. Inspect wallet activity before explicitly clearing and saving the flag, then recreate the flow. Call flow.recover(plan, kind, options), where kind is "commitTx" or "registerTx", to check a known receipt without broadcasting. Verified dropped or reverted outcomes, during recovery or right after sending, clear and save that hash, then throw the corresponding error. Timeouts preserve the hash; old plan copies use the latest saved progress.',
              'Multiple tabs or application instances need a shared storage lease to prevent concurrent submission. The example serializes actions within one tab.',
            ],
          },
        ],
      },
      {
        id: 'sdk-errors',
        title: 'Error handling',
        blocks: [
          {
            type: 'table',
            headers: ['Code', 'Action'],
            rows: [
              ['network', 'Retry the read and retain form data and saved plans'],
              [
                'not_administrator',
                'Reconnect with the current administrator account; do not retry the same unauthorized request',
              ],
              [
                'fee_changed',
                'Read and display a fresh quote; prepare a new plan after user acceptance',
              ],
              [
                'unknown_tx_state',
                'Check the stored hash or broadcastUnknown as described in Plan storage and recovery',
              ],
              ['wallet_rejected', 'Retain the plan and let the user retry wallet approval'],
              [
                'unsupported / wrong_deployment',
                'Verify the network, contract class and SDK version before signing',
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
      headers: ['Version', 'Capabilities'],
      rows: [
        ['V2', 'Root names, Aztec addresses and verified primary names'],
        ['V3', 'Registrar, Resolver and holder migration'],
        ['V4', 'Profiles, accepted transfers, editors and subnames'],
        ['V5', 'All V4 name features; direct administrator configuration and holder migration'],
        [
          'V7',
          'Fresh mainnet target; resolver reset on transfer and independent holder/record revisions; frozen V6 remains the testnet class',
        ],
        [
          'V6',
          'Aztec 6 name features and tiered pricing; fresh deployment with no imported or reserved legacy names',
        ],
      ],
    });
    sections[1].blocks = [
      {
        type: 'list',
        items: [
          'The current administrator calls configureModules to select Registrar and default Resolver, effective after confirmation. V5 uses setAdministrator for direct handover. V6/V7 require nominate_administrator and accept_administrator through their matching bindings; the SDK setAdministrator helper rejects both.',
          'Payment changes preserve name records but invalidate obsolete quotes and unconsumed plans. A new default Resolver applies to subsequent names; existing names retain their selected Resolver.',
          'The mainnet template targets protocol 7, retaining schema ans-deployment-v6/1, minPublicLength 7, the v3 content-policy reserved hash (list schema ans-reserved-labels/1) and maxRenewAhead 31536000. Readiness rejects the adminPlaceholder marker, protocol 6 on mainnet and any other launch renewal horizon. No mainnet deployment is implied.',
          'A new implementation has a new contract address. The current V6 deployment starts fresh with legacy set to zero; names on the old rollup are not migrated, reserved or snapshotted.',
          'For historical deployments with an explicitly configured legacy registry, holders may migrate root names during their lease or 30-day grace period, preserving owner, expiry and default address. Configure editors, profiles and subnames on the destination and confirm reverse consent again. These legacy migration rules do not apply to the fresh V6 testnet.',
          'A website release does not change the active contract class.',
        ],
      },
    ];
    sections[1].blocks.push({
      type: 'code',
      language: 'typescript',
      title: 'Configure modules as the current administrator',
      value: configurationExample,
    });
    sections[2].blocks.push({ type: 'deployment' });
  }
  if (article.id === 'recovery')
    sections[0].blocks.push({
      type: 'steps',
      items: [
        'Reconnect the original wallet and account.',
        'Open Register and restore the saved or encrypted plan.',
        'Check the receipt of every existing hash.',
        'Continue only the next unconfirmed step.',
      ],
    });
  return sections;
}

export function articleToMarkdown(article: Article): string {
  const tableCell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`# ${article.title}`, '', summaries[article.id], ''];
  for (const section of sectionsFor(article)) {
    lines.push(`## ${section.title}`, '');
    for (const block of section.blocks) {
      switch (block.type) {
        case 'paragraph':
          lines.push(block.text);
          break;
        case 'steps':
        case 'list':
          lines.push(
            ...block.items.map(
              (item, i) => `${block.type === 'steps' ? `${i + 1}.` : '-'} ${item}`,
            ),
          );
          break;
        case 'callout':
          lines.push(`> **${block.title}**`, `> ${block.text}`);
          break;
        case 'code':
          lines.push(`### ${block.title}`, '', `\`\`\`${block.language}`, block.value, '```');
          break;
        case 'table':
          lines.push(
            `| ${block.headers.map((h) => tableCell(h)).join(' | ')} |`,
            `| ${block.headers.map(() => '---').join(' | ')} |`,
            ...block.rows.map((row) => `| ${row.map((c) => tableCell(c)).join(' | ')} |`),
          );
          break;
        case 'links':
          lines.push(
            ...block.items.map(
              (link) =>
                `- [${link.title}](${link.href.startsWith('#/') ? `https://ans-testnet.huantian233.workers.dev/${link.href}` : link.href})`,
            ),
          );
          break;
        case 'downloads':
          lines.push(
            `[${'Download SDK and runnable starter'}](https://ans-testnet.huantian233.workers.dev/#/docs/sdk)`,
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
            'Read the current contract class and modules on the website.',
          );
          break;
        case 'fees':
          lines.push(
            `[${'Read the current on-chain quote and payment token'}](https://ans-testnet.huantian233.workers.dev/#/docs/pricing)`,
            '',
            'This export has no live price snapshot. Check the on-chain quote before paying.',
          );
          break;
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
