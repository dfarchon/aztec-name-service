import { test } from "node:test";
import assert from "node:assert/strict";
import { FogError, toFogError } from "../src/core/errors.js";
import { RegistryReader } from "../src/client/reader.js";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { AztecNode } from "@aztec-labs/aztec.js/node";

test("reader connection exposes browser transport failures as network errors", async () => {
  for (const failure of [new TypeError("Failed to fetch"), new Error("RPC request timed out")]) {
    const node = { getNodeInfo: async () => { throw failure; } } as unknown as AztecNode;
    await assert.rejects(RegistryReader.connect(node, AztecAddress.fromBigIntUnsafe(1n)),
      (error: FogError) => error.code === "network" && error.cause === failure);
  }
});

test("browser fetch, RPC timeout and nested transport causes are retryable network failures", () => {
  for (const error of [
    new TypeError("Failed to fetch"), new TypeError("Load failed"),
    new Error("RPC request timed out"), new Error("fetch failed"),
    new DOMException("The operation timed out", "TimeoutError"),
    new Error("Request failed", { cause: Object.assign(new Error("connection failed"), { code: "EAI_AGAIN" }) }),
    new AggregateError([Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" })], "Transport failed"),
  ]) {
    const result = toFogError(error);
    assert.equal(result.code, "network", error.message);
    assert.equal(result.cause, error);
  }
});

test("transport classification preserves contract codes, wallet rejection and transaction tracking", () => {
  assert.equal(toFogError(new Error("revision mismatch: fetch failed")).code, "conflict");
  assert.equal(toFogError(new Error("User rejected: network request failed")).code, "wallet_rejected");
  const sent = new FogError("unknown_tx_state", "RPC request timed out", undefined, "0x123");
  assert.equal(toFogError(sent), sent);
  assert.equal(toFogError(new Error("assertion failed")).code, "reverted");
  assert.equal(toFogError(new DOMException("User cancelled", "AbortError")).code, "reverted");
  const cyclic = { cause: undefined as unknown, message: "Unknown" };
  cyclic.cause = cyclic;
  assert.equal(toFogError(cyclic).code, "reverted");
});
