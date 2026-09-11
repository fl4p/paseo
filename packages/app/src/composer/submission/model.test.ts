import { describe, expect, it } from "vitest";
import {
  acceptMessageSubmission,
  beginMessageSubmission,
  getActiveMessageSubmissions,
  getSendingClientMessageIds,
  observeMessageSubmissionCanonical,
  rejectMessageSubmission,
} from "./model";

describe("message submission transactions", () => {
  it("tracks every in-flight submission independently", () => {
    const first = beginMessageSubmission([], { clientMessageId: "client-1" });
    const both = beginMessageSubmission(first, { clientMessageId: "client-2" });

    expect(getActiveMessageSubmissions(both).map((item) => item.clientMessageId)).toEqual([
      "client-1",
      "client-2",
    ]);
    expect(getSendingClientMessageIds(both)).toEqual(["client-1", "client-2"]);
  });

  it("settles only the accepted transaction on RPC acceptance", () => {
    const both = beginMessageSubmission(
      beginMessageSubmission([], { clientMessageId: "client-1" }),
      { clientMessageId: "client-2" },
    );
    const acknowledged = observeMessageSubmissionCanonical(both, ["client-1"]);

    expect(acceptMessageSubmission(acknowledged, "client-1")).toEqual([
      {
        clientMessageId: "client-2",
        providerAcknowledged: false,
        rpcSettled: false,
      },
    ]);
  });

  it("keeps activity until an accepted RPC's canonical row is observed", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });
    const accepted = acceptMessageSubmission(sending, "client-1");

    expect(accepted).toEqual([
      {
        clientMessageId: "client-1",
        providerAcknowledged: false,
        rpcSettled: true,
      },
    ]);
    expect(getActiveMessageSubmissions(accepted).map((item) => item.clientMessageId)).toEqual([
      "client-1",
    ]);
    expect(observeMessageSubmissionCanonical(accepted, ["client-1"])).toEqual([]);
  });

  it("records provider acknowledgement without settling another transaction", () => {
    const both = beginMessageSubmission(
      beginMessageSubmission([], { clientMessageId: "client-1" }),
      { clientMessageId: "client-2" },
    );
    const observed = observeMessageSubmissionCanonical(both, ["client-1"]);

    expect(observed).toEqual([
      {
        clientMessageId: "client-1",
        providerAcknowledged: true,
        rpcSettled: false,
      },
      {
        clientMessageId: "client-2",
        providerAcknowledged: false,
        rpcSettled: false,
      },
    ]);
    expect(getSendingClientMessageIds(observed)).toEqual(["client-2"]);
  });

  it("does not roll back a provider-acknowledged prompt on a later transport error", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });
    const observed = observeMessageSubmissionCanonical(sending, ["client-1"]);

    expect(rejectMessageSubmission(observed, "client-1")).toEqual({
      outcome: "accepted",
      submissions: [],
    });
  });

  it("rejects an unacknowledged transaction", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });

    expect(rejectMessageSubmission(sending, "client-1")).toEqual({
      outcome: "rejected",
      submissions: [],
    });
  });

  // The daemon holds a prompt behind a compaction, so the send RPC settles at once and no
  // canonical prompt row ever arrives if the hold is dropped. This is why a dropped hold needs
  // `prompt_discarded` (which routes to `rejectMessageSubmission`) and not just a timeline row.
  it("keeps a settled-but-unacknowledged submission pending until it is rejected", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });
    const settled = acceptMessageSubmission(sending, "client-1");

    expect(getActiveMessageSubmissions(settled).map((item) => item.clientMessageId)).toEqual([
      "client-1",
    ]);
    expect(observeMessageSubmissionCanonical(settled, [])).toBe(settled);
    expect(rejectMessageSubmission(settled, "client-1")).toEqual({
      outcome: "rejected",
      submissions: [],
    });
  });

  it("does not create duplicate transaction identity", () => {
    const sending = beginMessageSubmission([], { clientMessageId: "client-1" });

    expect(() => beginMessageSubmission(sending, { clientMessageId: "client-1" })).toThrow(
      "Message submission already exists",
    );
  });
});
