import type {
  Message,
  MessageOf,
  ResponseEnvelope,
  ResponseMap,
} from "./contracts";

export async function request<T extends Message["type"]>(
  message: MessageOf<T> & { type: T },
): Promise<ResponseMap[T]> {
  const response = await chrome.runtime.sendMessage<
    typeof message,
    ResponseEnvelope<ResponseMap[T]> | undefined
  >(message);
  if (!response?.ok) throw new Error(response?.error ?? "后台暂不可用");
  return response.data;
}
