import { MainChrome } from "@/components/layout/main-chrome";

export default function MainLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <MainChrome>{children}</MainChrome>;
}
