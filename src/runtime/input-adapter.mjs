export function normalizeTaskInput(request) {
  if (Array.isArray(request.input)) {
    return normalizeOpenAiInput(request.input);
  }

  if (typeof request.prompt === "string" && request.prompt.trim()) {
    return [
      {
        type: "text",
        text: request.prompt,
        textElements: [],
      },
    ];
  }

  throw new Error("Task request must include either prompt or input");
}

function normalizeOpenAiInput(input) {
  const normalized = [];
  for (const item of input) {
    if (item?.role && item.role !== "user") {
      continue;
    }

    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "input_text") {
        normalized.push({
          type: "text",
          text: String(part.text ?? ""),
          textElements: [],
        });
      } else if (part?.type === "input_image") {
        if (!part.image_url) {
          throw new Error("input_image requires image_url");
        }
        normalized.push({
          type: "image",
          url: String(part.image_url),
        });
      } else {
        throw new Error(`Unsupported input content type: ${part?.type ?? "unknown"}`);
      }
    }
  }

  if (normalized.length === 0) {
    throw new Error("OpenAI-style input did not contain user content");
  }

  return normalized;
}
