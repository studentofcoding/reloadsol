import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/utils/shyft-api", () => ({
  shyftPost: vi.fn(),
  ShyftAPIError: class ShyftAPIError extends Error {
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.name = "ShyftAPIError";
      this.statusCode = statusCode;
    }
  },
}));

import { shyftPost } from "@/utils/shyft-api";
import {
  sendShyftTransactionDirect,
  sendShyftManyTransactionsDirect,
} from "@/utils/shyft-transaction";

describe("sendShyftTransactionDirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts encoded_transaction and network to Shyft send_txn", async () => {
    vi.mocked(shyftPost).mockResolvedValue({
      result: { signature: "test-sig" },
      latencyMs: 10,
    });

    const result = await sendShyftTransactionDirect("base64tx", "mainnet-beta");

    expect(shyftPost).toHaveBeenCalledWith(
      "/sol/v1/transaction/send_txn",
      {
        network: "mainnet-beta",
        encoded_transaction: "base64tx",
      },
    );
    expect(result).toEqual({ success: true, signature: "test-sig" });
  });
});

describe("sendShyftManyTransactionsDirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts encoded_transactions array to Shyft send_many_txns", async () => {
    vi.mocked(shyftPost).mockResolvedValue({
      result: [
        { id: 1, signature: "sig-1", status: "confirmed" },
        { id: 2, signature: "sig-2", status: "confirmed" },
      ],
      latencyMs: 12,
    });

    const result = await sendShyftManyTransactionsDirect(
      ["tx1", "tx2"],
      "mainnet-beta",
    );

    expect(shyftPost).toHaveBeenCalledWith(
      "/sol/v1/transaction/send_many_txns",
      {
        network: "mainnet-beta",
        encoded_transactions: ["tx1", "tx2"],
      },
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0].signature).toBe("sig-1");
  });
});
