type Message = { role: "user" | "assistant"; content: string };

// Deliberately accept a small grammar of content-only requests. Unknown or mixed
// requests retain legal routing; a summary word alone must not bypass evidence.
const FILE = String.raw`(?:(?:this|that|these|those|the|my|all)(?:\s+(?:attached|uploaded))?\s+)?(?:files?|documents?|images?|photos?|pictures?|attachments?|contracts?|agreements?|letters?|notices?|pdfs?)`;
const TARGET = String.raw`(?:this|that|these|those|it|them|${FILE}|(?:the\s+)?(?:attached|uploaded)\s+(?:files?|documents?|images?|attachments?))`;
const FIELD = String.raw`(?:names?|dates?|amounts?|addresses|address|parties|headings?|text|clauses?|sections?|key points|main points)`;
const FIELDS = String.raw`${FIELD}(?:(?:,\s*|\s+and\s+)${FIELD})*`;
const CONTENT_QUESTIONS = [
  new RegExp(String.raw`^(?:summari[sz]e|read|transcribe|describe)\s+${TARGET}(?:\s+in\s+(?:plain english|simple terms|bullet points))?$`, "iu"),
  new RegExp(String.raw`^(?:give me\s+)?(?:a\s+)?(?:summary|overview|transcript)\s+of\s+${TARGET}$`, "iu"),
  new RegExp(String.raw`^what\s+(?:does|do)\s+${TARGET}\s+(?:say|contain|show)$`, "iu"),
  new RegExp(String.raw`^(?:extract|list|show me|read)\s+(?:the\s+)?${FIELDS}\s+(?:from|in)\s+${TARGET}$`, "iu"),
  new RegExp(String.raw`^what\s+${FIELDS}\s+(?:are|is)\s+(?:mentioned|listed|shown)\s+in\s+${TARGET}$`, "iu"),
];
const SUMMARY_FOLLOW_UP = /^(?:make (?:it|that|the summary) (?:shorter|more concise)|(?:summari[sz]e|shorten) (?:that|it|the summary))$/iu;

function normalized(query: string): string {
  return query.trim().replace(/\s+/gu, " ").replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/iu, "").replace(/[.!?]+$/u, "").trim();
}

export function isDocumentQuestion(query: string, history: readonly Message[] = []): boolean {
  const question = normalized(query);
  if (SUMMARY_FOLLOW_UP.test(question)) {
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message.role !== "user") continue;
      const previous = normalized(message.content);
      if (SUMMARY_FOLLOW_UP.test(previous)) continue;
      return CONTENT_QUESTIONS.some((pattern) => pattern.test(previous));
    }
    return false;
  }
  return CONTENT_QUESTIONS.some((pattern) => pattern.test(question));
}
