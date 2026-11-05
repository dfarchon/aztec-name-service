import { translate } from '../i18n';
import {
  AnsError,
  assertRegistrableLabel,
  type FeeQuote,
  getFeeQuote,
  normalizeName,
  type RegistrationCheck,
  type RegistrationPlan,
  toAnsError,
} from '@ans/sdk';
import { useEffect, useState } from 'react';

import { ChooseAccount, go, NeedsAccount } from '../App';
import { Card, CopyValue, Field, TxLine, useTx } from '../components';
import { FeeAmount, FeeBalance, readFeeBalance, useFeeBalance } from '../fees';
import { config } from '../config';
import { duration, errorMessage } from '../format';
import { choosingAccount, recordWriter, useSession } from '../session';
import { registrationFlow } from '../registration';
import { canDiscardUncertain, parseTxHash } from '../registration-recovery';

const YEAR = 365n * 86400n;

export function RegisterPage({ initial }: { initial?: string }) {
  const s = useSession();
  const { ctx, records, wallet } = s;
  if (choosingAccount(s)) return <ChooseAccount />;
  if (wallet && !ctx)
    return (
      <Card>
        <p role="status">{translate('Switching wallet account…')}</p>
      </Card>
    );
  if (!ctx || !records)
    return (
      <>
        <RegistrationPreparation />
        <NeedsAccount />
      </>
    );
  return (
    <>
      {records.plans.map((p) => (
        <PlanCard key={p.commitment.toString()} plan={p} />
      ))}
      <NewRegistration initial={initial} />
    </>
  );
}

