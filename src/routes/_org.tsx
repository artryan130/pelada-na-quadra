import { createFileRoute, Outlet } from "@tanstack/react-router";
import { CalendarDays, Ticket } from "lucide-react";
import { AppShell, type NavItem } from "@/components/app-shell";

const NAV: NavItem[] = [
  { to: "/agenda", label: "Agenda", icon: CalendarDays },
  { to: "/minhas-reservas", label: "Minhas reservas", icon: Ticket },
];

export const Route = createFileRoute("/_org")({
  ssr: false,
  component: () => (
    <AppShell role="organizador" nav={NAV}>
      <Outlet />
    </AppShell>
  ),
});
