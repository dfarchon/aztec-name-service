import { useEffect, useRef, useState } from 'react';
import type { RegistryReader, RegistryConfig } from '@ans/sdk/read';
import { articles, articleToMarkdown, groups, sectionsFor, summaries, type Article, type DocBlock } from '../docs-content';
import { Card, CopyValue } from '../components';
import { FeeAmount } from '../fees';
import { getLocale, translate as t } from '../i18n';
import { useSession } from '../session';
import { SdkDownloads } from '../SdkDownloads';
import { deploymentProtocolLabel } from '../deployment';
import { config } from '../config';

type Lang = 0 | 1;
const label = (lang: Lang, en: string, zh: string) => lang ? zh : en;
const searchIndex = new Map(articles.map(article=>[article.id, `${articleToMarkdown(article,0)}\n${articleToMarkdown(article,1)}`.toLowerCase()]));

function CopyText({ value, lang, markdown = false }: { value: string; lang: Lang; markdown?: boolean }) {
 const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
 useEffect(() => { setState('idle'); }, [value]);
 return <button type="button" className="ghost doc-copy" onClick={async () => {
  try { await navigator.clipboard.writeText(value); setState('copied'); }
  catch { setState('failed'); }
 }} aria-live="polite">{state === 'copied' ? label(lang, 'Copied', '已复制') : state === 'failed' ? label(lang, 'Copy failed · retry', '复制失败 · 重试') : markdown ? label(lang, 'Copy Markdown', '复制 Markdown') : label(lang, 'Copy code', '复制代码')}</button>;
}

function ActiveFees({ lang }: { lang: Lang }) {
 const { reader } = useSession();
 const [revision, refresh] = useState(0);
 const [read, setRead] = useState<{ reader: RegistryReader; config: RegistryConfig; block: number; timestamp: bigint }>();
 const [failed, setFailed] = useState(false);
 useEffect(() => {
  let live = true; setFailed(false);
  if (reader) void (async () => {
   const snapshot = await reader.snapshot('finalized');
   const config = await reader.getConfig(snapshot);
   if (!await reader.isCanonical(snapshot)) throw new Error('Non-canonical fee snapshot');
   if (live) setRead({ reader, config, block: snapshot.blockNumber, timestamp: snapshot.timestamp });
  })().catch(() => { if (live) { setRead(undefined); setFailed(true); } });
  return () => { live = false; };
 }, [reader, revision]);
 const current = read?.reader === reader ? read : undefined;
 return <div className="doc-fees" aria-live="polite">
  {current ? <>
   <p className="doc-price"><FeeAmount amount={current.config.annualPrice} token={current.config.feeToken.toString()} /> <span>{label(lang, '/ year', '/ 年')}</span></p>
   <dl><dt>{label(lang, 'Payment token', '支付 Token')}</dt><dd><CopyValue value={current.config.feeToken.toString()} /></dd><dt>{label(lang, 'Registrar', '注册器')}</dt><dd><CopyValue value={current.config.registrar?.toString() ?? current.reader.registry.toString()} /></dd><dt>{label(lang, 'Price version / block', '价格版本 / 区块')}</dt><dd>{current.config.priceVersion} / {current.block}</dd></dl>
  </> : <p>{label(lang, failed ? 'The live quote could not be verified. Open Register and retry before paying.' : 'Reading the active Registrar…', failed ? '未能核验实时费用。付款前请进入注册页重新读取。' : '正在读取当前注册器…')}</p>}
  <div className="doc-inline-actions"><button type="button" className="ghost" onClick={() => { setRead(undefined); refresh(n=>n+1); }}>{label(lang, 'Refresh fees', '刷新费用')}</button><a href="#/register">{label(lang, 'Open Register', '进入注册页')} →</a></div>
 </div>;
}