function RegistrationPreparation() {
  const { reader } = useSession();
  const [quote, setQuote] = useState<FeeQuote>();
  const [error, setError] = useState<string>();
  const [revision, retry] = useState(0);
  useEffect(() => {
    let live = true;
    setQuote(undefined);
    setError(undefined);
    if (reader)
      // A 5+ character quote carries the base price and, on tiered registrars, the short-name tiers.
      void getFeeQuote(reader, { operation: 'register', duration: YEAR, labelLength: 5 })
        .then((q) => {
          if (live) setQuote(q);
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    return () => {
      live = false;
    };
  }, [reader, revision]);
  return (
    <Card title={translate('Prepare to register')}>
      {quote?.lengthPrices && quote.fee > 0n ? (
        <PriceTiers quote={quote} />
      ) : quote ? (
        <p>
          {translate('Registration fee for one year:')}{' '}
          <FeeAmount amount={quote.fee} token={quote.feeToken.toString()} />
        </p>
      ) : (
        <p>{translate(error ?? 'Loading…')}</p>
      )}
      {error && (
        <button className="ghost" onClick={() => retry((n) => n + 1)}>
          {translate('Retry fee quote')}
        </button>
      )}
      <RegistrationFunding free={quote?.fee === 0n} />
      <a href="#/docs/getting-started">{translate('Wallet and testnet setup')}</a>
    </Card>
  );
}

/** Annual prices by name length, shown before a name is chosen. */
function PriceTiers({ quote }: { quote: FeeQuote }) {
  const token = quote.feeToken.toString();
  const tiers = quote.lengthPrices!;
  return (
    <dl className="price-tiers">
      <dt>{translate('3 characters')}</dt>
      <dd>
        <FeeAmount amount={tiers.three} token={token} /> {translate('/ year')}
      </dd>
      <dt>{translate('4 characters')}</dt>
      <dd>
        <FeeAmount amount={tiers.four} token={token} /> {translate('/ year')}
      </dd>
      <dt>{translate('5+ characters')}</dt>
      <dd>
        <FeeAmount amount={quote.annualPrice} token={token} /> {translate('/ year')}
      </dd>
    </dl>
  );
}

function RegistrationFunding({ free = false }: { free?: boolean }) {
  return (
    <>
      {!free && <p className="muted">
        {translate(
          'Registration uses the payment token shown here. Fee Juice does not pay this registration fee.',
        )}
      </p>}
      {config.feePayment === 'sponsored' && (
        <p className="muted">{translate('Network fees are sponsored for this app.')}</p>
      )}
      {config.feePayment === 'fee-juice' && <p className="muted">{translate("Network fees are paid from this account's Fee Juice.")}</p>}
      {!free && config.network === 'testnet-v6' && (
        <p className="warn">
          {translate(
            'Use a test account funded in the exact payment token shown in the quote. Fee Juice and other tokens with the same symbol cannot pay registration fees.',
          )}{' '}
          <a href="#/docs/pricing">{translate('Pricing and payment assets')}</a>
        </p>
      )}
    </>
  );
}

function NewRegistration({ initial }: { initial?: string }) {
  const { ctx, records } = useSession();
  const [name, setName] = useState(initial ?? '');
  const [years, setYears] = useState(1);
  const [quote, setQuote] = useState<FeeQuote>();
  const [error, setError] = useState<string>();
  const [quoteRevision, retryQuote] = useState(0);
  const tx = useTx();
  const balance = useFeeBalance(ctx, quote && quote.fee > 0n ? quote.feeToken.toString() : undefined);
  const [eligibility, setEligibility] = useState<'open'|'too_short'|'reserved'|'paused'>('open');

  let label: string | undefined;
  let labelError: string | undefined;
  try {
    if (name) {
      const parsed = normalizeName(name, { suffix: config.nameSuffix });
      try {
        assertRegistrableLabel(parsed);
        label = parsed.label;
      } catch {
        labelError = 'Names cannot start with "0x" or contain "--".';
      }
    }
  } catch {
    labelError = 'Invalid name format';
  }
  const labelLength = label?.length;

  useEffect(() => {
    if (!ctx) return;
    let live = true;
    setQuote(undefined);
    setError(undefined);
    setEligibility('open');
    void (async () => {
      const policy = await ctx.reader.getConfig();
      const lease = policy.launch ? YEAR : BigInt(years) * YEAR;
      if (policy.launch && live && years !== 1) setYears(1);
      const q = await getFeeQuote(ctx.reader, {
      operation: 'register',
      duration: lease,
      labelLength,
    });
      const eligible = label ? await ctx.reader.eligibility(label) : 'open';
      if(live) {setQuote(q);setEligibility(eligible);}
    })()
      .catch((e) => {
        // Tiered registrars cannot quote until a valid name gives the length.
        if (labelLength === undefined && toAnsError(e).code === 'invalid_argument') return;
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [ctx, years, quoteRevision, labelLength, label]);

  if (!ctx || !records) return null;
  const existingPlan = label ? records.plans.find((p) => p.label === label) : undefined;
  const duplicate = !!existingPlan;

  const start = () =>
    tx.exec(`Submit registration ${label}`, async (onUpdate) => {
      if (quote!.fee > 0n && (await readFeeBalance(ctx, quote!.feeToken.toString())) < quote!.fee)
        throw new AnsError(
          'invalid_argument',
          'Insufficient registration fee token balance. Fund this account before starting.',
        );
      const flow = registrationFlow(ctx);
      const plan = await flow
        .prepare({ name: label!, acceptedQuote: quote! })
        .catch(async (error) => {
          if (toAnsError(error).code === 'fee_changed') {
            setQuote(undefined);
            setQuote(await flow.quote(BigInt(years) * YEAR, label));
          }
          throw error;
        });
      await flow.commit(plan, { onUpdate });
    });

  if (duplicate)
    // A later retry's saved hash supersedes this form's earlier wallet cancellation.
    // The plan card owns recovery and the current transaction status from this point.
    return !(tx.update?.state === 'cancelled' && existingPlan?.commitTx) &&
      (tx.busy || tx.error || error) ? (
      <Card>
        {error && <small className="err">{translate(error)}</small>}
        <TxLine tx={tx} />
      </Card>
    ) : null;

  return (
    <Card title={translate('Registration details')}>
      <Field label={translate('Name')}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={translate('alice')}
        />
      </Field>
      {labelError && <small className="err">{translate(labelError)}</small>}
      <Field label={translate('Registration period')}>
        {quote?.launch ? <p>1 year (365 days)</p> : <select value={years} onChange={(e) => setYears(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map((y) => (
            <option key={y} value={y}>
              {y} {y === 1 ? translate('year') : translate('years')}
            </option>
          ))}
        </select>}
      </Field>
      {eligibility !== 'open' && <p role="status">{eligibility === 'paused' ? 'Public registration is paused. Renewals remain available to holders.' : eligibility === 'reserved' ? 'Reserved' : 'Not yet available'}</p>}
      {quote && (
        <>
          <p>
            {translate('Registration fee:')}{' '}
            <FeeAmount amount={quote.fee} token={quote.feeToken.toString()} />
          </p>
          <FeeBalance amount={quote.fee} token={quote.feeToken.toString()} read={balance} />
          <details className="fee-details">
            <summary>{translate('Fee details')}</summary>
            <dl>
              <dt>{translate('Payment token')}</dt>
              <dd>
                <code>{quote.feeToken.toString()}</code>
              </dd>
              <dt>{translate('Treasury address')}</dt>
              <dd>
                <code>{quote.treasury.toString()}</code>
              </dd>
              <dt>{translate('Maximum fee')}</dt>
              <dd>
                <FeeAmount amount={quote.maxFee} token={quote.feeToken.toString()} />
              </dd>
              <dt>{translate('Network fee')}</dt>
              <dd>
                {ctx.signer.fee?.paymentMethod
                  ? translate('Sponsored')
                  : translate('Confirmed in wallet')}
              </dd>
            </dl>
          </details>
        </>
      )}
      <RegistrationFunding free={quote?.fee === 0n} />
      {!quote && error && (
        <button className="ghost" disabled={tx.busy} onClick={() => retryQuote((n) => n + 1)}>
          {translate('Retry fee quote')}
        </button>
      )}
      <p className="muted">
        {translate(quote?.fee === 0n ? 'Submit a request, then register for free after the waiting period. Network fees still apply.' : 'Submit a request, then pay to register after the waiting period.')}
      </p>
      <button
        disabled={
          !label ||
          !!duplicate ||
          tx.busy ||
          !quote ||
          eligibility !== 'open' ||
          (quote.fee > 0n && (balance.balance === undefined || balance.balance < quote.fee))
        }
        onClick={start}
      >
        {translate('Start registration')}
      </button>
      {error && <small className="err">{translate(error)}</small>}
      <TxLine tx={tx} />
    </Card>
  );
}

const CHECK_TEXT: Record<RegistrationCheck['state'], string> = {
  policy_changed: 'Registration policy changed. Prepare a new registration.',
  commit_missing: 'Awaiting commit confirmation',
  commit_wait: 'Waiting period',
  ready_to_register: 'Ready to register',
  registered: 'Registered',
  commit_expired: 'Registration request expired',
  quote_expired: 'Quote expired',
  generation_changed: 'Name state changed',
  name_taken: 'This name is already registered.',
};

function PlanCard({ plan }: { plan: RegistrationPlan }) {
  const { ctx } = useSession();
  const [check, setCheck] = useState<RegistrationCheck>();
  const [error, setError] = useState<string>();
  const tx = useTx();
  const [hashInput, setHashInput] = useState('');
  const [hashError, setHashError] = useState<string>();
  const canFinish =
    check?.state === 'ready_to_register' &&
    !plan.registerTx &&
    plan.broadcastUnknown !== 'registerTx';
  const canRetryCommit =
    check?.state === 'commit_missing' && !plan.commitTx && plan.broadcastUnknown !== 'commitTx';
  const uncertain =
    check?.state !== 'registered' &&
    (plan.broadcastUnknown === 'registerTx' ||
      (plan.broadcastUnknown === 'commitTx' && (!check || check.state === 'commit_missing')));
  const balance = useFeeBalance(ctx, plan.fee > 0n && (canFinish || canRetryCommit) ? plan.feeToken : undefined);

  useEffect(() => {
    if (!ctx) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setCheck(undefined);
    setError(undefined);
    const poll = async () => {
      try {
        const c = await registrationFlow(ctx).check(plan);
        if (live) (setCheck(c), setError(undefined));
      } catch (e) {
        if (live) {
          setCheck(undefined);
          setError(errorMessage(e));
        }
      } finally {
        if (live) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => ((live = false), clearTimeout(timer));
  }, [ctx, plan]);

  if (!ctx) return null;
  const flow = registrationFlow(ctx);
  const finish = () =>
    tx.exec(`Complete registration ${plan.label}`, (onUpdate) => flow.finish(plan, { onUpdate }));
  const retryCommit = () =>
    tx.exec(`Retry commit ${plan.label}`, (onUpdate) => flow.commit(plan, { onUpdate }));
  const receipt = (kind: 'commitTx' | 'registerTx') =>
    tx.exec(`Check transaction for ${plan.label}`, (onUpdate) =>
      flow.recover(plan, kind, { timeoutMs: 15000, onUpdate }),
    );
  const abandon = () =>
    recordWriter(ctx)((r) => ({
      ...r,
      plans: r.plans.filter((p) => p.commitment !== plan.commitment),
    }));
  const attachHash = (kind: 'commitTx' | 'registerTx') => {
    const hash = parseTxHash(hashInput);
    if (!hash) {
      setHashError('Enter a 0x-prefixed 64-character transaction hash.');
      return;
    }
    setHashError(undefined);
    const write = recordWriter(ctx);
    void tx.exec(`Recover transaction for ${plan.label}`, async (onUpdate) => {
      // User-supplied hashes never clear uncertainty, even if an unrelated receipt is dropped.
      let attached = { ...plan, [kind]: hash };
      await write((r) => ({ ...r, plans: r.plans.map((p) => {
        if (p.commitment !== plan.commitment) return p;
        attached = { ...p, [kind]: hash };
        return attached;
      }) }));
      await flow.recover(attached, kind, { timeoutMs: 15000, onUpdate });
    });
  };
  const discard = async () => {
    if (plan.broadcastUnknown) {
      const fresh = await flow.check(plan);
      setCheck(fresh);
      if (!canDiscardUncertain(plan, fresh)) {
        setError('Cannot remove yet: the quote has not expired on chain.');
        return;
      }
    }
    await abandon();
  };
  const dead =
    check &&
    [
      'policy_changed',
      'commit_expired',
      'quote_expired',
      'generation_changed',
      'name_taken',
    ].includes(check.state);

  return (
    <Card
      title={plan.label}
      tone={dead ? 'warn' : check?.state === 'registered' ? 'ok' : undefined}
    >
      <dl>
        <dt>{translate('Status')}</dt>
        <dd>
          {check
            ? translate(
                check.state === 'commit_missing' && !plan.commitTx
                  ? 'Not submitted'
                  : CHECK_TEXT[check.state],
              )
            : translate('Loading…')}
          {check?.state === 'commit_wait' &&
            translate(' · about {time}', { time: duration(check.readyInSeconds) })}
        </dd>
        <dt>{translate('Registration fee')}</dt>
        <dd>
          <FeeAmount amount={plan.fee} token={plan.feeToken} />
        </dd>
        {plan.commitTx && (
          <>
            <dt>{translate('Commit transaction')}</dt>
            <dd>
              <CopyValue value={plan.commitTx} label={translate('Copy commit transaction hash')} />
            </dd>
          </>
        )}
      </dl>
      <details className="fee-details">
        <summary>{translate('Fee details')}</summary>
        <dl>
          <dt>{translate('Payment token')}</dt>
          <dd>
            <code>{plan.feeToken}</code>
          </dd>
          <dt>{translate('Treasury address')}</dt>
          <dd>
            <code>{plan.treasury}</code>
          </dd>
          <dt>{translate('Maximum fee')}</dt>
          <dd>
            <FeeAmount amount={plan.maxFee} token={plan.feeToken} />
          </dd>
          <dt>{translate('Network fee')}</dt>
          <dd>
            {ctx.signer.fee?.paymentMethod
              ? translate('Sponsored')
              : translate('Confirmed in wallet')}
          </dd>
        </dl>
      </details>
      {canFinish && (
        <>
          <FeeBalance amount={plan.fee} token={plan.feeToken} read={balance} />
          <button
            disabled={
              tx.busy ||
              (plan.fee > 0n && (balance.balance === undefined || balance.balance < plan.fee))
            }
            onClick={finish}
          >
            {translate(plan.fee === 0n ? 'Register for free' : 'Pay and register')}
          </button>
        </>
      )}
      {canRetryCommit && (
        <>
          <p className="muted">{translate('Not submitted. You can retry.')}</p>
          <FeeBalance amount={plan.fee} token={plan.feeToken} read={balance} />
          <button
            disabled={
              tx.busy ||
              (plan.fee > 0n && (balance.balance === undefined || balance.balance < plan.fee))
            }
            onClick={retryCommit}
          >
            {translate('Retry commit')}
          </button>
        </>
      )}
      {check?.state === 'commit_missing' && plan.commitTx && (
        <>
          <p className="muted">
            {translate('Already submitted. Check the status before retrying.')}
          </p>
          <button disabled={tx.busy} onClick={() => receipt('commitTx')}>
            {translate('Check commit status')}
          </button>
        </>
      )}
      {plan.registerTx && check?.state !== 'registered' && (
        <>
          <p className="muted">
            {translate('Payment submitted. Check its status before retrying.')}
          </p>
          <CopyValue
            value={plan.registerTx}
            label={translate('Copy registration transaction hash')}
          />
          <button disabled={tx.busy} onClick={() => receipt('registerTx')}>
            {translate('Check registration transaction')}
          </button>
        </>
      )}
      {check?.state === 'registered' && (
        <>
          {/* The commit secret is useless once the commitment is consumed, so the plan can go. */}
          <button
            disabled={tx.busy}
            onClick={() =>
              void tx.exec('Complete registration', async () => {
                await abandon();
                go('manage', plan.label);
              })
            }
          >
            {translate('Set address')}
          </button>
        </>
      )}
      {((dead && !plan.registerTx && !plan.broadcastUnknown) ||
        (plan.broadcastUnknown && canDiscardUncertain(plan, check))) && (
        <button
          className="ghost"
          disabled={tx.busy}
          onClick={() => void tx.exec('Discard registration', discard)}
        >
          {translate('Remove record')}
        </button>
      )}
      {plan.broadcastUnknown && !plan[plan.broadcastUnknown] && (
        <div>
          <label>
            Transaction hash
            <input aria-label="Transaction hash" value={hashInput}
              onChange={(e) => { setHashInput(e.target.value); setHashError(undefined); }} />
          </label>
          <button disabled={tx.busy} onClick={() => attachHash(plan.broadcastUnknown!)}>
            Attach transaction hash
          </button>
          {hashError && <small role="alert" className="err">{hashError}</small>}
        </div>
      )}
      {uncertain && (
        <p role="alert" className="warn">
          {translate('Transaction status is unknown. Check your activity before paying again.')}
        </p>
      )}
      {error && <small className="err">{translate(error)}</small>}
      <TxLine tx={tx} />
    </Card>
  );
}
