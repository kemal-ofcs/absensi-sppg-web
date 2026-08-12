import { DashboardGuard } from "@/components/dashboard/dashboard-guard";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardGuard>{children}</DashboardGuard>;
}
