import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CalendarClock, Loader2, LocateFixed, Plus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCourts, useMyVenue, type Court, type Venue } from "@/lib/booking";
import { errMsg } from "@/lib/time";
import { formatCnpj, isValidCnpj, normalizeCnpj } from "@/lib/cnpj";
import {
  MODALIDADES,
  acharBairro,
  geocodificarEndereco,
  useBairros,
  type Modalidade,
} from "@/lib/busca";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/gestor/configuracao")({
  head: () => ({ meta: [{ title: "Configuração · Gestor" }] }),
  component: Settings,
});

function Settings() {
  const { data: venue, isLoading } = useMyVenue();
  const { data: courts = [] } = useCourts(
    venue ? { venueId: venue.id, includeInactive: true } : { includeInactive: true },
  );
  const qc = useQueryClient();

  const addCourt = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("courts").insert({
        venue_id: venue!.id,
        name: `Quadra ${courts.length + 1}`,
        price_per_hour: courts[0]?.price_per_hour ?? 0,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["courts"] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading) return <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />;
  if (!venue) return <CreateVenue />;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-black">Configuração</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Feito uma vez. Os organizadores veem esses dados ao reservar.
        </p>
        <VenueForm venue={venue} />
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Quadras</h2>
          <Button
            variant="outline"
            size="sm"
            disabled={addCourt.isPending}
            onClick={() => addCourt.mutate()}
          >
            <Plus /> Adicionar
          </Button>
        </div>
        <div className="mt-3 space-y-3">
          {courts.length === 0 && (
            <p className="rounded-xl border border-dashed bg-card p-4 text-sm text-muted-foreground">
              Nenhuma quadra ainda. Toque em <strong>Adicionar</strong> para cadastrar a primeira e
              depois gere os horários na Agenda.
            </p>
          )}
          {courts.map((c) => (
            <CourtForm key={c.id} court={c} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CreateVenue() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const create = useMutation({
    mutationFn: async (e: FormEvent) => {
      e.preventDefault();
      if (!isValidCnpj(cnpj)) throw new Error("CNPJ inválido. Confira os números.");
      const { error } = await supabase.rpc("create_my_venue", { _name: name, _cnpj: cnpj });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["venue"] }),
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <form onSubmit={(e) => create.mutate(e)} className="rounded-2xl bg-card p-5 shadow-card">
      <h1 className="text-2xl font-black">Cadastre seu local</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Depois você completa endereço, Pix e quadras.
      </p>
      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input
          required
          placeholder="Ex.: Arena Pampulha"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          required
          autoCapitalize="characters"
          placeholder="CNPJ"
          value={cnpj}
          onChange={(e) => setCnpj(formatCnpj(e.target.value))}
        />
        <Button type="submit" disabled={create.isPending}>
          Criar
        </Button>
      </div>
    </form>
  );
}

function VenueForm({ venue }: { venue: Venue }) {
  const qc = useQueryClient();
  const [f, setF] = useState(venue);
  const [cnpj, setCnpj] = useState(formatCnpj(venue.cnpj ?? ""));
  const { data: bairros = [] } = useBairros();
  const [localizando, setLocalizando] = useState(false);
  useEffect(() => {
    setF(venue);
    setCnpj(formatCnpj(venue.cnpj ?? ""));
  }, [venue]);
  const str = (k: "name" | "address" | "neighborhood" | "pix_key" | "whatsapp") => ({
    value: f[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }),
  });
  const num = (
    k: "payment_deadline_hours" | "cancel_limit_hours" | "open_hour" | "close_hour",
  ) => ({
    type: "number",
    inputMode: "numeric" as const,
    value: String(f[k]),
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: Number(e.target.value) }),
  });

  const localizar = async () => {
    setLocalizando(true);
    try {
      const pos =
        (await geocodificarEndereco(f.address, f.neighborhood)) ??
        acharBairro(bairros, f.neighborhood);
      if (!pos) throw new Error("Não achamos esse endereço. Confira a rua e o bairro.");
      setF({ ...f, lat: pos.lat, lng: pos.lng });
      toast.success("Localização encontrada. Salve para confirmar.");
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLocalizando(false);
    }
  };

  const save = useMutation({
    mutationFn: async (e: FormEvent) => {
      e.preventDefault();
      // Without a pin, fall back to the bairro's center so the venue still shows up by distance.
      const centro = acharBairro(bairros, f.neighborhood);
      const lat = f.lat ?? centro?.lat ?? null;
      const lng = f.lng ?? centro?.lng ?? null;
      if (f.open_hour < 0 || f.close_hour > 24 || f.open_hour >= f.close_hour)
        throw new Error("Horário de funcionamento inválido.");
      if (f.payment_deadline_hours < 1)
        throw new Error("O prazo de pagamento precisa ser de pelo menos 1 hora.");
      if (!isValidCnpj(cnpj)) throw new Error("CNPJ inválido. Confira os números.");
      const { error } = await supabase
        .from("venues")
        .update({
          cnpj: normalizeCnpj(cnpj),
          name: f.name.trim(),
          address: f.address.trim(),
          neighborhood: f.neighborhood.trim(),
          pix_key: f.pix_key.trim(),
          whatsapp: f.whatsapp.trim(),
          payment_deadline_hours: f.payment_deadline_hours,
          cancel_limit_hours: f.cancel_limit_hours,
          open_hour: f.open_hour,
          close_hour: f.close_hour,
          antecedencia_min_minutos: Math.max(0, Math.round(f.antecedencia_min_minutos)),
          lat,
          lng,
        })
        .eq("id", venue.id);
      // 23505 = unique violation on venues_cnpj_unique.
      if (error?.code === "23505") throw new Error("Esse CNPJ já tem outro local cadastrado.");
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Dados do local salvos.");
      qc.invalidateQueries({ queryKey: ["venue"] });
      qc.invalidateQueries({ queryKey: ["venues"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <form
      onSubmit={(e) => save.mutate(e)}
      className="mt-4 grid gap-4 rounded-2xl bg-card p-5 shadow-card sm:grid-cols-2"
    >
      <div
        className={
          "flex items-start gap-2 rounded-xl p-3 text-sm sm:col-span-2 " +
          (venue.agenda_verificada ? "bg-success/10" : "bg-warning/20")
        }
      >
        <BadgeCheck className="mt-0.5 size-4 shrink-0" />
        {venue.agenda_verificada
          ? "Agenda verificada: suas quadras aparecem na busca por horário."
          : "Aguardando verificação da agenda pela equipe Bate-Bola. Até lá, suas quadras não aparecem na busca por horário."}
      </div>
      <F label="Nome do local">
        <Input required {...str("name")} />
      </F>
      <F
        label="CNPJ"
        hint={venue.cnpj ? undefined : "Obrigatório. Preencha para continuar recebendo reservas."}
      >
        <Input
          required
          autoCapitalize="characters"
          placeholder="00.000.000/0000-00"
          value={cnpj}
          onChange={(e) => setCnpj(formatCnpj(e.target.value))}
          aria-invalid={normalizeCnpj(cnpj).length === 14 && !isValidCnpj(cnpj)}
        />
      </F>
      <F label="Endereço">
        <Input placeholder="Rua, número" {...str("address")} />
      </F>
      <F label="Bairro (Belo Horizonte)" hint="Ajuda o organizador a achar a quadra mais perto.">
        <Input placeholder="Ex.: Pampulha" list="bairros-bh-gestor" {...str("neighborhood")} />
        <datalist id="bairros-bh-gestor">
          {bairros.map((b) => (
            <option key={b.nome} value={b.nome} />
          ))}
        </datalist>
      </F>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed p-3 text-sm sm:col-span-2">
        <span className={f.lat === null ? "text-muted-foreground" : ""}>
          {f.lat !== null && f.lng !== null
            ? `Localização no mapa: ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}`
            : "Sem localização no mapa: o organizador não vê a distância até você."}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={localizar}
          disabled={localizando}
        >
          {localizando ? <Loader2 className="animate-spin" /> : <LocateFixed />} Localizar pelo
          endereço
        </Button>
      </div>
      <F label="Chave Pix">
        <Input required {...str("pix_key")} />
      </F>
      <F label="WhatsApp da quadra">
        <Input type="tel" placeholder="(31) 91234-5678" {...str("whatsapp")} />
      </F>
      <F
        label="Abre às (hora)"
        hint="Padrão para quadras novas. Cada quadra tem seu horário por dia."
      >
        <Input min={0} max={23} {...num("open_hour")} />
      </F>
      <F label="Fecha às (hora)">
        <Input min={1} max={24} {...num("close_hour")} />
      </F>
      <F label="Prazo para pagar (horas)" hint="Depois disso a solicitação expira.">
        <Input min={1} max={48} {...num("payment_deadline_hours")} />
      </F>
      <F
        label="Cancelamento pelo organizador até (horas antes)"
        hint="Depois disso, só você cancela."
      >
        <Input min={0} max={168} {...num("cancel_limit_hours")} />
      </F>
      <F
        label="Antecedência mínima para reservar (horas)"
        hint="0 = pode reservar até a hora do jogo."
      >
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          max={72}
          value={String(f.antecedencia_min_minutos / 60)}
          onChange={(e) => setF({ ...f, antecedencia_min_minutos: Number(e.target.value) * 60 })}
        />
      </F>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} Salvar
        </Button>
      </div>
    </form>
  );
}

function CourtForm({ court }: { court: Court }) {
  const qc = useQueryClient();
  const [f, setF] = useState(court);
  useEffect(() => setF(court), [court]);
  const dirty =
    f.name !== court.name ||
    f.surface !== court.surface ||
    (f.photo_url ?? "") !== (court.photo_url ?? "") ||
    f.modalidade !== court.modalidade ||
    f.active !== court.active;

  const save = useMutation({
    mutationFn: async (next: Court) => {
      const { error } = await supabase
        .from("courts")
        .update({
          name: next.name.trim(),
          surface: next.surface.trim(),
          photo_url: next.photo_url?.trim() || null,
          modalidade: next.modalidade,
          active: next.active,
        })
        .eq("id", court.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${f.name} salva.`);
      qc.invalidateQueries({ queryKey: ["courts"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(f);
      }}
      className="flex gap-4 rounded-2xl bg-card p-4 shadow-card"
    >
      <div className="size-20 shrink-0 overflow-hidden rounded-lg bg-muted">
        {f.photo_url && <img src={f.photo_url} alt="" className="size-full object-cover" />}
      </div>
      <div className="grid flex-1 gap-3 sm:grid-cols-2">
        <F label="Nome">
          <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </F>
        <F label="Piso">
          <Input value={f.surface} onChange={(e) => setF({ ...f, surface: e.target.value })} />
        </F>
        <F label="Modalidade">
          <Select
            value={f.modalidade}
            onValueChange={(v) => setF({ ...f, modalidade: v as Modalidade })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODALIDADES.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </F>
        <F label="Link da foto">
          <Input
            type="url"
            placeholder="https://…"
            value={f.photo_url ?? ""}
            onChange={(e) => setF({ ...f, photo_url: e.target.value })}
          />
        </F>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={f.active} onCheckedChange={(v) => setF({ ...f, active: v })} />
            {f.active ? "Ativa" : "Inativa (some da agenda)"}
          </label>
          <div className="flex gap-2">
            <Button asChild type="button" variant="outline" size="sm">
              <Link to="/gestor/quadra/$courtId" params={{ courtId: court.id }}>
                <CalendarClock /> Horários e preços
              </Link>
            </Button>
            <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
              Salvar
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function F({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
