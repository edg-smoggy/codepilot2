const METHOD_EVENT_NAMES = new Map([
  ["thread/started", "thread.started"],
  ["turn/started", "turn.started"],
  ["turn/completed", "turn.completed"],
  ["turn/diff/updated", "turn.diff.updated"],
  ["turn/plan/updated", "turn.plan.updated"],
  ["item/started", "item.started"],
  ["item/completed", "item.completed"],
  ["item/agentMessage/delta", "item.agentMessage.delta"],
  ["item/plan/delta", "item.plan.delta"],
  ["item/reasoning/summaryTextDelta", "item.reasoning.summaryTextDelta"],
  ["item/reasoning/summaryPartAdded", "item.reasoning.summaryPartAdded"],
  ["item/reasoning/textDelta", "item.reasoning.textDelta"],
  ["item/commandExecution/outputDelta", "item.commandExecution.outputDelta"],
  ["item/commandExecution/terminalInteraction", "item.commandExecution.terminalInteraction"],
  ["item/fileChange/outputDelta", "item.fileChange.outputDelta"],
  ["item/fileChange/patchUpdated", "item.fileChange.patchUpdated"],
  ["item/mcpToolCall/progress", "item.mcpToolCall.progress"],
  ["command/exec/outputDelta", "command.exec.outputDelta"],
  ["process/outputDelta", "process.outputDelta"],
  ["process/exited", "process.exited"],
  ["error", "runtime.error"],
  ["warning", "runtime.warning"],
  ["thread/status/changed", "thread.status.changed"],
]);

export function normalizeAppServerNotification(message) {
  const name = METHOD_EVENT_NAMES.get(message.method) ?? message.method.replaceAll("/", ".");
  const params = message.params ?? {};
  const eventParams = Object.hasOwn(message, "id")
    ? { ...params, serverRequestId: String(message.id) }
    : params;
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: name,
    ts: new Date().toISOString(),
    rawMethod: message.method,
    params: eventParams,
  };
}

export function finalMessageFromEvents(events) {
  const agentMessages = events
    .filter((event) => event.type === "item.completed")
    .map((event) => event.params?.item)
    .filter((item) => item?.type === "agentMessage" && typeof item.text === "string");
  const finalMessage = agentMessages
    .filter((item) => item.phase === "final_answer" || item.phase == null)
    .at(-1)?.text;
  if (finalMessage) {
    return finalMessage;
  }

  const buffers = new Map();
  for (const event of events) {
    if (event.type !== "item.agentMessage.delta") {
      continue;
    }
    const itemId = event.params?.itemId || "default";
    buffers.set(itemId, `${buffers.get(itemId) || ""}${event.params?.delta || ""}`);
  }
  return [...buffers.values()].filter((text) => text.trim()).at(-1) ?? null;
}
