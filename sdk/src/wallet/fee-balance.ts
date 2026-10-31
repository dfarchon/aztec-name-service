import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { AnsContext } from "./context.js";
import type { FeeQuote } from "../transactions/fees.js";
import { readFeeTokenMetadata } from "../client/fee-token.js";

/** Private balance is obtained only through the selected account's wallet; never through public RPC storage. */
export async function getPrivateFeeBalance(ctx: AnsContext, token: AztecAddress): Promise<bigint> {
  if (token.isZero()) return 0n;
  return ctx.queue.run(async () => {
    await ctx.registerFeeToken(token);
    const { TokenContract } = await import("@aztec-labs/noir-contracts.js/Token");
    const contract = await TokenContract.at(token, ctx.wallet);
    const balance = await contract.methods.balance_of_private(ctx.account).simulate({ from: ctx.account });
    return BigInt(balance.result as bigint);
  });
}

/** A host can show the exact missing amount and token address before asking for a commit or a payment. */
export async function getFeeReadiness(ctx: AnsContext, quote: FeeQuote) {
  if (quote.fee === 0n) return { ready: true, balance: 0n, shortfall: 0n, token: undefined };
  const [balance, token] = await Promise.all([
    getPrivateFeeBalance(ctx, quote.feeToken),
    readFeeTokenMetadata(ctx.reader, quote.feeToken, quote.snapshot),
  ]);
  const shortfall = quote.fee > balance ? quote.fee - balance : 0n;
  return { ready: shortfall === 0n, balance, shortfall, token };
}
