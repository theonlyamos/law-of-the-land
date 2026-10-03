import ChatRouteWorkspace from "@/components/chat/chat-route-workspace";
import { AccountProviders } from "@/components/providers/account-providers";
import { EditorialTheme } from "@/components/chat/editorial-theme";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <AccountProviders>
      <EditorialTheme>
        <ChatRouteWorkspace />
        {children}
      </EditorialTheme>
    </AccountProviders>
  );
}
