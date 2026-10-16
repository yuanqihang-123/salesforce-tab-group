import { z } from "zod/v3";
import {
  messageSchema,
  type Message,
  type MessageHandlers,
  type ResponseEnvelope,
  type ResponseFor,
} from "../shared/messaging/contracts";

interface MessageRuntime {
  id: string;
  getURL: typeof chrome.runtime.getURL;
  onMessage: Pick<typeof chrome.runtime.onMessage, "addListener">;
}

function dispatch<M extends Message>(
  handlers: MessageHandlers,
  message: M,
): Promise<ResponseFor<M>> {
  // The validated discriminant selects the matching request/response pair.
  // TypeScript loses that correlation when indexing a map with a union key.
  const handler = handlers[message.type] as (
    message: M,
  ) => Promise<ResponseFor<M>>;
  return handler(message);
}

export function registerMessageRouter(
  handlers: MessageHandlers,
  runtime: MessageRuntime = chrome.runtime,
) {
  const allowedPages = [
    runtime.getURL("popup/index.html"),
    runtime.getURL("options/index.html"),
  ];
  runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    if (
      sender.id !== runtime.id ||
      !sender.url ||
      !allowedPages.includes(sender.url)
    )
      return false;
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) {
      respond({ ok: false, error: "请求格式无效" });
      return false;
    }
    const reply = (response: ResponseEnvelope<ResponseFor<Message>>) =>
      respond(response);
    const fail = (error: unknown) =>
      reply({
        ok: false,
        error:
          error instanceof z.ZodError
            ? "配置未通过校验，请检查 tenant、origin 和字段格式。"
            : error instanceof Error
              ? error.message
              : "操作失败",
      });
    try {
      // Enqueue synchronously so later browser events cannot overtake this request.
      void dispatch(handlers, parsed.data).then(
        (data) => reply({ ok: true, data }),
        fail,
      );
    } catch (error) {
      fail(error);
    }
    return true;
  });
}