function DeploymentInfo({ lang }: { lang: Lang }) {
 const { reader } = useSession();
 return reader ? <dl className="doc-deployment"><dt>Registry</dt><dd><CopyValue value={reader.registry.toString()} /></dd><dt>{label(lang, 'Contract class', '合约类')}</dt><dd><CopyValue value={reader.classId} /></dd><dt>{label(lang, 'Protocol features', '协议功能')}</dt><dd>{deploymentProtocolLabel(reader)}</dd><dt>RPC</dt><dd>{config.nodeUrl}</dd></dl> : <p>{label(lang, 'Connect to the node to verify this deployment.', '连接节点后可核验当前部署。')}</p>;
}

function Block({ block, lang }: { block: DocBlock; lang: Lang }) {
 switch (block.type) {
  case 'paragraph': return <p>{block.text[lang]}</p>;
  case 'steps': return <ol className="doc-steps">{block.items.map((item,i)=><li key={i}><span className="doc-step-number" aria-hidden="true">{i+1}</span><p>{item[lang]}</p></li>)}</ol>;
  case 'list': return <ul className="doc-list">{block.items.map((item,i)=><li key={i}>{item[lang]}</li>)}</ul>;
  case 'table': return <div className="doc-table-wrap"><table><thead><tr>{block.headers.map((h,i)=><th scope="col" key={i}>{h[lang]}</th>)}</tr></thead><tbody>{block.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell[lang]}</td>)}</tr>)}</tbody></table></div>;
  case 'callout': return <aside className="doc-callout"><strong>{block.title[lang]}</strong><p>{block.text[lang]}</p></aside>;
  case 'code': return <figure className="doc-code"><figcaption><span>{block.title[lang]}</span><CopyText value={block.value} lang={lang} /></figcaption><pre><code>{block.value}</code></pre><span className="doc-code-language">{block.language}</span></figure>;
  case 'links': return <ul className="doc-links">{block.items.map(link=><li key={link.href}><a href={link.href} {...(link.href.startsWith('https:') ? {target:'_blank',rel:'noopener noreferrer'} : {})}>{link.title[lang]} <span aria-hidden="true">↗</span></a></li>)}</ul>;
  case 'downloads': return <SdkDownloads />;
  case 'deployment': return <DeploymentInfo lang={lang} />;
  case 'fees': return <ActiveFees lang={lang} />;
 }
}

function ArticleView({ article, lang }: { article: Article; lang: Lang }) {
 const sections = sectionsFor(article), position = articles.indexOf(article);
 const markdown = articleToMarkdown(article, lang);
 const [active, setActive] = useState(sections[0].id);
 useEffect(() => {
  setActive(sections[0].id);
  const observer = new IntersectionObserver(entries => {
   const visible = entries.filter(entry=>entry.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);
   if (visible[0]) setActive(visible[0].target.id);
  }, { rootMargin: '-5% 0px -60% 0px' });
  for (const section of sections) { const element = document.getElementById(section.id); if (element) observer.observe(element); }
  return () => observer.disconnect();
 }, [article.id]);
 const jump = (id: string) => { setActive(id); const element=document.getElementById(id); element?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}); element?.focus({preventScroll:true}); };
 const toc = <><strong>{label(lang,'On this page','本页目录')}</strong><nav aria-label={label(lang,'Article sections','文章章节')}>{sections.map(section=><button type="button" key={section.id} className={active===section.id?'active':''} aria-current={active===section.id?'location':undefined} onClick={()=>jump(section.id)}>{section.title[lang]}</button>)}</nav></>;
 return <>
  <article className="doc-article">
   <header className="doc-article-header"><div className="doc-breadcrumb"><a href="#/docs">{label(lang,'Documentation','文档')}</a><span>/</span><span>{groups.find(group=>group.id===article.group)!.title[lang]}</span></div><h1>{article.title[lang]}</h1><p className="doc-lead">{summaries[article.id][lang]}</p><div className="doc-article-tools"><CopyText value={markdown} lang={lang} markdown /><a href={`/downloads/docs/${lang?'zh-CN':'en'}/${article.id}.md`} download>{label(lang,'Download .md','下载 .md')}</a><button type="button" className="ghost" onClick={()=>window.print()}>{label(lang,'Print / save PDF','打印 / 保存 PDF')}</button></div></header>
   <details className="doc-mobile-toc"><summary>{label(lang,'On this page','本页目录')}</summary>{toc}</details>
   {sections.map(section=><section className="doc-section" id={section.id} key={section.id} tabIndex={-1}><h2>{section.title[lang]}</h2>{section.blocks.map((block,i)=><Block key={i} block={block} lang={lang} />)}</section>)}
   <div className="doc-article-footer"><p>{label(lang,'Need to check the connected network?','需要核对当前网络？')} <a href="#/status">{t('View service status')} →</a></p><nav className="doc-pagination" aria-label={label(lang,'Adjacent articles','前后文章')}>{[articles[position-1],articles[position+1]].map((item,i)=>item ? <a key={item.id} href={`#/docs/${item.id}`}><small>{label(lang,i===0?'Previous':'Next',i===0?'上一篇':'下一篇')}</small><strong>{item.title[lang]} {i===1?'→':''}</strong></a> : <span key={i} />)}</nav></div>
  </article>
  <aside className="doc-toc">{toc}</aside>
 </>;
}

