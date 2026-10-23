import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, LocateFixed, MapPin } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  DURACOES,
  HORAS,
  MODALIDADES,
  RAIOS_KM,
  acharBairro,
  fmtKm,
  posicaoAtual,
  useBairros,
  type Modalidade,
  type Resultado,
} from "@/lib/busca";
import { addDays, brl, errMsg, fmtDay, fmtTime, todayBRT } from "@/lib/time";
import { EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Busca = {
  data?: string;
  hora?: string;
  duracao?: number;
  modalidade?: Modalidade;
  bairro?: string;
  lat?: number;
  lng?: number;
  raio?: number;
  ordem?: "distancia" | "preco";
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

// Search state lives in the URL, so coming back from a court keeps the same search.
export const Route = createFileRoute("/_org/buscar")({
  validateSearch: (s: Record<string, unknown>): Busca => {
    const out: Busca = {};
    const data = str(s["data"]);
    if (data && /^\d{4}-\d{2}-\d{2}$/.test(data)) out.data = data;
    const hora = str(s["hora"]);
    if (hora && HORAS.includes(hora)) out.hora = hora;
    const duracao = num(s["duracao"]);
    if (duracao && DURACOES.some((d) => d.min === duracao)) out.duracao = duracao;
    const modalidade = str(s["modalidade"]);
    if (modalidade === "futsal" || modalidade === "society") out.modalidade = modalidade;
    const bairro = str(s["bairro"]);
    if (bairro) out.bairro = bairro;
    const lat = num(s["lat"]);
    const lng = num(s["lng"]);
    if (lat !== undefined && lng !== undefined) Object.assign(out, { lat, lng });
    const raio = num(s["raio"]);
    if (raio && RAIOS_KM.includes(raio as (typeof RAIOS_KM)[number])) out.raio = raio;
    if (s["ordem"] === "preco") out.ordem = "preco";
    return out;
  },
  head: () => ({ meta: [{ title: "Buscar horário · Bate-Bola" }] }),
  component: BuscarPage,
});

/** Next half hour at least 30 min from now (Brasília), or 20:00 for other days. */
function horaPadrao(data: string): string {
  if (data !== todayBRT()) return "20:00";
  const agora = new Date(Date.now() - 3 * 3600_000);
  const m = agora.getUTCHours() * 60 + agora.getUTCMinutes() + 30;
  const prox = HORAS.find((h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3)) >= m);
  return prox && prox < "20:00" ? "20:00" : (prox ?? "23:30");
}

function BuscarPage() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: "/buscar" });
  const today = todayBRT();
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(today, i)), [today]);
  const { data: bairros = [] } = useBairros();
  const [bairroTexto, setBairroTexto] = useState(s.bairro ?? "");
  const [localizando, setLocalizando] = useState(false);

  const data = s.data && s.data >= today ? s.data : today;
  const hora = s.hora ?? horaPadrao(data);
  const duracao = s.duracao ?? 60;
  const modalidade = s.modalidade ?? "society";
  const raio = s.raio ?? 10;
  const ordem = s.ordem ?? "distancia";
  const bairro = s.bairro ? acharBairro(bairros, s.bairro) : undefined;
  const origem = s.lat !== undefined && s.lng !== undefined ? { lat: s.lat, lng: s.lng } : bairro;

  const set = (patch: Partial<Busca>) =>
    navigate({ search: (prev: Busca) => ({ ...prev, ...patch }), replace: true });

  const usarGps = async () => {
    setLocalizando(true);
    try {
      const p = await posicaoAtual();
      setBairroTexto("");
      navigate({
        search: ({ bairro: _b, ...prev }: Busca) => ({ ...prev, lat: p.lat, lng: p.lng }),
        replace: true,
      });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLocalizando(false);
    }
  };

  const escolherBairro = (nome: string) => {
    setBairroTexto(nome);
    const b = acharBairro(bairros, nome);
    if (b)
      navigate({
        search: ({ lat: _a, lng: _o, ...prev }: Busca) => ({ ...prev, bairro: b.nome }),
        replace: true,
      });
  };

  const {
    data: resultados,
    isFetching,
    error,
  } = useQuery({
    queryKey: ["busca", data, hora, duracao, modalidade, origem?.lat, origem?.lng, raio, ordem],
    queryFn: async () => {
      const { data: rows, error } = await supabase.rpc("buscar_quadras", {
        _data: data,
        _hora: hora,
        _duracao_min: duracao,
        _modalidade: modalidade,
        _raio_km: raio,
        _ordem: ordem,
        ...(origem ? { _lat: origem.lat, _lng: origem.lng } : {}),
      });
      if (error) throw error;
      return rows;
    },
  });

  const exatos = (resultados ?? []).filter((r) => r.exato);
  const proximos = (resultados ?? []).filter((r) => !r.exato);

  return (
    <div>
      <h1 className="text-2xl font-black">Quando você quer jogar?</h1>

      <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {days.map((d) => (
          <button
            key={d}
            onClick={() => set({ data: d })}
            className={cn(
              "flex min-w-14 flex-col items-center rounded-xl border bg-card px-2 py-2 text-xs transition-colors",
              d === data && "border-primary bg-primary text-primary-foreground",
            )}
          >
            <span className="capitalize opacity-80">
              {d === today ? "hoje" : fmtDay(d, { weekday: "short" }).replace(".", "")}
            </span>
            <span className="font-display text-lg font-bold">{fmtDay(d, { day: "2-digit" })}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Select value={hora} onValueChange={(v) => set({ hora: v })}>
          <SelectTrigger className="bg-card" aria-label="Horário de início">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HORAS.map((h) => (
              <SelectItem key={h} value={h}>
                {h}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Segmented
          value={duracao}
          options={DURACOES.map((d) => ({ value: d.min, label: d.label }))}
          onChange={(v) => set({ duracao: v })}
        />
        <Segmented
          value={modalidade}
          options={MODALIDADES.map((m) => ({ value: m.id, label: m.label }))}
          onChange={(v) => set({ modalidade: v })}
        />
        <Segmented
          value={ordem}
          options={[
            { value: "distancia" as const, label: "Mais perto" },
            { value: "preco" as const, label: "Menor preço" },
          ]}
          onChange={(v) => set({ ordem: v })}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant={s.lat !== undefined ? "default" : "outline"}
          size="sm"
          onClick={usarGps}
          disabled={localizando}
        >
          {localizando ? <Loader2 className="animate-spin" /> : <LocateFixed />} Perto de mim
        </Button>
        <div className="relative min-w-40 flex-1">
          <MapPin className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="h-9 bg-card pl-8"
            placeholder="ou digite seu bairro"
            list="bairros-bh"
            value={bairroTexto}
            onChange={(e) => escolherBairro(e.target.value)}
          />
          <datalist id="bairros-bh">
            {bairros.map((b) => (
              <option key={b.nome} value={b.nome} />
            ))}
          </datalist>
        </div>
        <Select
          value={String(raio)}
          onValueChange={(v) => set({ raio: Number(v) })}
          disabled={!origem}
        >
          <SelectTrigger className="h-9 w-28 bg-card" aria-label="Raio">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RAIOS_KM.map((r) => (
              <SelectItem key={r} value={String(r)}>
                até {r} km
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {s.lat !== undefined
          ? "Usando sua localização atual."
          : bairro
            ? `Perto de ${bairro.nome}.`
            : "Sem localização: mostrando quadras de toda BH."}
      </p>

      <div className="mt-5">
        {isFetching && !resultados ? (
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
        ) : error ? (
          <EmptyState title="Não deu para buscar">{errMsg(error)}</EmptyState>
        ) : exatos.length ? (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {exatos.length} quadra{exatos.length > 1 ? "s" : ""} com {hora} livre
            </p>
            <Lista itens={exatos} duracao={duracao} hora={hora} />
          </>
        ) : proximos.length ? (
          <>
            <EmptyState title={`Nenhuma quadra com ${hora} livre`}>
              Mas tem horário perto disso no mesmo dia:
            </EmptyState>
            <h2 className="mb-3 mt-6 text-lg font-bold">Horários próximos</h2>
            <Lista itens={proximos} duracao={duracao} hora={hora} />
          </>
        ) : (
          <EmptyState title="Nenhuma quadra livre nesse horário">
            Tente outro dia, outro horário{origem ? " ou aumente o raio" : ""}.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded-md px-2 py-1.5 text-xs font-medium",
            value === o.value && "bg-secondary text-secondary-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Lista({ itens, duracao, hora }: { itens: Resultado[]; duracao: number; hora: string }) {
  return (
    <ul className="space-y-3">
      {itens.map((r) => {
        const km = fmtKm(r.distancia_km);
        return (
          <li key={r.court_id + r.inicio}>
            <Link
              to="/quadra/$courtId"
              params={{ courtId: r.court_id }}
              search={{ inicio: r.inicio, duracao }}
              className="flex gap-3 overflow-hidden rounded-xl bg-card shadow-card transition-shadow hover:ring-1 hover:ring-primary"
            >
              <div className="w-24 shrink-0 bg-muted">
                {r.photo_url ? (
                  <img src={r.photo_url} alt="" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center bg-pitch-gradient font-display text-xs font-bold uppercase text-pitch-foreground/80">
                    {r.modalidade}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 py-3 pr-3">
                <p className="truncate font-display font-bold">{r.venue_name}</p>
                <p className="truncate text-sm">
                  {r.court_name} · <span className="capitalize">{r.modalidade}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {[r.neighborhood, km].filter(Boolean).join(" · ")}
                </p>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="font-display text-sm font-bold tabular-nums">
                    {fmtTime(r.inicio)}–{fmtTime(r.fim)}
                    {!r.exato && (
                      <span className="ml-1.5 text-xs font-medium text-muted-foreground">
                        ({r.diferenca_min} min {fmtTime(r.inicio) < hora ? "antes" : "depois"})
                      </span>
                    )}
                  </span>
                  <span className="font-display text-lg font-black text-primary">
                    {brl(Number(r.preco_total))}
                  </span>
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
