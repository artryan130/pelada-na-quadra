import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { STATUS_CLASS, STATUS_LABEL } from "@/lib/booking";
import { errMsg, fmtDateTime } from "@/lib/time";
import { EmptyState, StatusPill } from "@/components/app-shell";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_org/minhas-reservas")({
  head: () => ({ meta: [{ title: "Minhas reservas · Bate-Bola" }] }),
  component: MyBookings,
});

function MyBookings() {
  const { session } = useAuth();
  const uid = session!.user.id;
  const qc = useQueryClient();

  const { data: bookings, isLoading } = useQuery({
    queryKey: ["my-bookings", uid],
    queryFn: async () => {
      await supabase.rpc("expire_bookings");
      const { data, error } = await supabase
        .from("bookings")
        .select("id, status, created_at, slots(starts_at, courts(name))")
        .eq("organizer_id", uid)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  const { data: queues = [] } = useQuery({
    queryKey: ["my-waitlist", uid],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("waitlist")
        .select("id, slot_id, notified_at, slots(starts_at, courts(name))")
        .eq("organizer_id", uid)
        .gte("slots.starts_at", new Date().toISOString());
      if (error) throw error;
      return data.filter((q) => q.slots);
    },
  });

  const leave = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("waitlist").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Você saiu da fila.");
      qc.invalidateQueries({ queryKey: ["my-waitlist"] });
      qc.invalidateQueries({ queryKey: ["agenda"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading) return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;

  const now = Date.now();
  const all = (bookings ?? []).filter((b) => b.slots);
  const upcoming = all
    .filter(
      (b) =>
        (b.status === "pendente" || b.status === "confirmada") &&
        new Date(b.slots!.starts_at).getTime() > now,
    )
    .sort((a, b) => a.slots!.starts_at.localeCompare(b.slots!.starts_at));
  const history = all.filter((b) => !upcoming.includes(b));

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-black">Minhas reservas</h1>
        <div className="mt-4">
          {upcoming.length ? (
            <BookingList items={upcoming} />
          ) : (
            <EmptyState title="Nenhuma reserva ativa">
              <Link to="/agenda" className="font-semibold text-primary">
                Ver horários livres
              </Link>
            </EmptyState>
          )}
        </div>
      </section>

      {queues.length > 0 && (
        <section>
          <h2 className="text-lg font-bold">Filas de espera</h2>
          <ul className="mt-3 divide-y rounded-xl bg-card shadow-card">
            {queues.map((q) => (
              <li key={q.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="font-semibold">{q.slots!.courts?.name}</p>
                  <p className="text-sm capitalize text-muted-foreground">
                    {fmtDateTime(q.slots!.starts_at)}
                  </p>
                  {q.notified_at && (
                    <p className="mt-0.5 text-xs font-semibold text-success">
                      Vagou! Corra para solicitar.
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={leave.isPending}
                  onClick={() => leave.mutate(q.id)}
                >
                  <BellOff /> Sair
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.length > 0 && (
        <section>
          <h2 className="text-lg font-bold">Histórico</h2>
          <div className="mt-3">
            <BookingList items={history} />
          </div>
        </section>
      )}
    </div>
  );
}

type Item = {
  id: string;
  status: keyof typeof STATUS_LABEL;
  slots: { starts_at: string; courts: { name: string } | null } | null;
};

function BookingList({ items }: { items: Item[] }) {
  return (
    <ul className="divide-y rounded-xl bg-card shadow-card">
      {items.map((b) => (
        <li key={b.id}>
          <Link
            to="/reserva/$bookingId"
            params={{ bookingId: b.id }}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div>
              <p className="font-semibold">{b.slots!.courts?.name}</p>
              <p className="text-sm capitalize text-muted-foreground">
                {fmtDateTime(b.slots!.starts_at)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill className={STATUS_CLASS[b.status]}>{STATUS_LABEL[b.status]}</StatusPill>
              <ChevronRight className="size-4 text-muted-foreground" />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
