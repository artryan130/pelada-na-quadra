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
import { brl, dayOfBRT, errMsg, fmtDateLong, fmtDateTime, fmtTime } from "@/lib/time";
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

type Params = { inicio?: string };

// One hour of one court, as shown in the week grid. Bookings may cover only part of it.
export const Route = createFileRoute("/gestor/horario/$courtId")({
  validateSearch: (s: Record<string, unknown>): Params => {
    const inicio = s["inicio"];
    return typeof inicio === "string" && !Number.isNaN(Date.parse(inicio)) ? { inicio } : {};
  },
  head: () => ({ meta: [{ title: "Detalhe do horário · Gestor" }] }),
  component: HourDetail,
});

const HORA = 3600_000;
const minutos = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function HourDetail() {
  const { courtId } = Route.useParams();
  const { inicio } = Route.useSearch();
  const fim = inicio ? new Date(new Date(inicio).getTime() + HORA).toISOString() : "";
  const qc = useQueryClient();
  const [note, setNote] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["hour-detail", courtId, inicio],
    enabled: !!inicio,
    queryFn: async () => {
      await supabase.rpc("expire_bookings");
      const [court, bookings, bloqueios, fila, mensalistas] = await Promise.all([
        supabase.from("courts").select("id, name").eq("id", courtId).maybeSingle(),
        supabase
          .from("bookings")
          .select(
            "id, organizer_id, status, created_at, expires_at, from_waitlist, preco, starts_at, ends_at",
          )
          .eq("court_id", courtId)
          .lt("starts_at", fim)
          .gt("ends_at", inicio!)
          .order("created_at", { ascending: false }),
        supabase
          .from("bloqueios")
          .select("id, starts_at, ends_at, nota")
          .eq("court_id", courtId)
          .lt("starts_at", fim)
          .gt("ends_at", inicio!),
        supabase
          .from("waitlist")
          .select("id, organizer_id, created_at, notified_at, starts_at, ends_at")
          .eq("court_id", courtId)
          .lt("starts_at", fim)
          .gt("ends_at", inicio!)
          .order("created_at"),
        supabase.from("mensalistas").select("*").eq("court_id", courtId),
      ]);
      for (const r of [court, bookings, bloqueios, fila, mensalistas]) if (r.error) throw r.error;
      const profiles = await fetchProfiles([
        ...(bookings.data ?? []).map((b) => b.organizer_id),
        ...(fila.data ?? []).map((w) => w.organizer_id),
      ]);
      // Same rule as the database: weekday, time overlap and validity window.
      const dia = dayOfBRT(inicio!);
      const dow = new Date(dia + "T12:00:00Z").getUTCDay();
      const h = new Date(new Date(inicio!).getTime() - 3 * HORA).getUTCHours() * 60;
      const mensalista = (mensalistas.data ?? []).find(
        (m) =>
          m.dia_semana === dow &&
          minutos(m.inicio) < h + 60 &&
          minutos(m.fim) > h &&
          m.valido_de <= dia &&
          (!m.valido_ate || m.valido_ate >= dia),
      );
      return {
        court: court.data,
        bookings: bookings.data ?? [],
        bloqueios: bloqueios.data ?? [],
        fila: fila.data ?? [],
        mensalista,
        profiles,
      };
    },
  });

  const rpc = useMutation({
    mutationFn: async (
      op:
        | { kind: "confirm" | "reject" | "cancel"; id: string }
        | { kind: "block"; bloquear: boolean },
    ) => {
      const res =
        op.kind === "block"
          ? await supabase.rpc("set_bloqueio", {
              _court: courtId,
              _inicio: inicio!,
              _fim: fim,
              _bloquear: op.bloquear,
              ...(note ? { _nota: note } : {}),
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

  if (!inicio) return <EmptyState title="Horário não informado" />;
  if (isLoading) return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  if (!data?.court) return <EmptyState title="Quadra não encontrada" />;
  const { court, bookings, bloqueios, fila, mensalista, profiles } = data;
  const ativas = bookings.filter(
    (b) =>
      b.status === "confirmada" ||
      (b.status === "pendente" && new Date(b.expires_at).getTime() > Date.now()),
  );
  const historico = bookings.filter((b) => !ativas.includes(b));
  const past = new Date(fim).getTime() <= Date.now();

  return (
    <div className="space-y-6">
      <div>
        <Link to="/gestor" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
          <ArrowLeft className="size-4" /> Agenda da semana
        </Link>
        <h1 className="mt-3 text-2xl font-black">
          {court.name} · {fmtTime(inicio)}–{fmtTime(fim)}
        </h1>
        <p className="text-sm capitalize text-muted-foreground">{fmtDateLong(inicio)}</p>
      </div>

      {ativas.map((b) => {
        const org = profiles.get(b.organizer_id);
        return (
          <section key={b.id} className="rounded-2xl bg-card p-5 shadow-card">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold">
                Reserva pelo app · {fmtTime(b.starts_at)}–{fmtTime(b.ends_at)}
              </h2>
              <StatusPill className={STATUS_CLASS[b.status]}>{STATUS_LABEL[b.status]}</StatusPill>
            </div>
            <PersonRow p={org} />
            <p className="mt-1 text-xs text-muted-foreground">
              {b.preco !== null && `${brl(Number(b.preco))} · `}
              Pedido em {fmtDateTime(b.created_at)}
              {b.status === "pendente" && ` · expira ${fmtDateTime(b.expires_at)}`}
              {b.from_waitlist && " · veio da fila"}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {b.status === "pendente" && (
                <>
                  <Button
                    disabled={rpc.isPending}
                    onClick={() => rpc.mutate({ kind: "confirm", id: b.id })}
                  >
                    <Check /> Pagamento recebido
                  </Button>
                  <Button
                    variant="outline"
                    disabled={rpc.isPending}
                    onClick={() => rpc.mutate({ kind: "reject", id: b.id })}
                  >
                    <X /> Recusar
                  </Button>
                </>
              )}
              {b.status === "confirmada" && (
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
                      <AlertDialogAction onClick={() => rpc.mutate({ kind: "cancel", id: b.id })}>
                        Cancelar reserva
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </section>
        );
      })}

      {mensalista && (
        <section className="rounded-2xl bg-card p-5 shadow-card">
          <h2 className="font-bold">
            Mensalista · {mensalista.inicio.slice(0, 5)}–{mensalista.fim.slice(0, 5)}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mensalista.nome || "Horário fixo semanal"}. Edite em{" "}
            <Link
              to="/gestor/quadra/$courtId"
              params={{ courtId }}
              className="font-semibold text-primary"
            >
              Horários e preços
            </Link>
            .
          </p>
        </section>
      )}

      {!ativas.length && !mensalista && (
        <section className="rounded-2xl bg-card p-5 shadow-card">
          {bloqueios.length ? (
            <>
              <h2 className="font-bold">Ocupado por fora do app</h2>
              {bloqueios.map((bl) => (
                <p key={bl.id} className="mt-1 text-sm text-muted-foreground">
                  {fmtTime(bl.starts_at)}–{fmtTime(bl.ends_at)}
                  {bl.nota && ` · ${bl.nota}`}
                </p>
              ))}
              {!past && (
                <Button
                  className="mt-4"
                  variant="outline"
                  disabled={rpc.isPending}
                  onClick={() => rpc.mutate({ kind: "block", bloquear: false })}
                >
                  <Unlock /> Liberar esta hora{fila.length > 0 && " e avisar a fila"}
                </Button>
              )}
            </>
          ) : (
            <>
              <h2 className="font-bold">{past ? "Horário passou sem reserva" : "Livre"}</h2>
              {!past && (
                <div className="mt-3 flex gap-2">
                  <Input
                    placeholder="Anotação (ex.: Pelada do João)"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <Button
                    disabled={rpc.isPending}
                    onClick={() => rpc.mutate({ kind: "block", bloquear: true })}
                  >
                    <Lock /> Marcar ocupado
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section>
        <h2 className="text-lg font-bold">Fila de espera ({fila.length})</h2>
        {fila.length ? (
          <ol className="mt-3 divide-y rounded-xl bg-card shadow-card">
            {fila.map((w, i) => (
              <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                <span className="font-display text-sm font-bold text-muted-foreground">
                  {i + 1}º
                </span>
                <div className="flex-1">
                  <PersonRow p={profiles.get(w.organizer_id)} compact />
                  <p className="text-xs text-muted-foreground">
                    Quer {fmtTime(w.starts_at)}–{fmtTime(w.ends_at)} · entrou{" "}
                    {fmtDateTime(w.created_at)}
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

      {historico.length > 0 && (
        <section>
          <h2 className="text-lg font-bold">Histórico</h2>
          <ul className="mt-3 divide-y rounded-xl bg-card shadow-card">
            {historico.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>
                  {profiles.get(b.organizer_id)?.name || "Organizador"}
                  <span className="text-muted-foreground">
                    {" "}
                    · {fmtTime(b.starts_at)}–{fmtTime(b.ends_at)} · pedido{" "}
                    {fmtDateTime(b.created_at)}
                  </span>
                </span>
                <StatusPill className={STATUS_CLASS[b.status]}>{STATUS_LABEL[b.status]}</StatusPill>
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
