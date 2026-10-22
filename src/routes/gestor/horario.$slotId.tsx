import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Loader2, Lock, MessageCircle, Unlock, X } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  STATUS_CLASS,
  STATUS_LABEL,
  fetchProfiles,
  whatsappLink,
  type Profile,
} from "@/lib/booking";
import { brl, errMsg, fmtDateLong, fmtDateTime, fmtTime } from "@/lib/time";
import { EmptyState, StatusPill } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/gestor/horario/$slotId")({
  head: () => ({ meta: [{ title: "Detalhe do horário · Gestor" }] }),
  component: SlotDetail,
});

function SlotDetail() {
  const { slotId } = Route.useParams();
  const qc = useQueryClient();
  const [note, setNote] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["slot-detail", slotId],
    queryFn: async () => {
      await supabase.rpc("expire_bookings");
      const [slot, bookings, waitlist] = await Promise.all([
        supabase
          .from("slots")
          .select("id, starts_at, published, blocked, block_note, courts(name, price_per_hour)")
          .eq("id", slotId)
          .maybeSingle(),
        supabase
          .from("bookings")
          .select("id, organizer_id, status, created_at, expires_at, from_waitlist")
          .eq("slot_id", slotId)
          .order("created_at", { ascending: false }),
        supabase
          .from("waitlist")
          .select("id, organizer_id, created_at, notified_at")
          .eq("slot_id", slotId)
          .order("created_at"),
      ]);
      for (const r of [slot, bookings, waitlist]) if (r.error) throw r.error;
      const profiles = await fetchProfiles([
        ...(bookings.data ?? []).map((b) => b.organizer_id),
        ...(waitlist.data ?? []).map((w) => w.organizer_id),
      ]);
      return {
        slot: slot.data,
        bookings: bookings.data ?? [],
        waitlist: waitlist.data ?? [],
        profiles,
      };
    },
  });

  const rpc = useMutation({
    mutationFn: async (
      op:
        { kind: "confirm" | "reject" | "cancel"; id: string } | { kind: "block"; blocked: boolean },
    ) => {
      const res =
        op.kind === "block"
          ? await supabase.rpc("set_slot_blocked", {
              _slot: slotId,
              _blocked: op.blocked,
              ...(note ? { _note: note } : {}),
            })
          : op.kind === "confirm"
            ? await supabase.rpc("confirm_booking", { _booking: op.id })
            : op.kind === "reject"
              ? await supabase.rpc("reject_booking", { _booking: op.id })
              : await supabase.rpc("cancel_booking", { _booking: op.id });
      if (res.error) throw res.error;
    },
    onSuccess: () => {
      setNote("");
      qc.invalidateQueries();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading) return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  if (!data?.slot) return <EmptyState title="Horário não encontrado" />;
  const { slot, bookings, waitlist, profiles } = data;
  const active = bookings.find((b) => b.status === "pendente" || b.status === "confirmada");
  const past = new Date(slot.starts_at).getTime() <= Date.now();
  const org = active ? profiles.get(active.organizer_id) : undefined;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/gestor" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <ArrowLeft className="size-4" /> Agenda da semana
        </Link>
        <h1 className="mt-3 text-2xl font-black">
          {slot.courts?.name} · {fmtTime(slot.starts_at)}
        </h1>
        <p className="text-sm capitalize text-muted-foreground">
          {fmtDateLong(slot.starts_at)} · {brl(Number(slot.courts?.price_per_hour ?? 0))}
          {!slot.published && " · não publicado"}
        </p>
      </div>

      <section className="rounded-2xl bg-card p-5 shadow-card">
        {active ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold">Reserva pelo app</h2>
              <StatusPill className={STATUS_CLASS[active.status]}>
                {STATUS_LABEL[active.status]}
              </StatusPill>
            </div>
            <PersonRow p={org} />
            <p className="mt-1 text-xs text-muted-foreground">
              Pedido em {fmtDateTime(active.created_at)}
              {active.status === "pendente" && ` · expira ${fmtDateTime(active.expires_at)}`}
              {active.from_waitlist && " · veio da fila"}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {active.status === "pendente" && (
                <>
                  <Button
                    disabled={rpc.isPending}
                    onClick={() => rpc.mutate({ kind: "confirm", id: active.id })}
                  >
                    <Check /> Pagamento recebido
                  </Button>
                  <Button
                    variant="outline"
                    disabled={rpc.isPending}
                    onClick={() => rpc.mutate({ kind: "reject", id: active.id })}
                  >
                    <X /> Recusar
                  </Button>
                </>
              )}
              {active.status === "confirmada" && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" className="text-destructive">
                      Cancelar reserva
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Cancelar a reserva de {org?.name || "organizador"}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        O organizador é avisado, o horário volta a ficar livre e a fila de espera
                        recebe um aviso. Reembolso fica por sua conta, fora do app.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Voltar</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => rpc.mutate({ kind: "cancel", id: active.id })}
                      >
                        Cancelar reserva
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </>
        ) : slot.blocked ? (
          <>
            <h2 className="font-bold">Ocupado por fora do app</h2>
            {slot.block_note && (
              <p className="mt-1 text-sm text-muted-foreground">{slot.block_note}</p>
            )}
            {!past && (
              <Button
                className="mt-4"
                variant="outline"
                disabled={rpc.isPending}
                onClick={() => rpc.mutate({ kind: "block", blocked: false })}
              >
                <Unlock /> Liberar horário{waitlist.length > 0 && " e avisar a fila"}
              </Button>
            )}
          </>
        ) : (
          <>
            <h2 className="font-bold">{past ? "Horário passou sem reserva" : "Livre"}</h2>
            {!past && (
              <div className="mt-3 flex gap-2">
                <Input
                  placeholder="Anotação (ex.: Pelada do João, mensalista)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  disabled={rpc.isPending}
                  onClick={() => rpc.mutate({ kind: "block", blocked: true })}
                >
                  <Lock /> Marcar ocupado
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <section>
        <h2 className="text-lg font-bold">Fila de espera ({waitlist.length})</h2>
        {waitlist.length ? (
          <ol className="mt-3 divide-y rounded-xl bg-card shadow-card">
            {waitlist.map((w, i) => (
              <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                <span className="font-display text-sm font-bold text-muted-foreground">
                  {i + 1}º
                </span>
                <div className="flex-1">
                  <PersonRow p={profiles.get(w.organizer_id)} compact />
                  <p className="text-xs text-muted-foreground">
                    Entrou {fmtDateTime(w.created_at)}
                    {w.notified_at && ` · avisado ${fmtDateTime(w.notified_at)}`}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Ninguém na fila desse horário.</p>
        )}
      </section>

      {bookings.length > (active ? 1 : 0) && (
        <section>
          <h2 className="text-lg font-bold">Histórico</h2>
          <ul className="mt-3 divide-y rounded-xl bg-card shadow-card">
            {bookings
              .filter((b) => b !== active)
              .map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span>
                    {profiles.get(b.organizer_id)?.name || "Organizador"}
                    <span className="text-muted-foreground"> · {fmtDateTime(b.created_at)}</span>
                  </span>
                  <StatusPill className={STATUS_CLASS[b.status]}>
                    {STATUS_LABEL[b.status]}
                  </StatusPill>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PersonRow({ p, compact }: { p: Profile | undefined; compact?: boolean }) {
  const wa = p?.phone ? whatsappLink(p.phone) : null;
  return (
    <div
      className={
        compact ? "flex items-center gap-2" : "mt-2 flex items-center justify-between gap-2"
      }
    >
      <div>
        <p className="font-semibold">{p?.name || "Organizador"}</p>
        {!compact && p?.phone && <p className="text-sm text-muted-foreground">{p.phone}</p>}
      </div>
      {wa && (
        <a
          href={wa}
          target="_blank"
          rel="noreferrer"
          className="text-success"
          aria-label="WhatsApp"
        >
          <MessageCircle className="size-5" />
        </a>
      )}
    </div>
  );
}
