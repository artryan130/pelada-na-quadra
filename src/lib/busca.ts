import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Modalidade = Database["public"]["Enums"]["modalidade"];
export type Resultado = Database["public"]["Functions"]["buscar_quadras"]["Returns"][number];

export const DURACOES = [
  { min: 60, label: "1h" },
  { min: 90, label: "1h30" },
  { min: 120, label: "2h" },
] as const;
export const MODALIDADES: { id: Modalidade; label: string }[] = [
  { id: "society", label: "Society" },
  { id: "futsal", label: "Futsal" },
];
export const RAIOS_KM = [3, 5, 10, 20] as const;

/** "06:00" … "23:30", in 30-minute steps. */
export const HORAS = Array.from({ length: 36 }, (_, i) => {
  const m = 6 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 ? "30" : "00"}`;
});

export function fmtDuracao(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export function fmtKm(km: number | null): string | null {
  if (km === null) return null;
  return km < 1
    ? `${Math.round(km * 1000)} m`
    : `${km.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

/** Case- and accent-insensitive key for matching bairro names. */
export function chaveBairro(nome: string): string {
  return nome.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export type Bairro = { nome: string; lat: number; lng: number };

export function useBairros() {
  return useQuery({
    queryKey: ["bairros-bh"],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bairros_bh")
        .select("nome, lat, lng")
        .order("nome");
      if (error) throw error;
      return data as Bairro[];
    },
  });
}

export function acharBairro(bairros: Bairro[], nome: string): Bairro | undefined {
  const k = chaveBairro(nome);
  return k ? bairros.find((b) => chaveBairro(b.nome) === k) : undefined;
}

export function posicaoAtual(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator))
      return reject(new Error("Seu navegador não informa a localização."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) =>
        reject(
          new Error(
            e.code === e.PERMISSION_DENIED
              ? "Permita o acesso à localização ou digite seu bairro."
              : "Não deu para pegar sua localização. Digite seu bairro.",
          ),
        ),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  });
}

// OpenStreetMap's free geocoder. Only venue addresses are sent, never player data.
// Usage policy: at most 1 request/second, which a "Localizar" button respects.
export async function geocodificarEndereco(endereco: string, bairro: string) {
  const q = [endereco, bairro, "Belo Horizonte", "MG", "Brasil"].filter(Boolean).join(", ");
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "Accept-Language": "pt-BR" } });
  if (!res.ok) throw new Error("Serviço de mapas indisponível. Tente de novo em instantes.");
  const [hit] = (await res.json()) as { lat: string; lon: string }[];
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
}
