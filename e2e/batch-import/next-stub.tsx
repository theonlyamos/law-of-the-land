import type { AnchorHTMLAttributes } from "react";

export default function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}

export function useRouter() {
  return { refresh() {}, push(href: string) { window.location.assign(href); } };
}
