import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../src/shared/messaging/client";
import type { Status } from "../src/shared/messaging/contracts";

describe("messaging client", () => {
  const sendMessage = vi.fn();

  beforeEach(() => {
    sendMessage.mockReset();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("unwraps successful responses and sends the requested command", async () => {
    const status: Status = { settings: null, runtime: null, degraded: null };
    sendMessage.mockResolvedValue({ ok: true, data: status });

    expect(await request({ type: "status" })).toBe(status);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "status" });
  });

  it("preserves the background error for display in the UI", async () => {
    sendMessage.mockResolvedValue({ ok: false, error: "预览已过期" });

    await expect(
      request({
        type: "execute-switch",
        id: "preview",
        confirmedProduction: true,
      }),
    ).rejects.toThrow("预览已过期");
  });

  it("reports an unavailable background when no response arrives", async () => {
    sendMessage.mockResolvedValue(undefined);

    await expect(request({ type: "status" })).rejects.toThrow("后台暂不可用");
  });

  it("propagates Chrome transport failures without replacing the error", async () => {
    const failure = new Error("The message port closed before a response.");
    sendMessage.mockRejectedValue(failure);

    await expect(request({ type: "status" })).rejects.toBe(failure);
  });
});
