import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { brl, errMsg } from "@/lib/time";
import { EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/gestor/quadra/$courtId")({
  head: () => ({ meta: [{ title: "Horários e preços · Gestor" }] }),
  component: CourtSchedule,
});

// Monday first, as people read a week in Brazil; values follow Postgres dow (0 = domingo).
const DIAS = [
  { dow: 1, curto: "Seg", nome: "Segunda" },
  { dow: 2, curto: "Ter", nome: "Terça" },
  { dow: 3, curto: "Qua", nome: "Quarta" },
  { dow: 4, curto: "Qui", nome: "Quinta" },
  { dow: 5, curto: "Sex", nome: "Sexta" },
  { dow: 6, curto: "Sáb", nome: "Sábado" },
  { dow: 0, curto: "Dom", nome: "Domingo" },
];
const NOME_DIA = Object.fromEntries(DIAS.map((d) => [d.dow, d.curto]));

/** "00:00" … "24:00" in 30-minute steps. */
const HORARIOS = Array.from({ length: 49 }, (_, i) => {
  const m = i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 ? "30" : "00"}`;
});
const hhmm = (t: string) => t.slice(0, 5);
const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

type Dia = { aberto: boolean; abre: string; fecha: string };
type Faixa = { key: string; dias: number[]; inicio: string; fim: string; precoHora: number };

function CourtSchedule() {
  const { courtId } = Route.useParams();

  const { data, isLoading } = useQuery({
    queryKey: ["agenda-quadra", courtId],
    queryFn: async () => {
      const [court, horarios, precos, mensalistas, faltando] = await Promise.all([
        supabase.from("courts").select("id, name, venue_id").eq("id", courtId).maybeSingle(),
        supabase.from("horarios_funcionamento").select("*").eq("court_id", courtId).order("abre"),
        supabase.from("regras_preco").select("*").eq("court_id", courtId).order("inicio"),
        supabase
          .from("mensalistas")
          .select("*")
          .eq("court_id", courtId)
          .order("dia_semana")
          .order("inicio"),
        supabase
          .from("precos_faltando")
          .select("*")
          .eq("court_id", courtId)
          .order("visto_em", { ascending: false }),
      ]);
      for (const r of [court, horarios, precos, mensalistas, faltando]) if (r.error) throw r.error;
      return {
        court: court.data,
        horarios: horarios.data ?? [],
        precos: precos.data ?? [],
        mensalistas: mensalistas.data ?? [],
        faltando: faltando.data ?? [],
      };
    },
  });

  if (isLoading) return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  if (!data?.court) return <EmptyState title="Quadra não encontrada" />;

  return (
    <div className="space-y-8">
      <div>
        <Link
          to="/gestor/configuracao"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground"
        >
          <ArrowLeft className="size-4" /> Configuração
        </Link>
        <h1 className="mt-3 text-2xl font-black">{data.court.name}: horários e preços</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A busca dos organizadores usa exatamente estes dados, em blocos de 30 minutos.
        </p>
      </div>
      <Funcionamento courtId={courtId} rows={data.horarios} />
      <Precos
        courtId={courtId}
        rows={data.precos}
        horarios={data.horarios}
        faltando={data.faltando}
      />
      <Mensalistas courtId={courtId} rows={data.mensalistas} />
    </div>
  );
}

type HorarioRow = { dia_semana: number; abre: string; fecha: string };

function Funcionamento({ courtId, rows }: { courtId: string; rows: HorarioRow[] }) {
  const qc = useQueryClient();
  const inicial = useMemo(() => {
    const out: Record<number, Dia> = {};
    for (const d of DIAS) {
      const r = rows.find((x) => x.dia_semana === d.dow);
      out[d.dow] = r
        ? { aberto: true, abre: hhmm(r.abre), fecha: hhmm(r.fecha) }
        : { aberto: false, abre: "08:00", fecha: "23:00" };
    }
    return out;
  }, [rows]);
  const [dias, setDias] = useState(inicial);
  useEffect(() => setDias(inicial), [inicial]);
  const varias = DIAS.some((d) => rows.filter((r) => r.dia_semana === d.dow).length > 1);

  const salvar = useMutation({
    mutationFn: async () => {
      for (const d of DIAS) {
        const x = dias[d.dow]!;
        if (x.aberto && min(x.abre) >= min(x.fecha))
          throw new Error(`${d.nome}: abre depois de fechar.`);
      }
      const del = await supabase.from("horarios_funcionamento").delete().eq("court_id", courtId);
      if (del.error) throw del.error;
      const novos = DIAS.filter((d) => dias[d.dow]!.aberto).map((d) => ({
        court_id: courtId,
        dia_semana: d.dow,
        abre: dias[d.dow]!.abre,
        fecha: dias[d.dow]!.fecha,
      }));
      if (novos.length) {
        const ins = await supabase.from("horarios_funcionamento").insert(novos);
        if (ins.error) throw ins.error;
      }
    },
    onSuccess: () => {
      toast.success("Horário de funcionamento salvo.");
      qc.invalidateQueries({ queryKey: ["agenda-quadra", courtId] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const copiarSegunda = () => {
    const seg = dias[1]!;
    setDias(Object.fromEntries(DIAS.map((d) => [d.dow, { ...seg }])));
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Funcionamento</h2>
        <Button variant="ghost" size="sm" onClick={copiarSegunda}>
          Copiar segunda para todos
        </Button>
      </div>
      {varias && (
        <p className="mt-1 text-xs text-warning-foreground">
          Algum dia tinha mais de um período; ao salvar, fica só o primeiro.
        </p>
      )}
      <ul className="mt-3 divide-y rounded-xl bg-card shadow-card">
        {DIAS.map((d) => {
          const x = dias[d.dow]!;
          const set = (patch: Partial<Dia>) => setDias({ ...dias, [d.dow]: { ...x, ...patch } });
          return (
            <li key={d.dow} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-16 font-medium">{d.nome}</span>
              <Switch
                checked={x.aberto}
                onCheckedChange={(v) => set({ aberto: v })}
                aria-label={`${d.nome} aberto`}
              />
              {x.aberto ? (
                <div className="flex items-center gap-2 text-sm">
                  <HoraSelect
                    value={x.abre}
                    onChange={(v) => set({ abre: v })}
                    opcoes={HORARIOS.slice(0, -1)}
                  />
                  às
                  <HoraSelect
                    value={x.fecha}
                    onChange={(v) => set({ fecha: v })}
                    opcoes={HORARIOS.slice(1)}
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Fechado</span>
              )}
            </li>
          );
        })}
      </ul>
      <Button className="mt-3" onClick={() => salvar.mutate()} disabled={salvar.isPending}>
        {salvar.isPending && <Loader2 className="animate-spin" />} Salvar funcionamento
      </Button>
    </section>
  );
}

type PrecoRow = { dia_semana: number; inicio: string; fim: string; preco_bloco: number };

function agrupar(rows: PrecoRow[]): Faixa[] {
  const map = new Map<string, Faixa>();
  for (const r of rows) {
    const k = `${hhmm(r.inicio)}|${hhmm(r.fim)}|${r.preco_bloco}`;
    const f = map.get(k) ?? {
      key: k,
      dias: [],
      inicio: hhmm(r.inicio),
      fim: hhmm(r.fim),
      precoHora: Number(r.preco_bloco) * 2,
    };
    f.dias.push(r.dia_semana);
    map.set(k, f);
  }
  return [...map.values()];
}

function Precos({
  courtId,
  rows,
  horarios,
  faltando,
}: {
  courtId: string;
  rows: PrecoRow[];
  horarios: HorarioRow[];
  faltando: { dia_semana: number; bloco: string; vezes: number }[];
}) {
  const qc = useQueryClient();
  const inicial = useMemo(() => agrupar(rows), [rows]);
  const [faixas, setFaixas] = useState(inicial);
  useEffect(() => setFaixas(inicial), [inicial]);

  // Open blocks no band covers: the search would hide the court there.
  const descobertos = useMemo(() => {
    const out: string[] = [];
    for (const d of DIAS) {
      for (const h of horarios.filter((x) => x.dia_semana === d.dow)) {
        for (let m = min(h.abre); m + 30 <= min(h.fecha); m += 30) {
          const coberto = faixas.some(
            (f) => f.dias.includes(d.dow) && min(f.inicio) <= m && m + 30 <= min(f.fim),
          );
          if (!coberto) out.push(`${d.curto} ${HORARIOS[m / 30]}`);
        }
      }
    }
    return out;
  }, [faixas, horarios]);

  const salvar = useMutation({
    mutationFn: async () => {
      for (const f of faixas) {
        if (!f.dias.length) throw new Error("Escolha ao menos um dia em cada faixa.");
        if (min(f.inicio) >= min(f.fim)) throw new Error("Uma faixa termina antes de começar.");
        if (!(f.precoHora >= 0)) throw new Error("Preço inválido.");
      }
      const del = await supabase.from("regras_preco").delete().eq("court_id", courtId);
      if (del.error) throw del.error;
      const novos = faixas.flatMap((f) =>
        f.dias.map((dow) => ({
          court_id: courtId,
          dia_semana: dow,
          inicio: f.inicio,
          fim: f.fim,
          preco_bloco: Math.round((f.precoHora / 2) * 100) / 100,
        })),
      );
      if (novos.length) {
        const ins = await supabase.from("regras_preco").insert(novos);
        if (ins.error) throw ins.error;
      }
    },
    onSuccess: () => {
      toast.success("Preços salvos.");
      qc.invalidateQueries({ queryKey: ["agenda-quadra", courtId] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const atualizar = (key: string, patch: Partial<Faixa>) =>
    setFaixas(faixas.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Preços</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setFaixas([
              ...faixas,
              {
                key: crypto.randomUUID(),
                dias: DIAS.map((d) => d.dow),
                inicio: "18:00",
                fim: "24:00",
                precoHora: faixas[0]?.precoHora ?? 0,
              },
            ])
          }
        >
          <Plus /> Faixa
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Ex.: R$ 180/h o dia todo e uma faixa de R$ 220/h das 18h às 24h em dias de semana. Quando
        faixas se sobrepõem, vale a mais curta.
      </p>

      <ul className="mt-3 space-y-3">
        {faixas.map((f) => (
          <li key={f.key} className="rounded-xl bg-card p-4 shadow-card">
            <div className="flex flex-wrap gap-1.5">
              {DIAS.map((d) => {
                const on = f.dias.includes(d.dow);
                return (
                  <button
                    key={d.dow}
                    type="button"
                    onClick={() =>
                      atualizar(f.key, {
                        dias: on ? f.dias.filter((x) => x !== d.dow) : [...f.dias, d.dow],
                      })
                    }
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs font-medium",
                      on && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {d.curto}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <HoraSelect
                value={f.inicio}
                onChange={(v) => atualizar(f.key, { inicio: v })}
                opcoes={HORARIOS.slice(0, -1)}
              />
              às
              <HoraSelect
                value={f.fim}
                onChange={(v) => atualizar(f.key, { fim: v })}
                opcoes={HORARIOS.slice(1)}
              />
              <div className="flex items-center gap-1">
                R$
                <Input
                  className="h-9 w-24"
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={String(f.precoHora)}
                  onChange={(e) => atualizar(f.key, { precoHora: Number(e.target.value) })}
                />
                /hora
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remover faixa"
                onClick={() => setFaixas(faixas.filter((x) => x.key !== f.key))}
              >
                <Trash2 />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {descobertos.length > 0 && (
        <p className="mt-3 flex gap-2 rounded-xl bg-warning/20 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Sem preço em {descobertos.length} bloco{descobertos.length > 1 ? "s" : ""} de horário
            aberto ({descobertos.slice(0, 4).join(", ")}
            {descobertos.length > 4 ? "…" : ""}). Nesses horários a quadra não aparece na busca.
          </span>
        </p>
      )}
      {faltando.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Buscas recentes caíram em horário sem preço:{" "}
          {faltando
            .slice(0, 5)
            .map((x) => `${NOME_DIA[x.dia_semana]} ${hhmm(x.bloco)}`)
            .join(", ")}
          .
        </p>
      )}
      <Button className="mt-3" onClick={() => salvar.mutate()} disabled={salvar.isPending}>
        {salvar.isPending && <Loader2 className="animate-spin" />} Salvar preços
      </Button>
      {faixas[0] && (
        <p className="mt-2 text-xs text-muted-foreground">
          1h30 na primeira faixa: {brl(faixas[0].precoHora * 1.5)}
        </p>
      )}
    </section>
  );
}

type MensalistaRow = {
  id: string;
  dia_semana: number;
  inicio: string;
  fim: string;
  nome: string;
  valido_ate: string | null;
};

function Mensalistas({ courtId, rows }: { courtId: string; rows: MensalistaRow[] }) {
  const qc = useQueryClient();
  const [novo, setNovo] = useState({ dia: 1, inicio: "20:00", fim: "21:00", nome: "", ate: "" });
  const invalidar = () => qc.invalidateQueries({ queryKey: ["agenda-quadra", courtId] });

  const adicionar = useMutation({
    mutationFn: async () => {
      if (min(novo.inicio) >= min(novo.fim)) throw new Error("O horário termina antes de começar.");
      const { error } = await supabase.from("mensalistas").insert({
        court_id: courtId,
        dia_semana: novo.dia,
        inicio: novo.inicio,
        fim: novo.fim,
        nome: novo.nome.trim(),
        valido_ate: novo.ate || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Mensalista adicionado. Esse horário sai da busca toda semana.");
      setNovo({ ...novo, nome: "", ate: "" });
      invalidar();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const remover = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("mensalistas").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidar,
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <section>
      <h2 className="text-lg font-bold">Mensalistas</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Horário fixo toda semana. Ele nunca aparece livre na busca.
      </p>
      {rows.length > 0 && (
        <ul className="mt-3 divide-y rounded-xl bg-card shadow-card">
          {rows.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span>
                <strong>{NOME_DIA[m.dia_semana]}</strong> {hhmm(m.inicio)}–{hhmm(m.fim)}
                {m.nome && ` · ${m.nome}`}
                {m.valido_ate && (
                  <span className="text-muted-foreground">
                    {" "}
                    · até {new Date(m.valido_ate + "T12:00:00Z").toLocaleDateString("pt-BR")}
                  </span>
                )}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remover mensalista"
                disabled={remover.isPending}
                onClick={() => remover.mutate(m.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-3 text-sm">
        <Select
          value={String(novo.dia)}
          onValueChange={(v) => setNovo({ ...novo, dia: Number(v) })}
        >
          <SelectTrigger className="h-9 w-28" aria-label="Dia">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIAS.map((d) => (
              <SelectItem key={d.dow} value={String(d.dow)}>
                {d.nome}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <HoraSelect
          value={novo.inicio}
          onChange={(v) => setNovo({ ...novo, inicio: v })}
          opcoes={HORARIOS.slice(0, -1)}
        />
        às
        <HoraSelect
          value={novo.fim}
          onChange={(v) => setNovo({ ...novo, fim: v })}
          opcoes={HORARIOS.slice(1)}
        />
        <Input
          className="h-9 w-40"
          placeholder="Nome (opcional)"
          value={novo.nome}
          onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
        />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          até
          <Input
            className="h-9 w-36"
            type="date"
            value={novo.ate}
            onChange={(e) => setNovo({ ...novo, ate: e.target.value })}
          />
        </label>
        <Button size="sm" onClick={() => adicionar.mutate()} disabled={adicionar.isPending}>
          <Plus /> Adicionar
        </Button>
      </div>
    </section>
  );
}

function HoraSelect({
  value,
  onChange,
  opcoes,
}: {
  value: string;
  onChange: (v: string) => void;
  opcoes: string[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {opcoes.map((h) => (
          <SelectItem key={h} value={h}>
            {h}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
