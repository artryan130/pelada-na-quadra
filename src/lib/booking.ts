import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useAuth } from "@/lib/auth";

export type BookingStatus = Database["public"]["Enums"]["booking_status"];
export type Venue = Database["public"]["Tables"]["venues"]["Row"];
export type Court = Database["public"]["Tables"]["courts"]["Row"];

export const STATUS_LABEL: Record<BookingStatus, string> = {
  pendente: "Aguardando pagamento",
  confirmada: "Confirmada",
  recusada: "Recusada",
  expirada: "Expirada",
  cancelada: "Cancelada",
};

export const STATUS_CLASS: Record<BookingStatus, string> = {
  pendente: "bg-warning text-warning-foreground",
  confirmada: "bg-success text-success-foreground",
  recusada: "bg-destructive/10 text-destructive",
  expirada: "bg-muted text-muted-foreground",
  cancelada: "bg-muted text-muted-foreground",
};

// The venue the signed-in gestor manages (null when they haven't created one yet).
export function useMyVenue() {
  const { session } = useAuth();
  const uid = session?.user.id;
  return useQuery({
    queryKey: ["venue", uid],
    enabled: !!uid,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("venue_managers")
        .select("venues(*)")
        .eq("user_id", uid!)
        .order("created_at")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.venues ?? null;
    },
  });
}

export function useVenues() {
  return useQuery({
    queryKey: ["venues"],
    queryFn: async () => {
      const { data, error } = await supabase.from("venues").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useCourts({
  venueId,
  includeInactive = false,
}: { venueId?: string; includeInactive?: boolean } = {}) {
  return useQuery({
    queryKey: ["courts", venueId ?? "all", includeInactive],
    queryFn: async () => {
      let q = supabase.from("courts").select("*").order("name");
      if (venueId) q = q.eq("venue_id", venueId);
      if (!includeInactive) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

// wa.me needs digits only, with country code; Brazilian numbers usually come without it.
export function whatsappLink(phone: string, text?: string): string | null {
  let d = phone.replace(/\D/g, "");
  if (!d) return null;
  if (d.length <= 11) d = "55" + d;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export type Profile = { id: string; name: string; phone: string; email: string };

// bookings/waitlist have no FK to profiles, so organizer data is fetched separately.
export async function fetchProfiles(ids: string[]): Promise<Map<string, Profile>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, phone, email")
    .in("id", unique);
  if (error) throw error;
  return new Map(data.map((p) => [p.id, p]));
}
