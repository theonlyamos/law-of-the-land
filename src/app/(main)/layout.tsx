import { MainChrome } from "@/components/layout/main-chrome";
import { AccountProviders } from "@/components/providers/account-providers";

export default function MainLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AccountProviders><MainChrome>{children}</MainChrome></AccountProviders>;
}
