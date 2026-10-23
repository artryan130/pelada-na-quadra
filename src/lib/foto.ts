import { supabase } from "@/integrations/supabase/client";

const BUCKET = "quadras";
const LADO_MAX = 1600;

/** Shrinks phone photos (often 4–10 MB) to a JPEG of at most 1600px before upload. */
export async function reduzirImagem(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * escala);
    canvas.height = Math.round(bmp.height * escala);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

/** Path inside the bucket for a public URL of ours, or null for any other URL. */
function caminhoDaUrl(url: string | null): string | null {
  const marca = `/storage/v1/object/public/${BUCKET}/`;
  const i = url?.indexOf(marca) ?? -1;
  return url && i >= 0 ? decodeURIComponent(url.slice(i + marca.length)) : null;
}

/** Uploads a new court photo and returns its public URL; the old file is removed. */
export async function enviarFotoQuadra(
  court: { id: string; venue_id: string; photo_url: string | null },
  file: File,
): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Escolha um arquivo de imagem.");
  const blob = await reduzirImagem(file);
  if (blob.size > 5 * 1024 * 1024) throw new Error("A foto passou de 5 MB. Tente outra.");
  const tipo = blob.type || file.type;
  const ext = tipo === "image/png" ? "png" : tipo === "image/webp" ? "webp" : "jpg";
  // Venue folder first: the storage policy checks it against the gestor's venues.
  const caminho = `${court.venue_id}/${court.id}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(caminho, blob, { contentType: tipo, cacheControl: "31536000", upsert: false });
  if (error) throw error;
  const url = supabase.storage.from(BUCKET).getPublicUrl(caminho).data.publicUrl;
  const upd = await supabase.from("courts").update({ photo_url: url }).eq("id", court.id);
  if (upd.error) throw upd.error;
  await removerArquivo(court.photo_url);
  return url;
}

export async function removerFotoQuadra(court: { id: string; photo_url: string | null }) {
  const { error } = await supabase.from("courts").update({ photo_url: null }).eq("id", court.id);
  if (error) throw error;
  await removerArquivo(court.photo_url);
}

// Best effort: a leftover file only costs storage, so failures here are ignored.
async function removerArquivo(url: string | null) {
  const caminho = caminhoDaUrl(url);
  if (caminho) await supabase.storage.from(BUCKET).remove([caminho]);
}