export function DocsPage({ article, help=false }: { article?: string; help?: boolean }) {
 const mobileNavigation=useRef<HTMLDetailsElement>(null);
 const [query,setQuery] = useState(''), lang: Lang = getLocale()==='zh-CN'?1:0;
 const selected = articles.find(a=>a.id===article), needle=query.trim().toLowerCase();
 const visible = articles.filter(a=>(!help || a.group==='help') && searchIndex.get(a.id)!.includes(needle));
 useEffect(() => { setQuery(''); if(mobileNavigation.current) mobileNavigation.current.open=false; window.scrollTo(0,0); }, [article,help]);
 const navigation = <><a className="doc-home-link" href="#/docs">{label(lang,'ANS documentation','ANS 文档中心')}</a><label className="doc-search"><span>{t('Search documentation')}</span><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={label(lang,'Search articles…','搜索文章…')} /></label><nav className="doc-sidebar-nav" aria-label={t('Documentation navigation')}>{groups.map(group=>{
  const entries=visible.filter(a=>a.group===group.id);
  return entries.length ? <div className="doc-nav-group" key={group.id}><h2>{group.title[lang]}</h2>{entries.map(a=><a href={`#/docs/${a.id}`} aria-current={selected?.id===a.id?'page':undefined} className={selected?.id===a.id?'active':''} key={a.id}>{a.title[lang]}</a>)}</div> : null;
 })}</nav>{!visible.length && <p className="muted" role="status">{t('No matching articles.')}</p>}<a className="doc-sidebar-status" href="#/status">{t('View service status')} ↗</a></>;
 return <div className={`documentation ${selected?'has-article':''}`}>
  <aside className="doc-sidebar">{navigation}</aside><details className="doc-mobile-navigation" ref={mobileNavigation}><summary>{label(lang,'Browse documentation','浏览文档目录')}</summary>{navigation}</details>
  {selected ? <ArticleView key={selected.id} article={selected} lang={lang} /> : <div className="doc-index">
   <header className="doc-index-header"><span className="doc-kicker">{help?label(lang,'Help and recovery','帮助与恢复'): 'AZTEC NAME SERVICE'}</span><h1>{article?label(lang,'Article not found','未找到这篇文章'):help?label(lang,'Get back on track.','继续完成你的操作。'):label(lang,'Your name. Your next step.','从名字，开始。')}</h1><p className="doc-lead">{article?label(lang,'Choose a guide below or search the documentation.','请从下方选择文章，或搜索文档。'):help?label(lang,'Find the right receipt, wallet or recovery step.','找到对应回执、钱包检查或恢复步骤。'):label(lang,'Guides for your first name and everything you build with it.','从注册第一个名字，到将 ANS 接入你的应用。')}</p></header>
   {!help && !needle && <div className="doc-entry-grid">{['getting-started','sdk','pricing'].map((id,i)=><a className="doc-entry" href={`#/docs/${id}`} key={id}><span className="doc-entry-number">0{i+1}</span><strong>{articles.find(a=>a.id===id)!.title[lang]}</strong><span>{summaries[id][lang]}</span><span className="doc-entry-arrow" aria-hidden="true">↗</span></a>)}</div>}
   {groups.map(group=>{const entries=visible.filter(a=>a.group===group.id);return entries.length ? <section className="doc-category" key={group.id}><header><h2>{group.title[lang]}</h2><p>{group.description[lang]}</p></header><div className="doc-category-links">{entries.map(a=><a href={`#/docs/${a.id}`} key={a.id}><span><strong>{a.title[lang]}</strong><small>{summaries[a.id][lang]}</small></span><span aria-hidden="true">→</span></a>)}</div></section> : null;})}
   {!visible.length && <p role="status">{t('No matching articles.')}</p>}
   <p className="doc-reference">{t('Reference:')} <a href="https://docs.ens.domains/" target="_blank" rel="noopener noreferrer">ENS</a> · <a href="https://docs.aztec.network/" target="_blank" rel="noopener noreferrer">Aztec</a></p>
  </div>}
 </div>;
}

