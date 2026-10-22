import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, MessageCircle, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchProfiles, fmtCountdown, useNow, whatsappLink } from "@/lib/booking";
import { brl, errMsg, fmtDateTime } from "@/lib/time";
import { EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/gestor/solicitacoes")({
  head: () => ({ meta: [{ title: "Solicitações · Gestor" }] }),
  component: Requests,
});

function Requests() {
  const qc = useQueryClient();
  const now = useNow();

  const { data, isLoading } = useQuery({
    queryKey: ["requests"],
    refetchInterval: 30_000,
    queryFn: async () => {
      await supabase.rpc("expire_bookings");
      const { data, error } = await supabase
        .from("bookings")
        .select(
          "id, slot_id, organizer_id, created_at, expires_at, from_waitlist, slots(starts_at, courts(name, price_per_hour))",
        )
        .eq("status", "pendente")
        .order("created_at");
      if (error) throw error;
      const profiles = await fetchProfiles(data.map((b) => b.organizer_id));
      return data.map((b) => ({ ...b, organizer: profiles.get(b.organizer_id) }));
    },
  });

  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "confirm" | "reject" }) => {
      const { error } =
        action === "confirm"
          ? await supabase.rpc("confirm_booking", { _booking: id })
          : await supabase.rpc("reject_booking", { _booking: id });
      if (error) throw error;
      return action;
    },
    onSuccess: (action) => {
      toast.success(
        action === "confirm"
          ? "Pagamento confirmado. Organizador avisado."
          : "Solicitação recusada.",
      );
      qc.invalidateQueries();
    },
    onError: (e) => {
      toast.error(errMsg(e));
      qc.invalidateQueries({ queryKey: ["requests"] });
    },
  });

  return (
    <div>
      <h1 className="text-2xl font-black">Solicitações</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Confira o Pix no seu banco e confirme. Sem confirmação, o pedido expira sozinho e o horário
        volta para a agenda.
      </p>

      <div className="mt-5">
        {isLoading ? (
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
        ) : !data?.length ? (
          <EmptyState title="Nenhuma solicitação pendente">
            Avisamos aqui quando chegar um pedido novo.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {data.map((b) => {
              const left = new Date(b.expires_at).getTime() - now;
              const wa = b.organizer?.phone ? whatsappLink(b.organizer.phone) : null;
              return (
                <li key={b.id} className="rounded-xl bg-card p-4 shadow-card">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        to="/gestor/horario/$slotId"
                        params={{ slotId: b.slot_id }}
                        className="font-display text-lg font-bold"
                      >
                        {b.slots?.courts?.name} ·{" "}
                        <span className="capitalize">
                          {b.slots && fmtDateTime(b.slots.starts_at)}
                        </span>
                      </Link>
                      <p className="text-sm">
                        {b.organizer?.name || "Organizador"}
                        {b.organizer?.phone && (
                          <span className="text-muted-foreground"> · {b.organizer.phone}</span>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {brl(Number(b.slots?.courts?.price_per_hour ?? 0))} · expira em{" "}
                        <span className="font-semibold tabular-nums text-foreground">
                          {fmtCountdown(left)}
                        </span>
                        {b.from_waitlist && " · veio da fila"}
                      </p>
                    </div>
                    {wa && (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon"
                        aria-label="WhatsApp do organizador"
                      >
                        <a href={wa} target="_blank" rel="noreferrer">
                          <MessageCircle />
                        </a>
                      </Button>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: b.id, action: "reject" })}
                    >
                      <X /> Recusar
                    </Button>
                    <Button
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: b.id, action: "confirm" })}
                    >
                      <Check /> Pagamento recebido
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
