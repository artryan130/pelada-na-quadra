import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Inbox, Settings } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/gestor")({
  ssr: false,
  component: GestorLayout,
});

function GestorLayout() {
  const { role } = useAuth();
  const { data: pending = 0 } = useQuery({
    queryKey: ["pending-count"],
    enabled: role === "gestor",
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("status", "pendente")
        .gt("expires_at", new Date().toISOString());
      if (error) throw error;
      return count ?? 0;
    },
  });

  return (
    <AppShell
      role="gestor"
      nav={[
        { to: "/gestor", label: "Agenda", icon: CalendarRange, exact: true },
        { to: "/gestor/solicitacoes", label: "Solicitações", icon: Inbox, badge: pending },
        { to: "/gestor/configuracao", label: "Configuração", icon: Settings },
      ]}
    >
      <Outlet />
    </AppShell>
  );
}
