import { useEffect, type ReactNode } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Loader2, LogOut, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { fmtDateTime } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  badge?: number;
};

type Role = "gestor" | "organizador";

/** Redirects to login when signed out, and to the right area when the role doesn't match. */
export function useRequireRole(required: Role) {
  const { session, role, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!session) navigate({ to: "/auth", search: { mode: "login" } });
    else if (role && role !== required) navigate({ to: role === "gestor" ? "/gestor" : "/buscar" });
  }, [loading, session, role, required, navigate]);
  return !loading && !!session && role === required;
}

export function AppShell({
  role,
  nav,
  children,
}: {
  role: Role;
  nav: NavItem[];
  children: ReactNode;
}) {
  const ready = useRequireRole(role);
  const { signOut, profile } = useAuth();
  const navigate = useNavigate();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-0 z-30 bg-pitch-gradient text-pitch-foreground">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <Link to="/" className="font-display text-lg font-black tracking-tight">
            BATE<span className="text-accent">·</span>BOLA
            {role === "gestor" && (
              <span className="ml-2 align-middle text-xs font-semibold opacity-70">GESTOR</span>
            )}
          </Link>
          <div className="flex items-center gap-1">
            <NotificationBell />
            <Button
              variant="ghost"
              size="icon"
              className="text-pitch-foreground hover:bg-pitch-foreground/10 hover:text-pitch-foreground"
              aria-label="Sair"
              title={profile?.name ? `Sair (${profile.name})` : "Sair"}
              onClick={async () => {
                await signOut();
                navigate({ to: "/" });
              }}
            >
              <LogOut />
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-5">{children}</main>
      <BottomNav items={nav} />
    </div>
  );
}

function BottomNav({ items }: { items: NavItem[] }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 backdrop-blur">
      <div className="mx-auto flex max-w-3xl">
        {items.map((it) => (
          <Link
            key={it.to}
            to={it.to}
            activeOptions={{ exact: !!it.exact }}
            className="flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-medium text-muted-foreground"
            activeProps={{ className: "text-primary" }}
          >
            {({ isActive }: { isActive: boolean }) => (
              <>
                <span className="relative">
                  <it.icon className={cn("size-5", isActive && "text-primary")} />
                  {!!it.badge && (
                    <span className="absolute -right-2.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground">
                      {it.badge > 9 ? "9+" : it.badge}
                    </span>
                  )}
                </span>
                {it.label}
              </>
            )}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function NotificationBell() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const qc = useQueryClient();
  const router = useRouter();

  const { data: items = [] } = useQuery({
    queryKey: ["notifications", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) throw error;
      return data;
    },
  });
  const unread = items.filter((n) => !n.read).length;

  useEffect(() => {
    if (!userId) return;
    const ch = supabase
      .channel(`notif-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const msg = (payload.new as { message: string }).message;
          toast(msg);
          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted" &&
            document.hidden
          ) {
            new Notification("Bate-Bola", { body: msg });
          }
          // Any notification means bookings changed somewhere; refresh what's on screen.
          qc.invalidateQueries();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, qc]);

  const markAllRead = async () => {
    if (!unread || !userId) return;
    await supabase
      .from("notifications")
      .update({ read: true })
      .eq("user_id", userId)
      .eq("read", false);
    qc.invalidateQueries({ queryKey: ["notifications", userId] });
  };

  const canAskPermission =
    typeof Notification !== "undefined" && Notification.permission === "default";

  return (
    <Sheet onOpenChange={(open) => !open && markAllRead()}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative text-pitch-foreground hover:bg-pitch-foreground/10 hover:text-pitch-foreground"
          aria-label="Avisos"
        >
          <Bell />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex size-5 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Avisos</SheetTitle>
        </SheetHeader>
        {canAskPermission && (
          <Button
            variant="outline"
            size="sm"
            className="mx-4"
            onClick={() => Notification.requestPermission()}
          >
            Ativar avisos neste aparelho
          </Button>
        )}
        <ul className="divide-y px-4">
          {items.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground">Nenhum aviso ainda.</li>
          )}
          {items.map((n) => (
            <li key={n.id}>
              <button
                className="w-full py-3 text-left"
                onClick={() => n.link && router.history.push(n.link)}
              >
                <p className={cn("text-sm", !n.read && "font-semibold")}>{n.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(n.created_at)}</p>
              </button>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

export function StatusPill({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed bg-card px-6 py-10 text-center">
      <p className="font-display font-bold">{title}</p>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}