export function ChangelogPage() {
 const lang: Lang=getLocale()==='zh-CN'?1:0;
 const releases=[
  {version:'SDK 0.6.0',title:['Prices by name length','按名字长度定价'],text:['Like ENS, shorter names cost more: 128, 32 and 1 per year for 3, 4 and 5+ characters, and renewals use the same tier. New names cannot contain "--" or start with "0x". Existing names keep resolving and renewing. Quotes now take the name.','参照 ENS，名字越短越贵：3 个字符、4 个字符、5 个字符及以上年费分别为 128、32、1，续期按同一档位。新注册的名字不能包含 --，也不能以 0x 开头；已有名字照常解析和续期。报价需传入名字。']},
  {version:'V5 / SDK 0.5.0',title:['Direct administrator configuration','管理员即时配置'],text:['Immediate module configuration, receipt-safe payment recovery and holder-initiated migration for new core deployments.','模块配置确认后即生效，付款按已有回执恢复，新核心部署由持有人迁移。']},
  {version:'SDK 0.4.5',title:['Faster first load and payment readiness','首屏加载与付款准备'],text:['Contract execution code loads when needed. Registration and renewal check the exact private payment balance before confirmation. Registration plans recover existing receipts after reload.','合约执行代码按需加载。注册和续期确认前核对准确支付 Token 的私有余额。重新加载注册计划后恢复已有回执。']},
  {version:'October 2026',title:['Documentation and developer onboarding','文档与开发者接入'],text:['A structured bilingual documentation center, downloadable SDK starter, exact token metadata, private payment balance checks and recoverable registration plans. AZTEC is the selected pricing currency; the pricing page reads the active payment asset from the chain.','结构化双语文档中心、可下载 SDK 完整示例、准确 Token 信息、私有支付余额检查及可恢复的注册计划。已选择 AZTEC 作为计价币；价格页从链上读取当前实际支付资产。']},
  {version:'V4',title:['Names as a complete profile','名字与完整资料'],text:['Recipient-confirmed transfers, editor permissions, subnames, public profiles and multi-chain address records. Favorites, expiry calendars and profile QR codes make names easier to manage and share.','接收方确认的转移、编辑权限、子名字、公开资料与多链地址记录。收藏、到期日历和资料二维码便于管理与分享。']},
  {version:'V2',title:['Public name registration','公开名字注册'],text:['Paid registration and renewal, Aztec address records and bidirectionally verified primary names.','付费注册与续期、Aztec 地址记录与双向验证的主名字。']},
 ];
 return <Card title={t('Product updates')}><p className="muted">{t('Public deployment is tracked separately on the Status page.')}</p><ol className="doc-changelog">{releases.map(release=><li key={release.version}><span>{release.version}</span><h3>{release.title[lang]}</h3><p>{release.text[lang]}</p></li>)}</ol><a href="#/docs">{label(lang,'Explore the documentation','浏览文档中心')} →</a></Card>;
}
