import ChatRouteWorkspace from "@/components/chat/chat-route-workspace";
import { AccountProviders } from "@/components/providers/account-providers";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <AccountProviders>
      <ChatRouteWorkspace />
      {children}
    </AccountProviders>
  );
}
