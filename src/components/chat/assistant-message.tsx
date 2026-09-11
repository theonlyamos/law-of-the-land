import ReactMarkdown from "react-markdown";
import type { ReactNode } from "react";

export function assistantMarkdown(content: string): string {
  if (!content.includes("\\n\\n") && !content.includes("\\r\\n\\r\\n")) return content;
  return content.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
}
const components = {
  ol: ({ children, start }: { children?: ReactNode; start?: number }) => <ol start={start} style={{ listStyleType: "decimal" }}>{children}</ol>,
  ul: ({ children }: { children?: ReactNode }) => <ul style={{ listStyleType: "disc" }}>{children}</ul>,
};
export function AssistantMessage({ content }: { content: string }) {
  return <ReactMarkdown components={components}>{assistantMarkdown(content)}</ReactMarkdown>;
}
