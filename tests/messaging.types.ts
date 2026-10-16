import { request } from "../src/shared/messaging/client";
import type {
  CommandResult,
  Message,
  ResponseMap,
  Status,
  SwitchPreview,
} from "../src/shared/messaging/contracts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

export type EveryMessageHasAResponse = Assert<
  Equal<Message["type"], keyof ResponseMap>
>;

// Compiler-only assertions: this function is never called by the test runner.
export function assertRequestContract() {
  const status = request({ type: "status" });
  const preview = request({
    type: "preview-switch",
    tabId: 1,
    targetId: "uat",
    home: false,
  });
  const command = request({ type: "toggle", enabled: true });
  const inferred: [
    Assert<Equal<typeof status, Promise<Status>>>,
    Assert<Equal<typeof preview, Promise<SwitchPreview>>>,
    Assert<Equal<typeof command, Promise<CommandResult>>>,
  ] = [true, true, true];
  void [status, preview, command, inferred];

  // @ts-expect-error An unknown command is not part of the messaging protocol.
  request({ type: "unknown" });
  // @ts-expect-error Commands must provide their required fields.
  request({ type: "toggle" });
  // @ts-expect-error Field types are defined by the selected command.
  request({ type: "toggle", enabled: "yes" });
  // @ts-expect-error Extra fields are rejected for fresh command objects.
  request({ type: "status", enabled: true });
  // @ts-expect-error A field belonging to another command cannot be substituted.
  request({ type: "remove-target", tabId: 1 });
  // @ts-expect-error Callers cannot choose an unrelated response type.
  request<SwitchPreview>({ type: "status" });
}
